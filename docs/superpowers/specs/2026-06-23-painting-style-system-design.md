# Painting Style System — Design

**Date:** 2026-06-23 · **Status:** DONE (implemented + verified; see ADR-009). The "muscle": a
subject-independent **construction/painting style** that makes any shapes read like the reference
(Kurzgesagt-style nature illustration, ref `style-ref/pHJIhxZEoxg`).

> **Implemented (2026-06-23):** the `paint` schema (`src/ir/stylekit.ts`, optional, off in
> `NEUTRAL_STYLEKIT`/default `kurzgesagt`); the generic mechanism in `src/render/paint.ts` (AUTO culori
> ramps, form-gradient, rim, depth grade, paint→effects bridge) + `shading.tsx` (`<Atmosphere>` backdrop
> + focal, vignette scaling) + `Scene.tsx`/`ShapeLayer.tsx` wrappers (form-fill, rim stroke, paint
> effects, depth grade), all gated by `floor.shading`; the `kurzgesagt-nature` stylekit DATA
> (`library/stylekits/kurzgesagt-nature.json`, registered in `library/index.json`). Study:
> `examples/forest-study.yaml` (+ `forest-study-plain.yaml`). **Verified:** byte-identical cross-process,
> paint visibly applied, `plain` renders flat, all gates green, m2-demo unaffected. Decisions locked as
> recommended: AUTO culori ramps · grain in the MVP · forest-cross-section study.

## Principle — style is a TRANSFORM over content, not a set of objects

