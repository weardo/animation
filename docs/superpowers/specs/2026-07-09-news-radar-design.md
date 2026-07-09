# News Radar — breaking-news tracker that feeds the reel pipeline

**Status:** design approved 2026-07-09 · Phase 1 spec
**Goal:** an always-on background service that continuously ingests fast-breaking news feeds, filters
the firehose down to a short ranked list of **India-relevant + globally-viral** opportunities, notifies
the operator, and — on one-click approval — hands a ready angle to the existing video pipeline. The point
is speed: surface a producible story minutes after it breaks (the ~15-30 min head-start the wire tier
gives over mainstream homepages), while keeping a human as the editorial gate.

---

## 1. Non-goals (YAGNI)

- **No autonomous publishing.** The radar never generates or publishes on its own. It *surfaces* ranked
  candidates; the operator approves before any compute is spent, and publishing stays the existing manual
  (unlisted → review → publish) step.
- **No AI on the fetch path.** Ingesting must never wait on `claude -p`. AI is used ONLY to score a small
  pre-filtered finalist set, on a separate loop.
- **No web-scraping of arbitrary news sites.** Only structured/official sources (free APIs, RSS/Atom).
  X/OSINT scraping is explicitly Phase 2 and best-effort behind an adapter that cannot break the core.
- **No new render/story machinery.** On approval the radar calls the EXISTING `orchestrateBrief` +
  studio job runner. It produces a *brief*, not frames.

## 2. Architecture — three decoupled loops + a local store

```
INGEST loop (no AI, continuous, ~every 3-5 min, per-source cadence)
  sources/gdelt · sources/rss · sources/newsdata · [sources/osint — Phase 2]
        │  fetch → normalize → dedupe (url + title-hash) → upsert RawItem
        ▼
   ┌───────────────────────────────────────────────┐
   │  store.ts  (SQLite: items · candidates · state) │
   └───────────────────────────────────────────────┘
        ▲
SCORE loop (periodic, ~every 5-10 min)
  funnel.ts   Stage 1 heuristic (no AI): recency · source weight · India/viral
              keyword+geo · GDELT tone/volume spike  → mark ~top 25 finalists
  judge.ts    Stage 2 claude -p (batched, finalists only): India-fit · virality ·
              producibility · 1-line why + suggested angle  → write Candidate rows
        │
        ▼
  notify.ts   fire when aiScore ≥ threshold  (Telegram default · desktop · studio-badge)
        │
        ▼
  STUDIO INBOX  ──approve──▶  orchestrateBrief(angle) → render UNLISTED draft → review + publish
```

The loops share nothing but the store; each reads/writes rows and runs on its own timer. A slow or failed
`claude -p`, a down feed, or a busy laptop degrades one loop without stalling ingest — no signal is lost.

## 3. Components

Each unit has one purpose, a narrow interface, and is testable in isolation. New code lives under
`radar/` (a top-level dir, sibling to `agents/` and `api/`, so it reuses `agents/claude.ts` and the
studio without entangling `src/`).

### 3.1 `radar/sources/*.ts` — feed adapters (no AI, no shared state)
One file per feed. Each exports `fetchItems(cfg): Promise<RawItem[]>`. Pure I/O: hit the feed, map to the
common `RawItem` shape, return. No dedupe, no scoring, no store access (the ingest loop owns those). A
throw is caught + logged by the caller; a broken adapter never affects the others.

- `gdelt.ts` — GDELT DOC 2.0 API (free, no key). Query India-relevance + viral lanes; read
  `sourcecountry`, `tone`, `socialimage`, `seendate`. Primary firehose + free geo/tone signal.
- `rss.ts` — generic RSS/Atom poller over a config list (Reuters, AP, BNO, ANI, WION, PIB, The Hindu, TOI,
  …). Parse XML → `{title, link, pubDate, source}`. Per-feed `etag`/`lastModified` stored to poll cheaply.
- `newsdata.ts` — NewsData.io `/latest` (free key, ~200 credits/day). `country=in` + category lanes; a
  daily-budget guard in config so it self-throttles (poll interval derived from the budget).
- `osint.ts` — **Phase 2, best-effort.** X list / Liveuamap adapter; returns `[]` (never throws) when no
  key/unavailable so the core is unaffected.

