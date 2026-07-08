# Agentic Animation Factory — SaaS / Deploy-Ready Design

**Date:** 2026-07-08
**Status:** Draft (awaiting review)
**Scope:** Convert the deterministic Animation Factory from a *human-operated* pipeline (a person driving the CLIs and applying judgment) into an *autonomous, agent-operated* pipeline delivered as a **complete, self-hosted web application** — clone, `docker compose up`, open a browser, type a brief, get a video. Portfolio-flagship first; open-source; extensible as code **and** live after deploy. Cloud / multi-tenant is optional upside beyond the self-hosted line.

---

## 1. Context

Today the factory is a mature **deterministic compiler**: `script → Story IR → Scene IR → frames → MP4`, with a plugin engine, content-addressed caching, a Zod IR, a Remotion render adapter, and a clean CLI surface (`factory:footage/photo/newsshot/newsclip`, `narrate`, `sfx`, `render`, `publish`, `imagegen`).

The missing piece is **judgment**. Right now a human (the operator) *is* the orchestration layer: call a tool → read its output → judge it ("this footage is fireworks, not fire") → decide the next move → verify ("this riser peaks after its boom") → iterate. Every quality outcome depends on that human loop.

**This project externalizes that loop** into an autonomous team of specialist agents wired by a deterministic orchestrator, with the operator's craft rules encoded as **executable verification gates**. The render pipeline is unchanged — agents emit *data* (IR), never frames (golden rule 2).

### The crux, in one line
> Deploying this is not primarily a hosting problem. It is an **agent-design** problem: replace the operator's cognition with specialist agents + verify gates, expose the engine as tools, and only then wrap it in a service.

## 2. Goals / Non-goals

**Goals**
- G1. A **brief → finished video** pipeline that runs with **zero human intervention**.
- G2. **Determinism preserved**: the render stays byte-identical; the (stochastic) agent step is tamed by content-addressed caching (run-once, replay-fixed) — the existing M5 `LlmDirector` pattern, generalized.
- G3. **Extensible** at every layer: a new capability is an additive plugin / agent / tool / gate / data entry, **never a core edit**. Some extension is **live** (no redeploy); the rest is additive.
- G4. **A runnable self-hosted app is the definition of done.** The *guaranteed* end-state is a single-user application someone can **clone and run locally** (`docker compose up` / one command), open in a browser, type a brief, and get a video back. It must survive minutes-long, RAM-heavy renders (a local render worker keeps the UI responsive). **Cloud / multi-tenant is optional upside *beyond* this line — never a prerequisite for it.**
- G5. **Value banks incrementally**: a runnable app exists early (P1) and each milestone (P0…P5) is an independently demoable **portfolio artifact**.

