# Remaining Capability Roadmap — "cover all of it"

**Date:** 2026-06-23 · **Status:** Planned (decisions locked via the 2026-06-23 Q&A). Sequenced to run
AFTER the painting-style workflow (`wag7nnvs2`) lands — two workflows editing the render core +
`library/index.json` concurrently would collide.

This is the full tail after the architecture (ADR-001→008), the ADR-003 vocabulary (#1–10), ADR-004,
and the audio MVP. Every item obeys the golden rules: determinism (CPU byte-exact OR offline-cached
artifact OR perceptual GPU tier), the engine specializes in nothing (plugins + library data), reuse
over invent, and the standing gates (domain-clean / style-clean / delete-the-plugin / verify-render).

## Locked decisions (2026-06-23)
- **Whisper:** YES — install an offline Whisper (whisper.cpp / faster-whisper). Build-time forced
  alignment, cached → deterministic. Unlocks precise captions AND lip-sync phoneme timing.
- **Director:** BOTH — a heuristic director NOW + a clean LLM seam. The LLM is **Claude via `claude -p`
  (keyless, the user's subscription)** — "you're my LLM right now" — so the LLM path is NOT
  budget-blocked. Same engine later powers the script→IR expander.
- **Tier-B GPU:** unlock under the **perceptual GPU tier** (VMAF-verified, not byte-identical). CPU tier
  stays the byte-exact default.
- **AI asset-gen:** attempt a **lightweight local model** — Stable Diffusion via **OpenVINO /
  stable-diffusion.cpp on the Iris Xe iGPU** (FP16). Stochastic generator → **offline content-addressed
  cache** (hash of prompt+seed+model, skip-if-exists) → render replays the fixed PNG (golden rule 1/2,
  exactly like TTS). Google MobileDiffusion (520M) is a tiny-model stretch-goal (mobile-first).

## Determinism strategy per item (the key design axis)
- **Pure CPU/SVG → byte-identical** (the default gate): interfaces, maps, ingest, post[] grade, paint
  follow-ons, the heuristic director (pure scoring), caption *rendering*.
- **Offline-cached artifact → byte-identical replay** (the TTS pattern): whisper alignment, AI asset-gen,
  any `claude -p` director/expander output (cache the IR it emits, keyed on script hash).
- **Perceptual GPU tier → VMAF-verified** (not byte-exact): Tier-B GPU effects only.

---

## M4 — Precision audio (needs Whisper)
**4a. Whisper word-timestamp captions.** Install whisper.cpp/faster-whisper in an isolated venv (like
`.venv-tts`). A build-time pass aligns the narration `say` text to the cached narration wav → real word
timestamps → precise `captions[]` cue windows (replaces even-split). Cache the alignment JSON
(content-addressed) → deterministic; `CaptionTrack.tsx` already renders word cadence, so the render side
is a small change. Engine-swappable (espeak even-split stays the no-Whisper fallback).
**4b. Lip-sync (visemes).** Phonemes from the same alignment → a viseme track → drives the blob-creature
provider's mouth part-swap/shape per frame (provider-specific; a `mouth` channel in the rig spec). Pure
function of (viseme track, frame) → deterministic. Other providers ignore it (opt-in).

## M5 — Director (heuristic now + `claude -p` LLM seam)
**5a. Heuristic layout/camera director.** A pipeline pass: score candidate layouts (balance, focal
weight, headroom, rule-of-thirds, safe-area for the chosen aspect) + pick camera moves from the recipe
table by beat intent. Pure, deterministic, local, free. Replaces the current "lite" anchors.
**5b. LLM seam.** A thin `director` interface with two impls: `heuristic` (5a) and `llm` (shells to
`claude -p` — keyless — emitting layout/camera DATA, validated by Zod, **cached on script hash** so the
render is deterministic + offline-replayable). This same seam is the spine of the future **script→IR
expander** (P1): a story sentence → Story IR via `claude -p`, cached.

## M6 — Tier-B GPU effects (perceptual tier)
Add GPU-backed effects/transitions as plugins that run ONLY on the `--gpu` perceptual tier: GL
Transitions, PixiJS filters, postprocessing, (optionally three/skia). Gated so the CPU tier never sees
them (stays byte-exact). Verify with VMAF against a reference, not `cmp`. ADR-003 #11 closed under the
perceptual-tier reframe.

## M7 — Library breadth
**7a. ADR-001 formal interfaces.** Extract `AssetProvider` + `LibraryResolver` TS interfaces in
`src/library` (formalize what loader/resolver already do). Mechanical; no behavior change.
**7b. Iconify/unDraw bulk ingest.** A CLI that ingests open icon/illustration sets (MIT/CC0) as
`object`-provider library entries (SVG → catalog entries, content-addressed). Bulk vocabulary; the
`object` provider already renders them. Licensing recorded per set.
**7c. D3-geo maps.** A `map` generator plugin (peer of core-dataviz): d3-geo + topojson → SVG paths
(choropleth / projection / draw-on). Pure → deterministic. Closes the data-viz maps gap.

## M8 — Finishing passes
**8a. `post[]` composition grade.** Wire the reserved IR `post[]` field to a final composition-level
effects stack (color grade / vignette / grain over the whole frame) in `Composition.tsx`, reusing
core-effects ops. Pure → deterministic.
**8b. Painting-style follow-ons.** Per-silhouette form-shade + far-layer atmospheric tint (the design's
listed follow-ons) — fold into the paint system once `wag7nnvs2` lands.

## M9 — AI asset-gen (OpenVINO SD on Iris Xe, cached)
A `factory:imagegen` build CLI: prompt + seed + model → OpenVINO/stable-diffusion.cpp on the iGPU →
PNG → **content-addressed cache** (skip-if-exists) → registered as a library `asset` entry the render
replays. AI touches ONLY the offline library (golden rule 2). Slow per image (~30-90s iGPU) but it's a
build step, so render stays fast + byte-deterministic. Stretch: MobileDiffusion tiny model.

---

## Sequencing (avoid concurrent tree collisions)
1. **(running)** painting-style `wag7nnvs2` — owns render core + `library/index.json` right now.
2. On paint completion → **Batch A** (no render-core / no shared-JSON contention with each other,
   lane-separated): M7a interfaces · M7c maps · M8a post[] grade · M4a whisper captions.
3. **Batch B:** M5 director (+ LLM seam) · M4b lip-sync · M8b paint follow-ons.
4. **Batch C:** M6 Tier-B GPU (perceptual) · M9 AI asset-gen (both need installs: GPU stack / OpenVINO).
5. Each batch closes with `verify-render` + `refine-standard` (ADRs 009→…, DECISIONS, CLAUDE.md).

Tool installs required: Whisper (M4), OpenVINO + SD model (M9), GL/Pixi stack (M6). Each isolated like
`.venv-tts`, cached, offline after first fetch.