```ts
interface RawItem {
  url: string;               // canonical link (dedupe key #1)
  title: string;
  source: string;            // "reuters" | "gdelt" | "ani" | …
  seenAt: number;            // epoch ms we first saw it
  publishedAt?: number;      // epoch ms from the feed if present
  lang?: string;
  sourceCountry?: string;    // ISO (GDELT); used by the funnel
  tone?: number;             // GDELT tone; negative = conflict/crisis
  image?: string;            // socialimage/thumbnail if any
  summary?: string;
}
```

### 3.2 `radar/store.ts` — the only stateful unit (SQLite via better-sqlite3)
Tables:
- `items` — one row per deduped `RawItem` + funnel fields (`heuristicScore`, `reasons`, `stage`
  ∈ {new, finalist, judged, candidate, dismissed, built}).
- `candidates` — judged rows (`aiScore`, `whyIndia`, `angle`, `viralityNotes`, `notifiedAt`, `jobId?`).
- `state` — per-source cursors (etag/lastSeen), loop heartbeats.

Interface: `upsertItems(RawItem[])` (dedupe by url, else title-hash), `unscoredItems()`,
`markFinalists(ids)`, `writeCandidates(...)`, `shortlist(limit)`, `dismiss(id)`, `attachJob(id, jobId)`.
Dedupe + idempotency live here so every other unit stays pure. Content-hash = `sha256(canonicalUrl ||
normalizedTitle)`.

### 3.3 `radar/funnel.ts` — Stage-1 heuristic scorer (pure, no AI)
`score(item, lexicons, weights) → { score: number, reasons: string[], lane: 'india'|'viral'|null }`.
Deterministic; unit-tested with fixture items. Signals:
- **Recency** — exponential decay on `seenAt` (fresh wins; the viral window is the product).
- **Source weight** — wire/OSINT > aggregator > general (config table).
- **India lane** — match against Indic lexicons (India + states/cities, neighbors China/Pakistan/…,
  India orgs/leaders, "India"/"Bharat"), or GDELT `sourceCountry=IN`.
- **Viral lane** — global-viral markers (casualty counts, disaster/oddity verbs, "goes viral", large
  numbers), regardless of India — for reach.
- **Crisis signal** — GDELT negative `tone` + a volume spike (many sources on one event in a short window
  = breaking). Volume computed from the store (count of same-event items).
Items below a floor are dropped (logged as a count, never silently). The top N (config, ~25) by score
per cycle are marked `finalist`.

### 3.4 `radar/judge.ts` — Stage-2 AI judge (claude -p, keyless, batched)
`judge(finalists) → CandidateJudgment[]`. ONE `claude -p --output-format json` call per cycle over the
batched finalists (not per-item), keyless, no tools. Returns per item:
`{ id, aiScore 0-100, indiaFit 0-100, virality 0-100, producible: bool, whyIndia, angle, notes }`.
`angle` is a one-line brief the pipeline can consume directly. **Cached by item content-hash** under
`.cache/radar/judge/` (skip-if-exists) so re-runs/restarts cost nothing and results are stable. Any
`claude -p` failure → the finalist stays `finalist` (retried next cycle), never crashes the loop.

### 3.5 `radar/notify.ts` — pluggable notifier
`interface Notifier { send(c: Candidate): Promise<void> }`. Impls: `telegram` (default — reuses the
operator's existing openclaw bot token + chat_id; message = score, headline, why, source, an **Approve**
deep-link to the studio inbox), `desktop` (notify-send), `studioBadge` (just a UI counter, no push).
Config picks the channel. De-duped by candidate id + a per-candidate `notifiedAt` so no repeat pings.

### 3.6 `radar/radar.ts` — the background service (daemon)
Owns the two timers (ingest, score), a small supervisor (restart a loop that throws, backoff), a health
endpoint/heartbeat in `state`, and graceful shutdown (SIGTERM). Started as a long-running process
(`npm run radar`), optionally supervised by systemd/pm2 later. Single-instance guard (pid/lock) so two
copies don't double-poll. Config from `radar.config.json`.

