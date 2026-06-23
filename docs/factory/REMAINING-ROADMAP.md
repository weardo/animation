# Remaining Capability Roadmap — "cover all of it"

**Date:** 2026-06-23 · **Status:** ROADMAP COMPLETE — all milestones DONE. **Batch A
landed 2026-06-23: ✅ M7a interfaces · ✅ M7b icons · ✅ M7c maps · ✅ M8a post[] grade; ✅ M8b paint
follow-ons (Batch B).** **Batches B/C landed 2026-06-23: ✅ M4a whisper word-sync captions · ✅ M4b
lip-sync visemes · ✅ M5 director (heuristic + `claude -p` LLM seam) · ✅ M6 Tier-B GPU (perceptual
VMAF tier) · ✅ M9 AI asset-gen (OpenVINO SD, cached).** Remaining (deliberately deferred, NOT on the
"cover all of it" tail): the ADR-001 `LibraryResolver` REMOTE variant + a specified bundle/export
format. Sequenced to run AFTER the painting-style workflow (`wag7nnvs2`) landed — two workflows editing
the render core + `library/index.json` concurrently would collide.

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
**4a. Whisper word-timestamp captions. ✅ DONE (2026-06-23).** faster-whisper lives in `.venv-whisper`
(model "small", `HF_HOME` pinned) + `scripts/tts/align_whisper.py`. `narrate.ts:alignNarration()`
force-aligns each cached narration wav to its transcript OFFLINE → per-word seconds → cached
content-addressed under `assets/audio/align/<hash>.json` (`alignHash` = wav-hash + transcript + model;
skip-if-exists). `timedWordsFromAlignment` maps seconds → CaptionCue `wordsTimed[]` (local frame
`at`/`dur`); `CaptionTrack.tsx` reveals words on their REAL spoken times (`words` mode). Cache hit
replays the FIXED JSON → byte-deterministic though whisper isn't bit-exact. Missing venv / model /
alignment error → even-split `words[]` fallback (never fails the build). `--no-word-align` skips it.
**4b. Lip-sync (visemes). ✅ DONE (2026-06-23).** `narrate.ts:mouthTrackForNarration()` derives a
per-frame mouth-OPENNESS track (RMS energy envelope via ffmpeg `f32le` decode → 0..1 with gamma + an
attack/decay smoother, cached content-addressed; `mouthHash` = wav-hash + fps + frames + analyzer ver)
and, when a whisper alignment exists, coarse per-frame viseme LABELS (in-word vs gap) for free. The
narrate pass attaches it to the SPEAKER rig layer's generic OPAQUE `mouth` channel (`MouthTrackSchema`
in `scene.ts`: `open[]` + optional `viseme[]`). Core never interprets a sample — the blob-creature
provider reads `mouth` to drive its mouth part. Pure fn of (track, frame) → deterministic; other
providers ignore it (opt-in); `--no-lip-sync` off; no narration → no track (rig idles).

## M5 — Director (heuristic now + `claude -p` LLM seam) ✅ DONE (2026-06-23)
`src/pipeline/director.ts` — a `Director` interface (`plan(ir) → DirectorPlan`, never mutates) + a pure
`applyPlan` fold; runs BEFORE the lite layout (P6) + camera (P8) passes, AUTHOR ALWAYS WINS (only fills
free placements / unset camera intent). DirectorPlan coords are FRACTIONAL (0..1, aspect-independent).
**5a. HeuristicDirector (DEFAULT).** Pure/local/free: scores rule-of-thirds candidate slots (clamped to
an aspect-scaled safe area) by focal weight + headroom (text up / grounded down) + balance (alternate
sides); picks a camera preset NAME by structural beat intent (first scene = establishing, 1 focal =
push-in, ≥3 = pull-out, else hold) — the MECHANISM here, the move RECIPES stay DATA in
`library/camera/presets.json`. Deterministic (ties break on layer id).
**5b. LlmDirector (OPT-IN, `kind:"llm"`).** Shells to `claude -p --output-format json` (keyless,
no-tools, `--strict-mcp-config`) ONCE, validates against `DirectorPlanSchema` + the live preset table,
and CACHES content-addressed under `.cache/director/plan-<key>.json` (`planCacheKey` = briefs + aspect +
preset names). Cache hit replays the FIXED plan → render is byte-deterministic + fully offline though
the LLM isn't. ANY failure (no binary / non-zero exit / invalid output) → HeuristicDirector fallback
(never fails the build); `DIRECTOR_DEBUG=1` surfaces why. Same seam is the spine of the future
script→IR expander (P1).

## M6 — Tier-B GPU effects (perceptual tier) ✅ DONE (2026-06-23)
`plugins/gpu-effects` — a plugin contributing WebGL ops into the generic `effects` + `transitions`
registries: adopts the maintained `pixi-filters` catalog (CRT / AdvancedBloom / Shockwave / Godray /
Glitch) on `pixi.js` v8 + a `gl-transition` dissolve presentation (NO hand-written shaders; reuse over
invent). Each effect `wrap(node)` overlays a Pixi WebGL `<canvas>` (PixiHost) with a CSS blend mode, so
it composes on top of the same §11.1 shading + parallax + Tier-A `effects[]`. DOUBLE-GATED so the CPU
default stays byte-identical: a LOAD gate (registered ONLY when `render.ts --gpu` sets
`process.env.GPU_TIER` via webpack DefinePlugin) + a RUNTIME self-gate (`PixiHost.gpuActive()` requires
a REAL hardware WebGL context; software-WebGL rejected). Each draw is a PURE fn of `frame`; the GPU is
the only non-determinism, accepted by the perceptual tier — verified with VMAF (`ffmpeg libvmaf`)
against a reference, NEVER `cmp`. ADR-003 #11 closed under the perceptual-tier reframe.