The branch / cell / sun / bird are **content** (object/rig declarations we already make). What we're
after is *how any of them is painted*: gradient form-shading, palette shade-ramps, glow, atmospheric
depth, organic forms. So this is **stylekit DATA (a `paint` model) + a generic painting MECHANISM**
(the §11.1 shading layer, enriched) applied to *every* shape — **not** a per-object plugin. Build it
once → every object we have instantly looks like the reference; the content stays dumb, the style does
the work. (ADR-008: style is selectable data; this enriches the stylekit's shading model.)

## What "painting" is (decomposed from the reference frames)

1. **Form-shading** — no flat fills. Each shape carries an internal gradient: lighter toward the light,
   darker on the far side → volume. (foliage blobs, grass mounds, trunks, mushroom caps.)
2. **Shade-ramps** — a fill color is used as a *family*: shadow → base → highlight (+ a glow tint).
   The "limited palette" look is disciplined ramps, not few colors.
3. **Glow / luminance** — soft outer halo on focal/bright elements (mycelium, vessels, god-rays, pills)
   against a dark base.
4. **Atmosphere (scene-level)** — dark rich gradient backdrop, vignette, a focal light pool, far layers
   darker/desaturated (depth).
5. **Rim light** — a lighter edge where light hits (trunk/cap edges).
6. **Organic shape language** — soft blobby curves, tapering; no hard geometry.
7. **Subtle in-fill texture** — faint grain/stipple so fills read as *painted*, not flat vector.

## 1. StyleKit `paint` model (DATA — `src/ir/stylekit.ts`, carried in `defs.stylekit`)

```jsonc
"paint": {
  "form": {                      // gradient form-shading
    "type": "linear",            // 'linear' (along light) | 'radial' (from a light point)
    "lightDeg": 115,             // light direction (or inherit stylekit.light)
    "shadowL": -0.16,            // OKLab L delta on the away side (darker)
    "highlightL": 0.12,          // OKLab L delta on the light side (lighter)
    "warmHighlight": 6, "coolShadow": -4   // optional hue rotation (warm light / cool shadow)
  },
  "glow":  { "radius": 14, "intensity": 0.7 },      // soft outer glow (for `glow`-flagged layers/tokens)
  "rim":   { "width": 2, "lightL": 0.18 },           // edge light
  "texture": { "kind": "grain", "amount": 0.06, "scale": 1.4 },  // subtle in-fill noise
  "atmosphere": {
    "backdrop": ["#1a0f33", "#0a0a18"],              // dark rich base gradient (top→bottom)
    "vignette": 0.35,
    "focal":   { "at": "center", "color": "#3a2a66", "radius": 0.6, "intensity": 0.5 },
    "depthDesaturate": 0.4                            // far (low-parallax / high-z) layers → darker+desat
  },
  "shape": { "blobiness": 0.3 }                       // organic-form default for shape primitives
}
```
Ramps are **auto-derived from each fill color via `culori` (OKLab L±deltas + hue shift)** — so ANY
color/content paints with zero per-token authoring; an optional `ramps: { token: {...} }` can override a
specific token by hand. (Reuse-over-invent: `culori` does the color math; never hand-rolled.)

## 2. The painting MECHANISM (generic — `src/render/shading.tsx` + a `paint.ts` helper)

Applied uniformly in the LayerView wrapper, on top of the existing parallax/effects, **gated by
`floor.shading`** (so `style: plain` stays flat). Pure functions of (fill, light, z, stylekit) — no
clock/RNG → deterministic, CPU-raster, byte-identical.

- **Form-fill:** a SHAPE/asset layer's solid `fill` token → an SVG `<linearGradient>` (along `lightDeg`)
  or `<radialGradient>` whose stops are `ramp(fill)` (highlight L+, base, shadow L−, via culori). The
  shape paints itself volumetric. Deterministic gradient ids from the layer id.
- **Glow:** for `glow`-flagged layers (or glow tokens), reuse the **core-effects `glow`** op (SVG
  feGaussianBlur+feColorMatrix) — not reimplemented.
- **Rim:** a lighter inner stroke derived from the ramp highlight.
- **Texture:** a faint `feTurbulence` overlay clipped to the shape (reuse core-effects `grain`), low
  opacity — the painted feel.
- **Atmosphere (scene-level, in `Scene.tsx`):** a backdrop gradient layer, a vignette + focal-light
  wash (extend the existing `SceneLook`), and a depth grade that darkens/desaturates layers by their
  parallax/z so far reads as atmosphere.

## 3. Coverage

- **MVP:** SHAPE + ASSET layers (form-fill + rim + texture) · layer GLOW · scene ATMOSPHERE. These hit
  most of the look (the reference is mostly shapes + scatter on an atmospheric ground).
- **Generators** draw many internal shapes, so they can't be auto-form-shaded from outside; instead a
  generator OPTS IN by reading `defs.stylekit.paint` and ramping its own fills (a small per-generator
  follow-on — scatter/foliage/branch first). The scene atmosphere + glow already apply to them as
  layers.

## 4. Determinism, reuse, gates

- Pure: ramps (culori), gradients (SVG), texture (seeded feTurbulence) — all functions of data, no
  clock/RNG. CPU raster → byte-identical cross-process (the standing gate).
- Reuse: `culori` (ramps), core-effects `glow`/`grain` (don't duplicate), the existing `light`/`shading`
  + `SceneLook` (extend, not replace). Never reimplement a Remotion primitive.
- Standing gates hold: domain-clean (no subject words), style-clean (values live in `library/stylekits/
  *.json`, only schema + neutral fallback in `src/`), delete-the-plugin (effects stay a plugin).
- Floor toggle: `paint` respects `floor.shading` — `style: plain` = flat, unpainted.

## 5. Validation — the study (style does the work, content is dumb)

Author a trivial scene: a few **blob shapes** + a **scatter field** + (optionally) a branch *as just an
object* + a `kurzgesagt-nature` stylekit (this `paint` model). Render it and compare to the reference
frames — it should read as a painted nature scene **purely from the style**, with deliberately dumb
content. Success = the painting style, not the objects, carries the look. Byte-identical cross-process.

## 6. Decisions for you

1. **Shade ramps:** AUTO-derive per fill via culori (zero authoring, any content paints) [recommended]
   vs AUTHORED ramps per palette token (more control, more data).
2. **Texture in the MVP:** include a subtle grain now (closer to the painted look) [recommended] vs
   defer (form-shading + glow + atmosphere first, texture later).
3. **First validation target:** the **forest cross-section** (frames c-0008/0017 — form-shaded blobs +
   scatter + atmosphere, broad style coverage) [recommended] vs the **glowing underground** (c-0096/0037
   — heavier on glow + dark atmosphere).