### 3.7 Studio inbox (extends the existing studio, `api/` + `web/`)
A new **Radar** tab: the ranked candidate list (score, headline, why-India, source, age, thumbnail) with
per-row **Approve → build** and **Dismiss**. Approve calls the existing job runner:
`createJob({ brief: candidate.angle, language: 'Hinglish', … })` and links the resulting `jobId` back onto
the candidate row (so the inbox shows "building → draft ready → published"). No new render path — it's the
same pipeline the manual "Create" tab already uses.

## 4. Data flow (one item's life)

1. **Ingest:** an adapter returns a `RawItem`; the loop `upsertItems` it (deduped) → `stage=new`.
2. **Funnel:** score loop reads `unscoredItems`, computes heuristic score+lane, drops sub-floor items
   (counted), marks the top ~25 `finalist`.
3. **Judge:** batched `claude -p` scores finalists → `writeCandidates` (`stage=candidate`), cached.
4. **Notify:** candidates with `aiScore ≥ threshold` and no `notifiedAt` fire the notifier once.
5. **Approve:** operator clicks Approve in the studio inbox → `orchestrateBrief(angle)` job → unlisted
   draft → operator reviews + publishes. Candidate row tracks the job through to `built`.

Every stage is idempotent and keyed by content-hash, so a crash/restart resumes without dupes or lost work.

## 5. Configuration (`radar.config.json` — data, not code)

```jsonc
{
  "ingestIntervalSec": 240,
  "scoreIntervalSec": 420,
  "finalistCount": 25,
  "notifyThreshold": 78,
  "sources": {
    "gdelt":    { "enabled": true,  "queries": ["sourcecountry:IN", "India OR Bharat", "<viral lexicon>"] },
    "rss":      { "enabled": true,  "feeds": [ { "id": "reuters-world", "url": "…" }, { "id": "ani", "url": "…" } ] },
    "newsdata": { "enabled": true,  "dailyBudget": 200, "params": { "country": "in" } },
    "osint":    { "enabled": false }
  },
  "lexicons": { "india": ["…"], "viral": ["…"], "crisis": ["…"] },
  "weights":  { "recency": 1.0, "source": 0.8, "india": 1.2, "viral": 0.9, "crisisSpike": 1.1 },
  "sourceWeights": { "reuters": 1.0, "ap": 1.0, "bno": 0.95, "ani": 0.9, "wion": 0.8, "gdelt": 0.7, "newsdata": 0.7 },
  "notify":   { "channel": "telegram" }
}
```
Secrets (NewsData.io key, Telegram token/chat_id) come from `.env`, never the config file.

## 6. Determinism, cost, failure

- **Cost:** ingest + funnel are free/instant; `claude -p` runs once per score cycle over ≤~25 items and is
  cached → effectively free on the keyless CLI. NewsData.io self-throttles to its free daily budget.
- **Determinism:** the fetch path has no AI and no wall-clock scoring beyond `seenAt` decay; judge outputs
  are cached by content-hash, so a given item scores identically on replay.
- **Failure isolation (no silent caps):** an adapter throw, a feed 4xx/5xx, a `claude -p` error, or a
  notify failure is caught, logged with a count of what was skipped, and retried next cycle. One bad unit
  never stalls ingest. A single-instance lock prevents double-polling.
- **Verification:** unit tests for `funnel` (fixture items → expected lanes/scores) and `store` (dedupe,
  idempotency); an integration smoke test that runs one ingest+score cycle against recorded feed fixtures
  and asserts a shortlist is produced with no live network.

## 7. Phasing

- **Phase 1 (this spec):** `radar` service + GDELT + RSS + NewsData.io adapters + `store` + `funnel` +
  `judge` (claude -p) + Telegram `notify` + studio Radar inbox with Approve→build. The whole usable loop.
- **Phase 2 (noted, not built):** X/OSINT + Liveuamap adapter; a "learn from what you actually publish"
  signal that nudges `weights`/lexicons from outcomes; auto-fetch candidate footage (`factory:footage`/
  `newsclip`) at approval time so the draft starts with assets.

## 8. Open questions for implementation-planning

- Confirm the Telegram bot token + chat_id source (reuse openclaw's, per operator memory).
- Confirm a free NewsData.io key exists (else Phase 1 runs GDELT+RSS only; adapter stays, disabled).
- Final India/viral lexicons (seed from the reels shipped so far: LAC, rupee, monsoon/flood, Hormuz,
  nuclear, China buildup, disaster/oddity).
