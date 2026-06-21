# Factory Decisions Log

Append-only. One entry per significant decision/learning: **Context → Decision → Rationale → (Supersedes?)**. Maintained via the `refine-standard` skill.

---

## 2026-06-22 — Render host: Remotion
**Context:** Need code-driven, deterministic, audio-capable, batch-able rendering with minimal plumbing; solo dev (license a non-issue).
**Decision:** Remotion is the host/orchestrator/encoder; Scene IR is its `inputProps` (no translation layer). Other renderers run *inside* it.
**Rationale:** Built-in deterministic render + audio + FFmpeg mux + batch; most LLM-authorable (React); deletes the need for a custom frame-capture loop.

## 2026-06-22 — Rigs: DragonBones with full mesh deformation
**Context:** Need identity-stable, code-generable skeletal rigs with organic deformation; no editor lock-in / per-seat cost.
**Decision:** Adopt DragonBones JSON format + `pixi-dragonbones` runtime in a Pixi canvas inside Remotion (committed render path), with **full mesh deformation (FFD)** in scope.
**Rationale:** Free/MIT, standard, IK + mesh deform built in; FFD covers bendy/blobby warping. Pixi-canvas chosen over pure-SVG specifically to get mesh deform. Supersedes the earlier "Spine-derived custom schema" idea.

## 2026-06-22 — Scene IR is a Lottie superset; Zod is the single source of truth
**Context:** Avoid inventing an animation IR.
**Decision:** Scene IR adopts Lottie's `{a,k}` property/keyframe model (round-trippable) and extends only where Lottie can't reach (rig refs, camera-parallax, generators, audio, morph/effects). Define all IR in **Zod** → TS types + runtime validation + JSON-Schema (for the future LLM front-end).
**Rationale:** Reuse a Linux-Foundation standard; one definition does three jobs.

## 2026-06-22 — Organic motion via a generator family
**Context:** Keyframes + morph can't express water, fire, neuron bead-strings, crowds.
**Decision:** A `generator` layer family — parametric components, pure functions of `(params+seed+frame)`, in an extensible registry. Water = one generator; neurons = another.
**Rationale:** Don't special-case effects; one mechanism, deterministic, future-proofs fire/smoke/clouds/crowds.

## 2026-06-22 — Library: content-addressed, versioned, lockfile-pinned; fractal reuse
**Context:** Reuse characters/clips/scenes across many videos as the library grows, without changing old videos.
**Decision:** `name@version` → content hash (`object-hash`), `library/index.json` catalog, `animation.lock` pinning. Reusable kinds at every granularity (parts → rigs → presets → clips → scene-templates → videos) via Remotion nested compositions.
**Rationale:** Package-manager patterns (not a custom registry); lockfile reconciles "growing library" with "deterministic renders."

## 2026-06-22 — Effects/post and audio are parallel, event-driven stacks
**Context:** Need After-Effects-style polish and sound design without losing sync.
**Decision:** Layer `effects[]` + composition `post[]` (reuse SVG/Pixi/Remotion FX, `@remotion/transitions`, `@remotion/motion-blur`); audio mixing + SFX-from-animation-events. Both driven by the same animation events. Motion blur is a StyleKit default.
**Rationale:** One event timeline drives picture and sound → coherence; everything reserved-in-IR-now, built M2/M3.

## 2026-06-22 — Shading & Depth is compositional, not post-processing
**Context:** Kurzgesagt depth comes from each object carrying supporting gradient shapes (contact shadow, form shade, rim, AO, glow) consistent with one scene light — not from per-object filters.
**Decision:** Add a Shading & Depth model (spec §11.1): a scene-level `light` as single source + a default-on per-layer `shading` that auto-generates supporting gradient shapes from silhouette + light + `z`; gradients are first-class animatable fills. Reuse SVG gradients/lighting filters + Pixi filters. M2 (look); fields reserved in Scene IR now.
**Rationale:** A single scene light makes the whole scene read as one coherent lit space; auto-derivation avoids hand-authoring shadow shapes (the manual labor we're eliminating). Quality floor → default-on. **Supersedes** the earlier assumption that StyleKit's drop-shadow/glow `effects` filters covered Kurzgesagt depth — they don't.

## 2026-06-22 — Build by milestone; M1 first
**Context:** Avoid building ahead of validated architecture.
**Decision:** M1 = minimal vertical slice proving every seam (script→mp4, DragonBones rig w/ mesh deform + bead-string generator + parallax camera, deterministic render, library+lockfile). M2/M3 staged in spec §15.
**Rationale:** If the M1 clip renders deterministically, the architecture is proven; the rest is feature work.
