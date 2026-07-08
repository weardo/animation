# Short Documentary v1 — design

**Date:** 2026-07-08
**Status:** approved (brainstorming) → ready for implementation plan
**Scope:** the FIRST increment of "reels → 5-minute short documentaries". Fully-functional slice that
ships one real 5-minute geopolitics documentary end-to-end, adding the highest-value documentary content
sources on top of the existing reel engine. Follow-on devices (kinetic typography, automated act-pacing)
are explicitly deferred to v2.

---

## 1. Goal

Extend the news-reel pipeline to produce **~5-minute geopolitics short documentaries** in the Johnny
Harris / Vox visual grammar, in Hinglish, reusing everything we already built. A documentary is the SAME
`story.yaml → scene.json → frames → mp4` pipeline scaled to ~40-60 beats grouped into acts, plus new
CONTENT SOURCES that give it documentary texture: real news media as evidence, archival stills, and
Ken-Burns motion on stills.

Success = one real 5-minute doc rendered + published, using every new source, with attribution on all
third-party media.

## 2. Operating principle — journalism / fair use with attribution

This is a **journalism / commentary tool**. Using publicly-available media as *evidence* inside attributed,
transformative commentary is the recognized editorial/fair-use purpose. Attribution does double duty here:
it is both the **licensing cover** and the **authenticity signal** (a sourced screenshot IS the credibility).

Guardrails baked into the design (recorded in provenance, surfaced in the video + description):
- **Publicly-accessible media only** — no paywall/DRM circumvention. If it is gated, we do not take it.
- **Brief + transformative** — short clips/shots used to make an editorial point, never a re-upload.
- **Always source-attribute** — publisher + date on-screen (or in the montage) AND in the description.
- Wikimedia/Pexels licenses recorded per their terms (CC/PD attribution for Commons; Pexels no-attribution).

## 3. Architecture — same pipeline, scaled + new sources

No change to the determinism model or the runtime. Every new source obeys **golden rule 1 + 2**: it runs
ONCE OFFLINE at build into a **content-addressed cache** (hash of inputs, skip-if-exists), and the render
replays the FIXED cached file — so a 5-min doc is byte-deterministic on the CPU tier even though a
screenshot / download / fetch is not. New media register as `asset` catalog entries and render through the
EXISTING `AssetLayer` (image) / `FootageLayer` (video) — no new render-layer types.

Reused as-is (zero change): `world-in` official-India map + the full map toolkit (routes/markers/fly-to),
`factory:footage` (Pexels video + browse/pick + auto-proxy), Sarvam voice (shubh/48k/0.9, आप-respectful
direct-address narration + opinion-prompt), music/SFX/ducking, transitions, post-grade, captions,
`factory:publish`, the render.log + RAM-safe concurrency.

## 4. New components

### 4.1 `factory:newsshot <url>` — article screenshots (stills evidence)
`src/cli/newsshot.ts`. Headless-browser screenshot of a news article → content-addressed PNG in
`public/img/<id>.png` → registers an `asset` (kind `asset`, format `image`, uri `asset://img/<id>.png`).
- Flags: `--id`, `--selector <css>` (crop to the headline/article node, dropping site chrome/ads),
  `--full-page`, `--width/--height` (viewport), `--wait <ms>` (let content settle).
- **Browser: reuse Remotion's already-installed Chromium via `puppeteer-core`** (locate the executable
  Remotion downloaded; fallback `--browser-path`). Avoids a new ~300 MB browser download on this box.
- Provenance: `source` = URL + publisher (from `og:site_name`/domain), capture date (the offline CLI may
  stamp wall-clock — determinism governs render FRAMES, not build-time metadata), `license` =
  "editorial/fair-use — attributed". The cached PNG (not its metadata) is the deterministic render input.
- Determinism: screenshot once → cached PNG → replay. Content-address {url, selector, viewport}.

### 4.2 `factory:newsclip <url>` — news video (event evidence)
`src/cli/newsclip.ts`. Pulls a publicly-available clip from a source URL via **`yt-dlp`** (standard,
supports most news/social hosts) → the SAME light **proxy-transcode** as footage (≤1920px, CRF 26, 2500k
cap, muted, faststart) → `public/video/<id>.mp4` → footage `asset`. Records source/publisher/date +
editorial-use provenance. `yt-dlp` missing / gated media → clean error (never a paywall bypass). Cache by
{url, section}. Reuses the footage layer for playback.

### 4.3 `factory:photo <query> --source wikimedia|pexels` — still sourcing
`src/cli/photo.ts`. One CLI, two providers behind a small `PhotoSource` interface (mirrors the publisher
registry pattern):
- **wikimedia** — Wikimedia Commons API (real archival subjects: leaders, warships, ports, events).
  Records CC/PD license + author + the required attribution string. Browse/pick like footage
  (`--list`/`--index`) since Commons relevance varies.
- **pexels** — Pexels Photos API (generic mood b-roll, no-attribution).
- Both → content-addressed PNG/JPG cache → `asset` (kind image), **auto-downscaled light** (reuse the
  footage proxy recipe adapted for images) so Ken-Burns pan/zoom stays cheap.

