# ADR-003 — Content & animation vocabulary: sourcing tiers (A/B)

**Date:** 2026-06-22 · **Status:** Accepted — the standing reuse map for all vocabulary buildout.

## Context

A real editor (DaVinci/Kdenlive/AE) exposes hundreds of transitions, effects, shapes, titles, color tools, etc. We want that breadth **without inventing it**. Almost all of it is available free — from Remotion's own packages and the OSS ecosystem. The deciding constraint for *us* is **determinism** (golden rule #1): DOM/SVG/CSS rendering is byte-deterministic on any GL backend and disk-safe; WebGL/GPU rendering is non-deterministic across runs *and* triggers the software-GL CacheStorage disk-balloon (DECISIONS 2026-06-22).

## Decision

**Our families are sockets; free libraries are plugs.** We do not author hundreds of effects/transitions — we adopt the catalogs and expose them through the channels already designed (`generator`, `effects[]`, `transition`, shape/text layers). Everything is classified into two tiers:

- **Tier A — adopt now (deterministic, disk-safe, DOM/SVG/CSS/CPU).** The default. Build these into the families directly.
- **Tier B — opt-in, gated (free but WebGL/GPU → non-deterministic + disk-balloon risk).** Allowed only behind an explicit flag and only once **deterministic GPU capture** is solved (capped/disabled Chromium cache + accepting/again-pinning GPU output). Until then, Tier B is for non-deterministic previews only.

**Rule:** prefer Tier A. A feature only goes Tier B if it genuinely cannot be done in SVG/CSS/CPU.

## Inventory (editor vocabulary → free source → tier)

| Category | Free source to reuse | Tier |
|---|---|---|
| Shapes (rect/ellipse/star/polygon/pie/heart/path) | `@remotion/shapes` + `@remotion/paths` | **A** |
| Morph / draw-on / path FX | `@remotion/paths` (interpolatePath/evolvePath/warpPath) · `flubber` · GSAP MorphSVG/DrawSVG (free) | **A** |
| Transitions (fade/wipe/slide/clock/flip/iris…) | `@remotion/transitions` (DOM presets + custom presentations) | **A** |
| Transitions ("hundreds", GLSL) | **GL Transitions** (123, free) | **B** (GPU) |
| Filters: blur/glow/shadow/turbulence/displacement/color-matrix/lighting/morphology | native **SVG filters** + CSS filters | **A** |
| Filters: bloom/glitch/CRT/godray/DOF/chromatic-aberration/datamosh | PixiJS filters · pmndrs/postprocessing · `@remotion/skia` shaders | **B** (GPU) |
| Motion: springs/physics/motion-path/stagger/draw-on/noise | Remotion `spring`/`interpolate`/`Series` · `@remotion/motion-blur` · `@remotion/noise` · GSAP (MotionPath/Physics2D/SplitText, free) | **A** |
| Text/titles: fonts/fit/captions/per-char/text-on-path | `@remotion/google-fonts` · `@remotion/layout-utils` · `@remotion/captions` + whisper-cpp · GSAP SplitText | **A** |
| Color/grading: curves/LUTs/palettes | SVG `feColorMatrix`/CSS filters · `culori`/`chroma-js`/`d3-scale-chromatic` | **A** |
| Generators/sources: gradient/noise/particles/waveform/scatter/crowd | our generator family · `@remotion/noise` · tsParticles · `visualizeAudio` | **A** |
| Masks/mattes/compositing: blend modes, track mattes, nesting | SVG mask/clipPath · CSS `mix-blend-mode` · Remotion nested comps (= clips/environments) | **A** |
| Audio: mix/duck/waveform/transcription | `@remotion/media-utils` + `<Audio>` + whisper-cpp | **A** |
| Assets: icons/illustrations/lottie/fonts | Iconify (200k+) · unDraw/Open Peeps/Humaaans · `@remotion/lottie` (LottieFiles) · Google Fonts | **A** |
| Data-viz/maps | D3 · visx · d3-geo/topojson | **A** |
| 3D / alt runtimes | `@remotion/three` · `@remotion/skia` · `@remotion/rive` · `@remotion/gif` | **B** (GPU) / mixed |

## Build backlog (nothing skipped; each = a verified increment)

Each item is built into its family, **adopting the Tier-A source**, and verified per `verify-render` (typecheck + cross-process decoded-stream determinism + visual frames). Tier-B items are deferred behind the GPU-determinism gate.

1. ✅ **Shapes & paths (DONE 2026-06-22)** — adopted `@remotion/shapes` (rect/circle/ellipse/triangle/star/polygon/pie/heart primitives) + `flubber` (path **morph**, differing point counts) + `@remotion/paths` (`getBoundingBox`); first-class `shape` layer in `src/render/ShapeLayer.tsx` with solid/linear/radial **gradient** fill (deterministic `<defs>` ids from layer id), **stroke**, the standard `{a,k}` transform, and a `morph` channel whose `fill` interpolates alongside — all StyleKit-eased (never linear). Wired through `<Scene>` so shapes get parallax + §11.1 shading. Verified per `verify-render`: typecheck clean + byte-identical decoded-stream MD5 across two cold render processes + frames reviewed (`projects/shapes-demo`: primitives + a mid-morph star→heart).
2. **Effects channel** — implement the `effects[]` stack backed by **SVG/CSS filters** (blur, glow, drop-shadow, color-matrix/grade, turbulence/displacement, vignette, grain) + **motion blur** (`@remotion/motion-blur`).
3. **Transitions expansion** — more `@remotion/transitions` presets + match-cut/camera-continuous (§11.2); wrap GL Transitions as a Tier-B presentation set (gated).
4. **Generators expansion** — water, particles, fire/smoke, crowd (procedural) on top of scatter + bead-string.
5. **Text/typography** — `text` layer: fonts (`@remotion/google-fonts`), auto-fit (`@remotion/layout-utils`), kinetic presets (stagger/typewriter/count-up), text-on-path.
6. **Color-script** — palette-per-beat/mood + OKLab interpolation (`culori`); tokens already feed shading/fills.
7. **Asset vocabulary** — object/prop specs in the factory; ingest Iconify/unDraw/Open Peeps + Lottie loops as library entries.
8. **Compositing** — blend modes, track mattes (SVG mask), nested clips/environments (§13.3), attach/parts (§8.1).
9. **Audio (M3)** — TTS + whisper lip-sync + captions + SFX-from-events + mixing.
10. **Data-viz** — chart/map generators (D3/visx) as a generator family member.
11. **Tier-B enablement (gated)** — deterministic GPU capture (capped Chromium cache) → unlock GL Transitions / PixiJS filters / postprocessing / three / skia.

## Consequences

- The vocabulary grows by **adopting catalogs into families**, not authoring effects — fast, free, and consistent with ADR-001 (engine generic; families pluggable).
- Tier-A items are shippable + deterministic immediately; Tier-B is a single future enablement (GPU-determinism) that unlocks a large catalog at once.
- Quick wins flagged: stop hand-rolling shapes (`@remotion/shapes`) and morph (`@remotion/paths`).