**Non-goals (beyond the self-hosted target — optional, not required)**
- Billing, metering, subscription plans, multi-tenant auth hardening (P5 scaffolds the *shape* only; don't build the store).
- Serving *other paying users'* LLM inference — irrelevant on a single-user localhost app, where `claude -p` uses the operator's own CLI (see §11).
- Model training / fine-tuning / a model registry.
- Chasing the funded text-to-video market head-on.

## 3. Design principles (carried up from the engine)

1. **Determinism is the moat.** Same IR → byte-identical MP4. The nondeterministic LLM step is **run once, validated, content-addressed cached, and replayed** — so a warm brief reproduces exactly (as TTS/imagegen/`LlmDirector` already do).
2. **Every layer: thin generic core + extension registry.** The core specializes in *nothing*; capability = a plugin/agent (code), content = the library (data). Enforced by the delete-the-plugin test, extended to agents/tools/gates.
3. **Standards at the boundary, own the compiler.** Adopt **MCP** (tool protocol), **Zod** (I/O contracts), **Langfuse** (tracing), `claude -p` (LLM). *Do not* adopt LangChain/LangGraph/DSPy/MLflow — they own the loop and would bury the cache-and-replay seam that *is* our determinism. Borrow their concepts (state-graph, prompt-as-artifact, tracing, evals), implement them thin in TS.
4. **Thin executors, not fat orchestrators.** The orchestrator is a small deterministic DAG runner; the intelligence lives in scoped specialist agents.
5. **Incremental & functional.** Each increment ships something that works and demos on its own.

## 4. Architecture — four layers

```
┌─ Service layer (self-host default → cloud optional) ─────────┐
│ local API · job runner · workers (agent pool + render pool)  │
│ SQLite · filesystem · JSONL ledger (+ Langfuse profile)      │
│   └ cloud swap-in: Postgres · S3/MinIO · Redis/BullMQ        │
├─ Agent layer (NEW — the portfolio centerpiece) ──────────────┤
│ Orchestrator (deterministic DAG) → specialist agents         │
│ verify gates · agent-output cache · claude -p · Langfuse      │
├─ Tool boundary (NEW) ────────────────────────────────────────┤
│ MCP server — engine + library + asset CLIs exposed as tools  │
├─ Engine + Content (EXISTS) ──────────────────────────────────┤
│ deterministic compiler · plugin registries · IR (Zod)        │
│ content library · asset library (content-addressed, license) │
└──────────────────────────────────────────────────────────────┘
```

## 5. Monorepo structure (open-source shape)

pnpm/Nx workspace. Existing code becomes `engine` + `plugins` largely untouched; the rest is additive packages.

```
packages/
  engine/      # EXISTS: ir, pipeline, render, engine registries  (src/* today)
  plugins/     # EXISTS: capability plugins (generators/rigs/effects/transitions/dataviz…)
  library/     # EXISTS: content + asset resolver (content-addressed, provenance/license)
  mcp-server/  # NEW: wraps engine+library+asset capabilities as MCP tools  ← tool boundary
  agents/      # NEW: specialist agents + orchestrator + quality gates + versioned prompts
  eval/        # NEW: eval harness over golden briefs
  api/         # NEW: stateless HTTP (submit brief, poll job, fetch artifacts)
  worker/      # NEW: queue consumers — agent-orchestration pool + render pool
  web/         # NEW: thin UI (brief in, progress, preview, publish)
infra/         # compose/deploy manifests + Langfuse + MinIO + Postgres
```

Migration is mechanical: wrap today's `src/` as `packages/engine`, `plugins/` as `packages/plugins`; no behavior change (a workspace move, guarded by typecheck + a golden render).

## 6. Tool boundary — the MCP server

The CLIs are refactored into a **callable core** (typed TS functions) with the existing CLI as a thin wrapper; the MCP server exposes those functions as tools. This gives one contract used by *both* built-in agents and any external MCP client.

**Tool families (initial):**
- `library.*` — resolve/list content + asset catalog entries, pin/verify (wraps `LibraryResolver`/`AssetRefResolver`).
- `footage.search|browse|pick|verify` — the browse-and-verify workflow (contact-sheet frames returned as the on-subject signal).
- `photo.search|pick`, `newsshot.capture`, `newsclip.fetch` — evidence sources (provenance/license packed in).
- `narrate.probe` — synth-or-cache a line, return duration + (optional) word timings (for fitting beats + SFX placement).
- `sfx.synth`, `music.list` — audio palette.
- `map.preview` — render a **still** of a map config (fast verify of projection/framing).
- `compile.probe` — lower a Story IR → Scene IR and render `--frames auto` stills (fast layout verify before the slow full render).
- `render.submit` — enqueue a full render (async; returns a job handle).
- `publish.submit` — dispatch to a Publisher (registry; YouTube today).

**Live extensibility:** the MCP server loads tool plugins dynamically (a tool manifest), so a new tool = a new capability agents can use **without redeploying the agents**.

## 7. Agent layer

### 7.1 Specialist roster
Each specialist has a **Zod input contract**, a **Zod output contract** (an IR fragment), a **scoped tool-belt**, and a **verify gate**. Adding a role = a new agent manifest + a DAG entry (additive).

| Specialist | In → Out | Tools | Verify gate (fail → retry) |
|---|---|---|---|
| **Story Architect** | brief, style, len, aspect → Story-IR beats (say/show intents, structure tags) | (research later) | reads-as-one-story; hook/turn/payoff present; आप-respectful direct address; pronunciation locks; duration budget |
| **Asset Scout** | beat asset intents → resolved asset refs | footage.*, photo.*, newsshot, newsclip | **on-subject** (verifier judges contact sheet); license + provenance present; context-specific (right country/entity) |
| **Map Designer** | geographic beats → map generator configs | map.preview | projection valid; region framed tight; labels present; **choropleth-safe** (no `draw_on` on choropleth); official `world-in` where legally required |
| **Audio Designer** | beats + narration timings → sfx cues, music bed, ducking | narrate.probe, sfx.synth, music.list | **riser peak = start + round(1.2·fps)**; riser ≤ once, only on the biggest reveal; SFX ducked under VO (`mix`); loudness floor |
| **Assembler** | all fragments → complete Story IR (`show[]`, camera, transitions, Ken Burns, durations) | compile.probe | **zero VO overlaps**; durations fit narration (+~0.9s); safe-area/layout; stills render clean |
| **Verifier** | any stage output → verdict | (reads tool outputs) | adversarial, perspective-diverse checks; majority-refute kills the fragment |

> The craft rules that cost the operator repeated vigilance this session (fireworks-not-fire, stitched-headlines, riser out-of-nowhere) become **gate code** here — deterministic where possible (riser math, loudness, overlap), agent-judged where not (on-subject, one-story).

### 7.2 Orchestrator
A small deterministic **DAG runner** (TS). Per node:
1. **Cache lookup** — key = `hash(node inputs + PROMPT_VERSION + tool-results hash)`. Hit → replay the fixed fragment (no LLM call). Miss → run.
2. **Run** the specialist (`claude -p`, schema-validated output; retry on schema-mismatch — the M5 pattern).
3. **Verify** — run the gate. Pass → advance + persist to cache. Fail → **bounded retry** feeding the verifier's critique back into the prompt.
4. **Fallback** — repeated fail → a deterministic default (heuristic pick / neutral choice) or escalate to a human-review queue; never hard-fail the run.

State = an accumulating Story IR + a provenance ledger. Given warm caches the whole run is deterministic; the render is byte-deterministic from the resulting IR.

### 7.3 Determinism boundary (state this honestly)
- **Render:** byte-identical given the IR (unchanged).
- **Agent step:** *cached-deterministic* — the first run of a brief calls the LLM (nondeterministic) once; the validated result is content-addressed and **replayed** thereafter. So **same brief → same video after the first run**; two *cold* runs of the same brief may differ (like re-rolling a stochastic generator). This is exactly how TTS/imagegen/`LlmDirector` already behave, and it is acceptable and documented.

### 7.4 LLM backend
`claude -p --output-format json`, keyless — the existing `src/pipeline/director.ts` seam generalized from "director" to "every specialist." Behind a **provider registry** so a paid API key (or a local model) is a drop-in if multi-tenant is ever pursued. Prompts are **versioned data** (`PROMPT_VERSION`, like `PASS_VERSION`) so a prompt change invalidates the agent cache.

### 7.5 Observability — Langfuse
Self-hosted (OSS, TS SDK). One **trace per run**; spans per **agent**, per **tool call**, per **verify gate**, per **retry**, with token cost + latency + the verify verdict. This makes the verify-retry loop (e.g. "footage rejected off-subject → re-picked") *visible* — the single best recruiter-facing artifact.

## 8. Quality gates / verification model

Two kinds, composed per stage:
- **Deterministic checks** (pure functions, cheap, exact): riser peak timing, SFX mix ≤ threshold, zero VO overlap, duration-fits-narration, projection-valid, choropleth-safety, license-present, loudness floor.
- **Adversarial agent checks** (judgment): on-subject, reads-as-one-story, context-specific, register (आप vs तू/तुम). Use **perspective-diverse verifiers** (2–3 lenses, majority-refute kills). Default to *refuted* under uncertainty so a bad fragment doesn't slip through.

Gates are a **registry** — a new gate is additive and can be attached to any stage.

## 9. Eval harness (`packages/eval`)

The gates *are* the metrics. A set of **golden briefs** (varied: reel/doc, map-heavy/footage-heavy, different topics) runs the whole pipeline offline and reports **quality-gate pass-rates** (on-subject %, riser-timing correctness, loudness-in-range, zero-overlap rate, retries-per-run, token cost/video). Regressions surface as pass-rate drops. This is the reliability engine **and** a strong portfolio artifact ("I measure my agents, not just build them").

## 10. Data structures & multi-tenancy shape

Shaped for multi-tenant even while single-tenant:
- `Tenant → Project → Job → Artifact`.
- **Project** = manifest + story + scene.json + lock + assets, namespaced per tenant in object storage (today's `projects/<id>/` layout, hosted).
- **Library** = shared public (content-addressed) + optional per-tenant private namespace.
- **Provenance ledger** (SQLite self-host / Postgres cloud, + JSONL) — every asset's source/license (fair-use compliance is a first-class record, not a comment).
- **Storage** — local filesystem for self-host (`projects/`, `assets/`, `outputs/`); S3/MinIO an optional cloud swap-in behind the same interface.

## 11. Deployment — self-hosted first

**Primary target: a single-user, self-hosted app that runs on localhost with one command.** Deliberately lightweight — no cloud services required:

```
docker compose up                    # → app on http://localhost:<port>
  web (thin UI) ─▶ local API ─▶ local job runner
                                   ├─ agent worker  (claude -p via the host's Claude CLI)
                                   └─ render worker (separate process; RAM-heavy)
  storage: local filesystem  (projects/ assets/ outputs/)   # no S3/MinIO needed
  db:      SQLite            (projects, jobs, provenance)    # zero-config
  tracing: JSONL run-ledger (always on) + Langfuse (opt-in `--profile observability`)
```

- **LLM on localhost = the operator's own authenticated Claude CLI** (`claude -p`, keyless). On a single-user self-host this is **free and unconstrained — the multi-tenant `claude -p` problem does not exist here.** The provider registry keeps a paid-API-key path for anyone who wants one.
- **Render stays off-request** — a separate local render **worker process** keeps the UI responsive through the minutes-long render (CPU-raster default: byte-safe + disk-safe).
- **Langfuse** (your chosen tracer) ships as an **optional compose profile**, so the minimal app stays light; the always-on baseline is the JSONL run-ledger. Flip the profile on for the dashboard/demo.

**Optional cloud shape (beyond the self-hosted line, P5):** swap SQLite→Postgres, filesystem→S3/MinIO, the local runner→Redis/BullMQ, and add per-tenant namespacing — same code, heavier backends. Not required to "run and make videos."

### 11.1 Web UI — the complete self-host front-end (`packages/web`)

The UI is a **first-class, required deliverable**, not a thin form. A small SPA (Vite + React + Tailwind, framework TBD in §15) served by the local API; live progress over **SSE/WebSocket** from the job runner; the video plays in-browser via an `<video>` tag off the local outputs dir. Screens:

1. **Create** — the entry point. A brief textarea + controls: **style** preset (kurzgesagt / plain), **aspect** (9:16 / 16:9 / 1:1), **target length**, **language**, **voice**, optional **reference/notes**. "Generate" enqueues a job. Sample briefs one-click to load.
2. **Run / Progress** (the money screen) — a **live pipeline view**: the stages (Story → Assets → Map → Audio → Assemble → Render) as a progress rail, each showing the active **agent**, its tool calls, the **verify-gate** verdict (✓/✗) and **retries** (the self-correction made *visible*), streamed log lines, and — if the Langfuse profile is on — a deep-link to the full trace.
3. **Preview / Review** — the finished **video player** beside the **Story IR** (beats list). Optional **human-in-the-loop overrides** per beat: "re-pick this footage", "rewrite this line", "retime SFX" → re-runs just that stage (reuses the agent cache for the rest). "Looks good" → ready to publish.
4. **Projects** — the library of past projects (thumbnail, title, status, date). Open / duplicate / re-render / delete. This is the "project management" surface.
5. **Assets** — browse a project's + the shared library's assets (footage / photos / sfx / music / fonts), each showing **provenance + license** (the fair-use ledger, visible — a credibility feature). This is "project asset management".
6. **Publish** — pick platform (YouTube today; registry-driven), visibility (**unlisted default**), editable metadata (title / description / tags / language), a **dry-run preview**, then upload. Shows the resulting link.
7. **Settings** — LLM provider (**`claude -p` default** / API key), voice + style defaults, storage paths, the **Langfuse toggle**, and the external keys (Sarvam / Pexels / YouTube OAuth) with a **first-run setup check** that tells the self-hoster exactly what's missing.

**Progressive build:** P1 ships screens 1–3 (Create / Progress / Preview) as the walking skeleton; P2 enriches the Progress screen with the live agent/gate view; P3 completes 4–7 (Projects / Assets / Publish / Settings) + packaging.

## 12. Extension surface (the open-source contribution points)

| Extend | Mechanism | Live (no redeploy)? |
|---|---|---|
| Engine capability | `plugins/<id>/` (plugin.json + register) | redeploy |
| MCP tool | tool manifest in `mcp-server` | **yes** (dynamic load) |
| Specialist agent / stage | agent manifest + DAG entry | redeploy (additive) |
| Quality gate | gate registry entry | redeploy (additive) |
| Stylekit / library content | data (JSON / catalog) | **yes** (runtime data) |
| Publisher (TikTok/IG…) | publish registry (YouTube exists) | redeploy (additive) |
| LLM provider | provider registry (`claude -p` default) | config |

## 13. Build sequence — anchored on a runnable, self-hosted **web app**

> **The self-hosted web app is guaranteed, early, and continuous** — a runnable app with a browser UI exists from **P1** and gets more autonomous + more polished each step. Evals and cloud shape are *beyond* the "good enough to run" line. Each Pn also banks a standalone 🎞 portfolio artifact.

### P0 — Factory-over-MCP (the tool boundary)
- **Scope:** refactor CLIs → callable core; stand up `mcp-server` exposing the tool families (§6).
- **Verify:** an MCP client (or the operator) drives the *entire* factory through MCP tools end-to-end.
- 🎞 "A whole deterministic video factory, exposed as an MCP server." **Show:** an MCP client calling `footage.pick` → `narrate.probe` → `render.submit`.

### P1 — Runnable self-hosted **walking skeleton** ← "at least it runs, in a browser"
- **Scope:** the orchestrator skeleton + agent-output cache + tracing + the **Story Architect** (brief → structured story), wrapped in the **local app**: `docker compose up` → **Web UI** (Create + Progress + Preview screens, §11.1) → local API → SQLite job → render worker → a video plays in the browser. Assets/audio/assembly initially lean on existing tools + the `HeuristicDirector`, so a **rough-but-real** video comes out end-to-end.
- **Verify:** `git clone` → one command → open `localhost` → type a brief → watch it run → a (rough) video plays. No manual authoring, no terminal.
- 🎞 "A self-hosted web app that turns a one-line brief into a video." **Show:** the browser flow + the generated Story IR + the trace.

### P2 — Full specialist team + verify gates (the app gets *good*)
- **Scope:** Asset Scout, Map Designer, Audio Designer, Assembler, Verifier + all gates + retry/fallback — behind the same UI. The Progress screen now surfaces each agent + gate live.
- **Verify:** the same localhost flow yields a **publish-quality reel, zero human touch**; the Progress/trace view shows agents **self-correcting** (off-subject footage re-picked; riser retimed).
- 🎞 THE flagship: "One brief in, a finished video out, no human — watch the agents fix themselves, live in the UI." **Show:** the video + the self-correcting run view.

### P3 — Complete, polished self-hosted product ← **definition of done**
- **Scope:** the full Web UI (§11.1) — Projects library, Asset browser (with provenance/license), per-beat human-in-the-loop overrides, the Publish flow, Settings/keys — plus **packaging** for easy self-host (README, `docker compose up`, sample briefs, first-run setup check for the Claude CLI + API keys).
- **Verify:** a stranger can `git clone`, run one command, and **create + preview + publish** a video entirely in the browser, without touching code.
- 🎞 "An open-source, self-hostable AI video studio." **Show:** the repo + a 90s clone-to-published-video screen recording.

### P4 — Eval-driven reliability *(beyond the line)*
- **Scope:** `packages/eval`, golden briefs, pass-rate report (surfaced as a dashboard tab).
- **Verify:** a metrics report; a seeded regression is caught by a pass-rate drop.
- 🎞 "I measure my agents, not just build them." **Show:** the eval report (pass-rates, retries/run, cost/video) + a caught regression.

### P5 — Cloud/production-shaped + provably general *(beyond the line)*
- **Scope:** swap SQLite→Postgres, filesystem→S3/MinIO, local runner→BullMQ + per-tenant namespacing; more publishers; contribution docs; a *second* domain through the same orchestrator to prove domain-agnosticism.
- **Verify:** an external contributor adds a specialist/tool by the docs; the second domain runs end-to-end; the app runs multi-tenant on a server.
- 🎞 "A reusable agentic-pipeline framework, open-source, proven on two domains." **Show:** the extend-it guide + the second-domain demo + a live URL.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cold-run agent nondeterminism confuses "determinism" claim | Document the boundary (§7.3): render is byte-exact; agent step is cached-deterministic (run-once, replay). |
| `claude -p` can't serve other users | Not a problem for self-host (the operator's own CLI, free + unconstrained). Only relevant for the *optional* cloud shape (P5), where the provider registry swaps in a paid key. |
| Self-hoster hasn't authenticated the Claude CLI / lacks API keys | First-run setup check in Settings (§11.1 #7) names exactly what's missing before the first run. |
| Agent quality regressions | The eval harness (P3) + versioned prompts (`PROMPT_VERSION`) + verify gates. |
| Render RAM/latency on a shared box | Separate render worker pool; async queue; CPU-raster default (byte-safe, disk-safe). |
| Monorepo migration breaks the engine | Mechanical move guarded by typecheck + a golden render diff; behavior unchanged. |
| Scope creep into billing/multi-tenant | Explicit non-goals (§2); scaffold shape only. |

## 15. Open questions (for the plan phase)

- Job runner for self-host: an in-process worker vs a lightweight SQLite/file-backed queue (restart-safe)? (BullMQ/Redis deferred to the optional cloud shape, P5.)
- Web UI framework: Vite + React SPA vs Next.js vs a server-rendered app — lightest to self-host **and** nicest to demo?
- Langfuse self-host is a bit heavy (Postgres + Clickhouse). Ship it as an opt-in compose profile (default tracing = the JSONL ledger), or point the demo at Langfuse Cloud's free tier with self-host documented?
- How many golden briefs make a meaningful eval set (P4)?

---

*Next: on approval, an implementation plan (writing-plans) that sequences P0→P5 into concrete, verifiable steps.*
