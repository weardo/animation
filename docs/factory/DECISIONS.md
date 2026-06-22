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

## 2026-06-22 — Software GL (swiftshader) balloons the disk; use 'angle' for procedural scenes
**Context:** Renders filled the root partition (~26GB) then crashed, then freed — for both the user and the agent. Root cause: `chromiumOptions.gl: 'swiftshader'` (software renderer) ballooned Chromium's Service-Worker **CacheStorage** to ~26GB during render, held open in the chrome temp profile (released on process death → the "fills then frees" symptom). Caught by monitoring `df` live during a render and killing before crash.
**Decision:** Use `gl: 'angle'` (hardware) for the render. Procedural characters are pure SVG/DOM, so determinism is DOM-based (not GL-based) — 'angle' is byte-identical across cold runs AND fast (~28s vs crash). Verified: two renders decoded-MD5 identical, disk flat at 31G. Software GL was only needed for WebGL/DragonBones FFD determinism — another reason to prefer the procedural provider. A future WebGL-determinism need must first solve the cache bloat (capped/disabled Chromium cache).
**Process lesson (→ verify-render):** when a render hangs/crashes, monitor `df -h /` live; "fills then frees on crash" = a process holding large unlinked temp open. Orphaned renders survive killing the npm wrapper — `pkill -9 -f compositor-linux`/`chrome-headless` too.

## 2026-06-22 — blip rebuilt procedurally; first real "procedural" provider (ADR-001)
**Context:** The code-generated DragonBones `blip` rendered broken — the FFD body mesh collapsed to a wedge and limbs misaligned. The *procedural art* (atlas parts) was actually clean; the breakage was 100% in the DragonBones skeleton/FFD assembly (hand-synthesizing a vendor mesh without the editor is brittle).
**Decision:** Implement the ADR-001 `procedural` rig kind: `RigDef.kind` enum (`dragonbones|procedural`), library `format` → provider in `toRigDef`, and Scene.tsx dispatches to `<ProceduralRig>` (pure-SVG primitive-shape character, idle/breathe/blink/wave) vs `<RigLayer>` (DragonBones). `blip` is now procedural (`proc://blip`); removed the broken DragonBones blip files + `gen-blip-rig.mjs` + FFD probes. Procedural rigs are deterministic-by-construction AND fast (no Pixi/WebGL/swangle). Visually verified clean; frame byte-identical across processes.
**Process lessons (→ verify-render skill):** (1) ALWAYS look at a frame — determinism ≠ correctness (I called the broken blip "verified" off determinism alone). (2) Remotion caches the webpack bundle — `rm -rf node_modules/.cache .remotion` if a code change doesn't show. (3) The pipeline Scene-IR cache key omits library state — `rm -rf .cache` after library/provider changes.

## 2026-06-22 — M2.1 Shading & Depth compositor implemented (foreground, not workflow)
**Context:** The M2 workflow stalled with slow render/verify loops (6–10 min idles); finished M2.1 in the foreground instead.
**Decision:** Shading lives in `src/render/shading.tsx` (`SceneLook`, `ContactShadow`, `objectFilter`, resolvers) + `Scene.tsx`. Scene `light` defaults on (StyleKit `DEFAULT_LIGHT`); per-layer `shading` defaults on (`DEFAULT_SHADING`), background-exempt. Components: directional light wash + vignette (screen-space), per-object contact shadow (camera-tracked), silhouette-following rim/AO/glow via CSS `drop-shadow` (works on SVG layers AND the Pixi canvas). Visually verified on `blip`; a shaded frame is byte-identical across two separate processes (determinism held — static styles + deterministic anchor).
**Deferred (honest):** true per-silhouette form-shade overlay (approximated by the scene wash + rim for now); gradient fills (typed, not yet rendered); far-layer atmospheric tint. **Process lesson:** a tight build→render→look loop is far faster in the foreground than in a render-heavy background workflow (logged under ADR/standard).

