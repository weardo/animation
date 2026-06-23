---
name: building-scenes
description: Use when building, authoring, or organizing a SCENE / film / project in the animation factory — composing objects/rigs, placing or animating them, or deciding where things go. Covers the file roles (story.yaml vs scene.json), the TWO reuse levels (project-local default vs the opt-in shared library), the FOUR separated concerns (definition · composition · animation · film), and the flat-shape Kurzgesagt look. Read it BEFORE creating or editing a project's content so you don't inline-soup objects, dump them in the library, hand-edit compiled output, or mix definition/animation/composition.
---

# Building a scene / working with a project

**A film is ONE project** (`projects/<id>/`). Build the whole scene INSIDE it. NEVER make a project (or a
library entry, or an `examples/` file) per object/component — components live *inside* the film.

## The two files (source → compiled — like `.ts` → `.js`)

- **`story.yaml` = Story IR** — the SEMANTIC source you AUTHOR: `title`, `cast`, `beats[]`, `style`,
  `format`, `music`, `audio`. Hand-written.
- **`scene.json` = Scene IR** — the COMPILED output (Remotion `inputProps`): `config` + `defs`
  (palette/easings/stylekit/assets/rigs/clips) + `scenes[]` (the timeline) + `audio`/`captions`.
  **Machine-generated** by the compiler (`src/pipeline/lower.ts` + passes). **NEVER hand-edit it** — edit
  the source and recompile (`render <story> --project <id>`).
- A film is a **TIMELINE of scenes**: `scenes[]`, each with `at` (global start frame) + `duration_frames`,
  sequenced with transitions. **One beat → one scene.** Many scenes are native — it is NOT one giant scene.

## TWO reuse levels — NEVER conflate (CLAUDE.md golden rule 6)

1. **Project-internal reuse = the DEFAULT** (the After-Effects precomp/asset model): define a unit ONCE in
   the project, instance it many times across its scenes; it stays PART OF the project and never touches
   `library/`. This is the common case.
2. **Shared `library/` = OPT-IN public sharing** (npm-style; `library : project :: npm package : app`):
   reach for it ONLY to deliberately *publish* a unit so OTHER projects import it. Do NOT dump every
   reusable object into `library/`. The `new-library-entry` skill is for this publish path only.

## FOUR separated concerns — author each distinctly, never mixed

Target model + plan: `docs/superpowers/specs/2026-06-23-project-local-four-layer-authoring-design.md`.

1. **DEFINITION** — what an object IS: its parts (a stack of flat shapes / nested sub-rigs) + EXPOSED params
   (e.g. a bird's `headTurn`/`blink`/`beakOpen`). NO placement, NO motion. A reusable **project-local**
   clip/rig def.
2. **COMPOSITION** — staging: which object instances are on screen + WHERE (placement via `transform.position`,
   scale, z) + their INITIAL param values. Not internals, not motion.
3. **ANIMATION** — motion over a scene's local time: keyframes (`{a,k}`) on instances' params/transform + the
   camera. Layered on top of composition. (A static scene build skips this.)
4. **FILM / timeline** — the sequence of scenes + transitions + film-level `audio`/`style`/`format`.

Define an object's **params** so it animates later for FREE (the params are the future keyframe targets) —
do NOT bake motion or placement into an object's geometry.

## How to build a scene (the flow)

1. **Define reusable objects** as project-local clip/rig defs (parts + params) — NOT 30 inline shapes piled
   into one beat ("soup": no reuse, no separation, the anti-pattern). (Project-local clip authoring is the
   in-progress redesign in the spec above; until it lands, still keep objects as clip/`defs.clips` units, not
   inline shape walls.)
2. **Stage** instances: place each with an explicit `position: [x, y]` (pixels, composition coords;
   `[960,540]` = centre) in the shape/clip `args`. An explicitly-positioned layer is left untouched by the
   layout director (it is not "free").
3. **Animate** (later) by adding `{a,k}` keyframes to instances' params/transform + camera.
4. **Sequence** beats → scenes on the timeline with transitions.

## The flat-shape Kurzgesagt look (the default object style)

Objects are STACKS of FLAT-colored shapes — **no gradients on objects, no strokes/outlines.** Volume comes
from 2-3 flat FACETS (base + a lighter lit shape + sometimes a darker shadow shape). **Color CONTRAST**
(complementary / value / warm-cool) separates adjacent shapes and gives the appeal (it replaces outlines).
**Figure-ground:** vivid SATURATED subjects against a DARK, DESATURATED background. **Gradients + blur are
reserved** for the bokeh background + glows ONLY. Author with `style: plain` (flat) + explicit vivid hex
fills. (The `kurzgesagt-nature` `paint` stylekit is the OTHER look — auto gradient form-shading — do NOT use
it for the flat-shape style.)

## Gotchas / rules

- **NEVER hand-edit `scene.json`** — compiled output. Edit the source + recompile.
- **No project-per-object · no `examples/` sprawl · no `library/` entries for project-internal objects.**
- **Cache:** after editing a pipeline pass, bump its `PASS_VERSION` or `rm -rf .cache`; after editing
  `library/*`, clear `.cache` — else a STALE Scene IR is served (your change silently won't take).
- **Determinism:** render with NO gl backend (CPU raster); stills byte-identical across two cold processes.
  Verify FAST on stills (`render <proj> --frames auto`, ~14s) before the slow full video.
- **A static scene build needs NO audio** — don't add narration / `say`.
- **Render-crash ("Target closed" / "browser crashed while rendering frame N"):** Chrome OOM from too many render workers. Render concurrency is now RAM-AWARE (caps workers to free-RAM / ~1.3 GB, min 1) — set `RENDER_CONCURRENCY=N` to override. Stills (`--frames auto`) are single-frame (unaffected); full-video `renderMedia` was the crash-prone path. If it still crashes, free RAM or lower `RENDER_CONCURRENCY`.
- Verify before claiming done → `verify-render`. After a milestone → `refine-standard`.
