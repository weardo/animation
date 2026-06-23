# Scene Reconstruction — c-0016 "Forest Encounter" (caterpillar × bird)

**Date:** 2026-06-23 · **Status:** Proposed (for review before implementation). The first real *scene*
reconstruction: take a simple Kurzgesagt frame (`style-ref/pHJIhxZEoxg/cand/c-0016.jpg`) and rebuild it
from our primitives + factories — **recognizable in our style** (not a pixel-match), with **proper
modularity so it animates later**.

## The reference

A character close-up: a foreground **plant** (forked brown branch + 2-tone diagonal-split leaves) on the
lower-left; a small colorful **caterpillar** perched on a leaf; a large **bird** (red head/body, blue
wing, light belly, purple beak, layered eye) entering from the right, facing the caterpillar; all over a
soft out-of-focus **green bokeh** background.

## Principle — the scene is an ASSEMBLY of reusable modules, not one monolithic drawing

Fidelity target: *recognizable composition + palette + style*, our shapes. Each subject is a reusable
library **`clip`** (a nested pre-composition with declared `params`) so it (a) reads as one unit, (b)
recomposes/instances elsewhere, and (c) exposes **animation hooks** (params we keyframe later). Build the
clips first (each verifiable in isolation), then assemble the scene, then (a later milestone) animate.

## Modules (each a reusable library `clip`, painted by the `kurzgesagt-nature` stylekit)

1. **`leaf`** — one 2-tone form-shaded leaf (an organic blob `shape` with a diagonal lighter highlight
   half + a stroke). Params: `size`, `tilt`, `tone` (palette token). The atomic unit the plant reuses.
2. **`plant`** — a forked brown branch (`shape` path, tapering) + several `leaf` clip instances at
   authored positions/tilts. Params: `sway` (later → a gentle rotation of the whole clip), `leafCount`.
3. **`caterpillar`** — a body of N rounded **segment `shape`s** in a row along a path (NOT the removed
   bead-string — explicit shape segments so we fully control silhouette + crawl) + a head `shape` with
   eyes (layered circles) + antennae (`shape`). Params: `segments`, `crawl` (phase → later a travelling
   undulation + along-leaf translate), `palette`.
4. **`bird`** — a shape-composite head/body: body (`shape`), wing (`shape`, overlaid), belly (`shape`),
   beak (elongated `shape`), eye (layered circles + highlight). Params: `headTurn`, `blink`, `beakOpen`
   (all later animation hooks; static defaults now). Built as a clip of stacked shapes for a precise
   silhouette (vs the generic blob-creature provider — noted as an alternative if we want built-in
   liveness later).

Plus a non-clip background layer:

5. **Bokeh BG** — a dark-green vertical gradient base (`asset`/`shape`) + a `scatter` of large soft
   light-green blobs at low z, with a heavy **`blur` effect** (core-effects) → depth-of-field. Params
   live in the scatter args + the blur radius.

## Scene assembly (`projects/c0016-encounter`)

A single-beat story that places, back-to-front: bokeh BG (z 0, parallax ~0.2) → `bird` clip (right, mid
z) → `plant` clip (lower-left, near z) → `caterpillar` clip (simply POSITIONED on a plant leaf via its
transform; `attach` mounts are for rig channels and aren't needed here). Style `kurzgesagt-nature`. No narration/audio yet
(scene-only). A later pass adds camera + the per-clip animation params + maybe a line of `say`.

## Build order (step by step — render-verify each on stills before moving on)

1. **`leaf` clip** → a tiny test scene of 3 leaves at different tilts. Verify form-shading + the 2-tone split read.
2. **`plant` clip** (branch + leaf instances) → verify the plant reads.
3. **`caterpillar` clip** (segments + face) → verify on a plain bg.
4. **`bird` clip** (composite shapes) → verify the silhouette reads.
5. **Assemble** the bokeh BG + all three clips into `c0016-encounter` → compare to the reference frame.
6. **Polish** palette/positions/depth to "recognizable"; (later milestone) animate the param hooks + camera.

## Determinism, reuse, gates

- Each clip is a library entry (content-addressed, cataloged, lockable) per `new-library-entry`; instances
  get id-namespacing + seed derivation (existing clip machinery) → deterministic.
- Reuse: `shape` (`@remotion/shapes`/paths), `scatter` generator, `blur` effect (core-effects), the clip
  pre-comp machinery, the `attach` mount, the `kurzgesagt-nature` paint. No new primitive is needed —
  this is an *assembly* exercise (the point: prove the factory composes a real scene).
- Gates (`verify-render`): CPU-raster byte-identical across cold processes; domain-clean (no "bird"/
  "caterpillar" hardcoded in `src/` — they're library clips + story data); typecheck; the clips render
  in isolation AND assembled.
- Animation-readiness: every subject is a clip with named `params` that are the future keyframe targets
  (sway/crawl/headTurn/blink/beakOpen) — so "animate it later" is adding `{a,k}` to those params + a camera
  move, no restructuring.

## Out of scope (now)

Animation itself (this delivers the static, modular reconstruction + the param hooks); audio; a
pixel-faithful match. Those are follow-on steps once the assembly reads right.
