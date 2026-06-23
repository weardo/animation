# Scene Reconstruction — c-0016 "Forest Encounter" (caterpillar × bird)

**Date:** 2026-06-23 · **Status:** Proposed (rev. 2 — flat-shape construction + lean build). Rebuild a
simple Kurzgesagt frame (`style-ref/pHJIhxZEoxg/cand/c-0016.jpg`) from our primitives — **recognizable in
our style**, modular so it animates later. This is a SCENE-BUILD (static), not animation; no audio.

## The reference

A foreground **plant** (forked brown branch + 2-tone diagonal-split leaves), a small colorful
**caterpillar** on a leaf, a big **bird** (crimson body, navy wing, pale-blue belly, violet+navy beak,
layered eye) facing it, over a soft out-of-focus **green bokeh** background.

## Construction principle — FLAT SHAPES, stacked (the key style fact)

Kurzgesagt objects are built from **many FLAT-colored shapes layered together**, NOT gradient-shaded blobs:
- **Flat fills only on objects.** Volume/shading comes from STACKING 2-3 flat shapes — a base color + a
  lighter "lit" flat shape + (sometimes) a darker flat shadow shape. E.g. a leaf = a base-green shape + a
  yellow-green LIT half split on a diagonal; a beak = a violet shape + a navy tip shape.
- **No strokes / no hard borders.** Shapes carry NO outline; an edge is just one flat color meeting
  another (or the background). The "midrib" is the seam between two flat shapes.
- **Brilliant, saturated colors** — never dull/muddy.
- **Color CONTRAST does the work of outlines AND the visual appeal.** Adjacent flat regions are kept
  distinct by deliberate contrast — complementary (crimson bird on green), value (navy wing vs crimson
  body), warm/cool (pale-blue belly vs crimson) — so NO stroke is needed and the image pops. The colour
  boundary IS the edge. Rule when authoring a clip: pick each shape's colour to CONTRAST its neighbour,
  not just to be locally "correct."
- **Figure-ground via saturation:** vivid SATURATED subjects sit against a DARKER, DESATURATED bokeh
  background → subjects leap forward. The saturation/value gap is the depth cue (not a gradient).
- **Gradients + blur are RARE and reserved:** only large continuous areas (a sky/BG) + GLOWS + the
  out-of-focus **bokeh** background (a soft blurred green). Objects never use them.

⇒ **Do NOT use the `kurzgesagt-nature` form-shading paint here.** Use a FLAT stylekit (`floor.shading`
off → no auto form-shading / rim / atmosphere) with a **vivid palette** (`library/stylekits/kurzgesagt-flat.json`,
authored as part of this work). The shading is *more flat shapes*, authored in the clip — not a fill effect.

## Modules — each a reusable library `clip` of FLAT shapes (with animation-hook params)

1. **`leaf`** — a base leaf `shape` (flat saturated green, no stroke) + a second flat LIT shape (yellow-green)
   clipped to a diagonal half. Params: `size`, `tilt`, `tone`.
2. **`plant`** — a forked brown branch (a flat `shape` path; optional flat lighter-side shape) + several
   `leaf` clip instances at authored positions/tilts. Params: `sway`, `leafCount`.
3. **`caterpillar`** — N flat rounded segment `shape`s along a gentle arc (each maybe 2 flats for a hint of
   roundness) + a flat head with stacked-circle eyes + antennae. Params: `segments`, `crawl`, `palette`.
4. **`bird`** — stacked flat shapes: crimson body, navy wing, pale-blue belly, beak (violet + navy tip),
   eye (stacked flat circles + a flat highlight). Faces LEFT. Params: `headTurn`, `blink`, `beakOpen`.

Plus the background:

5. **Bokeh BG** — a dark-green base + a `scatter` of soft light-green blobs at low z, heavy core-effects
   **`blur`** (depth-of-field). The one place gradient/blur belongs.

## Scene assembly (`projects/c0016-encounter`)

One beat, ~3-4s, NO audio. Back-to-front: bokeh BG → `bird` (right, facing left) → `plant` (lower-left)
→ `caterpillar` (positioned on a plant leaf via its transform). `style: kurzgesagt-flat`.

## Build process — LEAN (it's a scene build, not animation)

Author each clip, render a quick STILL to eyeball it reads, move on — **no per-object test project with
audio, no narration, no per-module determinism gate.** Order:
1. `kurzgesagt-flat` stylekit (vivid palette, flat) + the **`leaf`** clip (plant depends on it).
2. **`plant`**, **`caterpillar`**, **`bird`** — independent, build in parallel.
3. **Assemble** bokeh BG + the three clips → `c0016-encounter`; render a still; compare to the reference.
   ONE determinism + gates check here (byte-identical stills cross-process, domain-clean, typecheck).
4. Polish palette/positions to "recognizable."

## Reuse, determinism, gates, animation-readiness

- Reuse only: `shape`/@remotion/shapes, `scatter`, core-effects `blur`, the clip pre-comp machinery, the
  flat stylekit palette. No new primitive (assembly exercise). No audio pass runs.
- Determinism: flat shapes + clips are pure → byte-identical stills cross-process (checked once at assembly).
- Domain-clean: `src/` names no `bird`/`caterpillar`/`leaf` — they are library clips + story DATA.
- Animation-ready: each clip's params (`sway`/`crawl`/`headTurn`/`blink`/`beakOpen`) are the future keyframe
  targets, so animating later is additive (`{a,k}` on params + a camera move), no restructuring.

## Out of scope (now)

Animation, audio, pixel-faithful match. This delivers the static modular reconstruction + the param hooks.