## 2026-06-22 — Shading & Depth is compositional, not post-processing
**Context:** Kurzgesagt depth comes from each object carrying supporting gradient shapes (contact shadow, form shade, rim, AO, glow) consistent with one scene light — not from per-object filters.
**Decision:** Add a Shading & Depth model (spec §11.1): a scene-level `light` as single source + a default-on per-layer `shading` that auto-generates supporting gradient shapes from silhouette + light + `z`; gradients are first-class animatable fills. Reuse SVG gradients/lighting filters + Pixi filters. M2 (look); fields reserved in Scene IR now.
**Rationale:** A single scene light makes the whole scene read as one coherent lit space; auto-derivation avoids hand-authoring shadow shapes (the manual labor we're eliminating). Quality floor → default-on. **Supersedes** the earlier assumption that StyleKit's drop-shadow/glow `effects` filters covered Kurzgesagt depth — they don't.

## 2026-06-22 — Object detail is a render-budget problem; split by behavior
**Context:** Kurzgesagt objects are hundreds of tiny shapes each. Treating all detail as live SVG DOM would crater laptop render times.
**Decision:** Add a `scatter` generator for procedural detail (seeded, poisson-disc) and a detail×performance strategy (spec §10.1): bake static high-count detail (cached/content-hashed), Pixi `ParticleContainer` for animated high-count, `<symbol>`/`<use>` for motifs, bake surface-bound detail into rig textures (deforms via FFD), and a per-scene shape budget with logging (no silent truncation). Added as risk #6.
**Rationale:** Detail density is a rendering-budget question, not an art one; splitting by behavior keeps it deterministic and laptop-viable. Authored multi-shape assets already work; the strategy is M2 + ongoing.

## 2026-06-22 — Deterministic WebGL render recipe (corrects the M1 spike)
**Context:** M1 built and self-reported "byte-identical determinism PASS." Independent cross-run verification (a fresh render in a new process, comparing the *decoded video stream*) found the opposite: ~all frames differed with hardware GL, then ~3/150 differed after switching GL — the in-session check only compared two back-to-back renders, which masked it.
**Decision:** The verified recipe for byte-identical Pixi/DragonBones output across cold runs is: (1) `chromiumOptions.gl: 'swangle'` (software SwiftShader — hardware `'angle'` is non-deterministic across runs), (2) `preserveDrawingBuffer: true` on Pixi init, (3) **synchronous** `continueRender` after `app.render()` (rAF gating fights Remotion's frame clock). Result: two cold renders byte-identical, 0/150 frames differ.
**Rationale:** GPU float variance + a paint-commit race were the two non-determinism sources. **Supersedes** the spike's "angle + rAF retires the determinism risk" claim.
**Process lesson (→ verify-render skill):** test determinism across SEPARATE process invocations and compare the DECODED VIDEO STREAM (`ffmpeg -map 0:v -f md5`), not the container (it carries a wall-clock `creation_time`). Updated the skill accordingly.

## 2026-06-22 — Visual-language systems: transitions/match-cuts, kinetic typography, color-script
**Context:** Kurzgesagt storytelling relies on seamless idea-to-idea transitions (match-cuts), bold animated text, and an emotional color arc across beats.
**Decision:** Add three first-class systems (spec §11.2–11.4): (1) transitions incl. `morph-match`, `match-cut` (shared element continuity via `match:{from,to}`), and `camera-continuous` — reuse `@remotion/transitions` + `flubber`; (2) a `text` layer (split from `asset`) with kinetic-reveal presets, auto-fit (`@remotion/layout-utils`), count-up, and later narration sync (Whisper + `@remotion/captions`); (3) a color-script where Story-IR beats carry `mood`/`palette`, Scene-IR palette tokens are the single source for all fills/gradients/`light.color`, and palettes interpolate across transitions in OKLab (`culori`/`d3-interpolate`).
**Rationale:** All three generalize existing mechanisms (transitions/morph, layers+stagger, palette tokens) rather than adding subsystems; reuse-first; deterministic. M2 (M3 for narration-synced text). Fields reserved in IR now.

## 2026-06-22 — Build by milestone; M1 first
**Context:** Avoid building ahead of validated architecture.
**Decision:** M1 = minimal vertical slice proving every seam (script→mp4, DragonBones rig w/ mesh deform + bead-string generator + parallax camera, deterministic render, library+lockfile). M2/M3 staged in spec §15.
**Rationale:** If the M1 clip renders deterministically, the architecture is proven; the rest is feature work.