### 4.4 Ken Burns sugar — pan/zoom on stills (authoring convenience, no new render code)
A `kenburns` field on an image/asset show-item, expanded by the **lowering pass** into the EXISTING
per-layer `transform` `{a,k}` keyframes (scale + position) over the beat duration — `AssetLayer` already
animates that transform, so there is ZERO new render logic and it stays deterministic.
- Shorthand: `kenburns: "in" | "out" | "pan-left" | "pan-right" | "pan-up" | "pan-down"`.
- Explicit: `kenburns: { from: {scale,x,y}, to: {scale,x,y}, ease? }`.
- Lowering picks a non-linear easing by default (never linear, per the stylekit floor).

## 5. Authoring model (mostly convention — minimal code)

- **News montage = rapid short beats** (NO new code): 5-8 beats of ~0.6-1.0 s, each a `newsshot` image
  with a hard cut (no transition) + a whip/riser SFX → signifies ubiquity ("everyone is reporting this").
  Documented as a pattern in the skill; a thin optional helper can come later if hand-authoring is tedious.
- **Act structure = comment-grouped beats** in `story.yaml` (Act I hook/context, Act II escalation, Act
  III turn+resolution), with music swells + a beat of near-silence at act boundaries using the existing
  `music`/`sfx`. Convention, not new code. ~40-60 beats total.
- **All reel principles carry over**: `world-in` official map (legally required), Mukta font, the coherent
  ONE-STORY script written as a monologue then split, **आप-respectful direct address** + rhetorical
  questions + an opinion/comment prompt, tailored per-clip effects (no blanket dark crush), browse+
  contact-sheet footage/photo verification, चाइना-style phonetic spellings for TTS, beat-duration-fits-
  narration, the `publish:` block.

## 6. Data flow

```
news URLs ──factory:newsshot──▶ public/img/*.png ─┐
news URLs ──factory:newsclip──▶ public/video/*.mp4 ┤
queries  ──factory:photo─────▶ public/img/*.(png|jpg) ┤   (all: cache-once, provenance+attribution)
                                                       ├─▶ library/index.json asset entries
maps/footage/voice/music (existing) ───────────────────┘
        │
   story.yaml (~40-60 beats, acts; kenburns sugar) ──runPipeline──▶ scene.json ──render──▶ out.mp4 ──factory:publish──▶ YouTube
```

## 7. Scope boundaries

**In v1:** the three content-source CLIs (newsshot / newsclip / photo), the Ken Burns lowering sugar, the
montage + act-structure authoring conventions, and ONE shipped 5-minute doc.

**Deferred to v2 (NOT built now):** kinetic typography (animated pull-quotes / lower-thirds / stat
callouts), automated act-pacing + music-swell tooling, a dedicated montage helper/layer, an
auto-scripting front-end.

## 8. Risks + mitigations

- **Fair-use posture** → brief + attributed + transformative; publicly-accessible only; attribution in
  provenance + on-screen + description. (§2)
- **`puppeteer-core` locating Remotion's Chromium** → detect Remotion's browser path; `--browser-path`
  fallback; clean error if absent (never silently blank).
- **`yt-dlp` availability + gated media** → require `yt-dlp` on PATH; on gated/DRM media, error out (no
  bypass). Document install.
- **5-min render time** (~9,000 frames ≈ 25-35 min on this box) → expected; monitor via render.log; the
  fast-still verification path (`--frames`) validates look before the long encode.
- **Wikimedia relevance/quality varies** → browse/pick + visual verify (the footage lesson).
- **60-beat `story.yaml` is large** → acceptable for v1; if unwieldy, a v2 include/chapters mechanism.

## 9. First documentary

**Recommended:** EXPAND the Indian-Ocean / Duqm / Malacca material into a 5-minute doc — it has the most
existing map geometry (chokepoints, Duqm, Gwadar, routes) + verified footage (port, container port, Indian
Coast Guard vessel) to build on, so v1 effort concentrates on the NEW devices. Working title: *"India's
Ocean Gambit — how Duqm rewrites the Indian Ocean"*. Easily swapped for a new topic if preferred.

## 10. Verification / definition of done

- Each new CLI: run once → cached artifact exists + `asset` entry + provenance/attribution recorded; a
  re-run reuses the cache (skip-if-exists).
- Ken Burns: a still visibly pans/zooms; `--frames` stills confirm start/end framing.
- The doc: renders to ~5 min, audio audible (mean ≫ −60 dB), zero narration overlaps, news montage reads,
  attributions present, published unlisted.
- Determinism unaffected: CPU-tier re-render byte-identical (spot-check a short segment).
- `verify-render` gates (domain-clean grep, delete-the-plugin where applicable) still pass.

## 11. Reuse map (what's new vs reused)

| Capability | Status |
|---|---|
| Map toolkit, footage, voice, music/SFX, transitions, post, captions, publish, render.log | REUSED unchanged |
| `AssetLayer` (image), `FootageLayer` (video) render paths | REUSED (Ken Burns via existing transform anim) |
| `factory:newsshot` (screenshots) | NEW |
| `factory:newsclip` (yt-dlp video) | NEW |
| `factory:photo` (Wikimedia + Pexels stills) | NEW |
| `kenburns` lowering sugar | NEW (schema + lowering only) |
| news-montage + act-structure conventions | NEW (skill/docs only) |
| the 5-min doc project | NEW (data) |