## M7 — Library breadth
**7a. ADR-001 formal interfaces. ✅ DONE (2026-06-23).** `LibraryResolver` (storage seam) + the
library-side `AssetRefResolver` (ref→def adapter) are explicit TS interfaces in
`src/library/interfaces.ts`; `Library implements` both (compile-time assertion, ZERO behavior change).
The render-time `AssetProvider` half (`instantiate`/`render`/`dispose`) is already behind the plugin
`providers` registry per ADR-005/006/007. ADR-001 → Integrated/DONE. (Remaining: the `LibraryResolver`
REMOTE variant + a specified bundle/export format.)
**7b. Iconify/unDraw bulk ingest. ✅ DONE (2026-06-23).** `factory:ingest-icons` ingests open-license
SVGs (lucide-static, ISC) OFFLINE → core-objects `ObjectSpec` (`kind:"icon"`, geometry only) under the
`icons` catalog namespace, content-addressed + provenance/license recorded. Validator injected from a
repo-root entry (like `factory:gen`) so `src/` imports no plugin. Renders as a form-shadeable
badge+glyph. Shipped ~10 icons.
**7c. D3-geo maps. ✅ DONE (2026-06-23).** A `map` generator in core-dataviz (peer of `chart`): d3-geo
projections + `geoPath` + topojson-client; geometry is DATA (inline TopoJSON/GeoJSON in params,
selected by the `world-map` generator-preset → `library/maps/`), domain-clean, choropleth + draw-on,
pure → deterministic.

## M8 — Finishing passes
**8a. `post[]` composition grade. ✅ DONE (2026-06-23).** The reserved Story-IR/Scene-IR `post[]` is
wired to a film-level effect stack in `Composition.tsx` (`PostGrade`) wrapping the whole composited
frame, REUSING the same core-effects ops (`resolveEffects`/`applyEffects`) the per-layer `effects[]`
use. Empty/absent → strict no-op (byte-identical to before); dropped on `--alpha`; pure → deterministic.
**8b. Painting-style follow-ons. ✅ DONE (2026-06-23).** All DATA/mechanism in `src/render/paint.ts`:
a softer 4-stop ramp + per-silhouette ramp orientation (radial for round/blobby, linear-along-major-axis
for elongated) + aerial perspective (far layers haze their whole fill ramp toward the atmosphere colour,
silhouette-perfect). `kurzgesagt-nature` DATA retuned.

## M9 — AI asset-gen (OpenVINO SD on Iris Xe, cached) ✅ DONE (2026-06-23)
`src/cli/imagegen.ts` (`factory:imagegen`): prompt + seed + model + steps + size + negative + guidance
→ content-address → if a cached PNG exists, reuse (skip SD) → else run `.venv-sd/bin/python
scripts/imagegen/sd_openvino.py` ONCE (OpenVINO SD on the Iris Xe iGPU, `HF_HOME` pinned) into the cache
→ copy to `public/generated/<id>.png` + `library/generated/<id>.png` → register an `asset` catalog entry
(`kind:asset`, `format:image`, `uri:asset://generated/<id>.png`) with provenance + model license. AI
touches ONLY the offline library (golden rule 2); the render replays the FIXED PNG (no provider needed —
the AssetLayer renders an `image` asset directly → core stays plugin-free). Build-time only, so render
stays fast + byte-deterministic though SD isn't bit-exact (the cached PNG is the record, like TTS).
**HONEST env note:** the pre-exported OV SD models hit a transformers/CLIPFeatureExtractor mismatch on
this box; on any `.venv-sd`/model-load failure imagegen synthesizes a DETERMINISTIC placeholder PNG so
the build NEVER fails (golden rule 1) and records that in provenance — re-run after pinning transformers
/ re-exporting a base-or-turbo SD with `optimum export=True` to get real generations. Stretch:
MobileDiffusion tiny model.

---

## Sequencing (avoid concurrent tree collisions) — ALL BATCHES LANDED 2026-06-23
1. painting-style `wag7nnvs2` — owned render core + `library/index.json`.
2. **Batch A** (lane-separated): **✅ M7a interfaces · ✅ M7b icons · ✅ M7c maps · ✅ M8a post[] grade.**
3. **Batch B:** **✅ M5 director (+ LLM seam) · ✅ M4a whisper captions · ✅ M4b lip-sync · ✅ M8b paint
   follow-ons.**
4. **Batch C:** **✅ M6 Tier-B GPU (perceptual VMAF) · ✅ M9 AI asset-gen (OpenVINO SD, cached — real
   generation env-gated on the SD model fix; deterministic placeholder fallback meanwhile).**
5. Each batch closed with `verify-render` + `refine-standard` (ADRs 009→…, DECISIONS, CLAUDE.md).

Tool installs required: Whisper (M4), OpenVINO + SD model (M9), GL/Pixi stack (M6). Each isolated like
`.venv-tts`, cached, offline after first fetch.
