# ADR-009 — Painting style = stylekit `paint` DATA + a generic shading mechanism

**Date:** 2026-06-23 · **Status:** Accepted · **Supersedes/extends:** ADR-008 (style is selectable
DATA), §11.1 (Shading & Depth). · **Design:** `docs/superpowers/specs/2026-06-23-painting-style-system-design.md`.

## Context

The factory could place objects and shade them with the §11.1 supporting-shape model (contact shadow,
silhouette rim/AO/glow drop-shadows, a scene light wash), but shapes still read as **flat vector fills**.
The reference look (Kurzgesagt-style nature illustration, `style-ref/pHJIhxZEoxg`) is *painted*:
volumetric form-shading on every shape, disciplined shade-ramps from a limited palette, soft glow on
focal elements, a dark rich atmospheric backdrop with a vignette + focal light pool, and a faint in-fill
texture. The question: is "painting" a per-object capability (a plugin per tree/leaf/flower), or a
**transform over content**?

## Decision

**Painting is a TRANSFORM over content, not a set of objects.** It is delivered as:

1. **StyleKit `paint` DATA** (`src/ir/stylekit.ts` — schema only; VALUES in `library/stylekits/*.json`):
   an OPTIONAL `paint` sub-table — `form{type,lightDeg,shadowL,highlightL,warmHighlight,coolShadow}`,
   `glow{radius,intensity}`, `rim{width,lightL}`, `texture{kind,amount,scale}`,
   `atmosphere{backdrop[],vignette,focal,depthDesaturate}`, `shape{blobiness}`. Absent → flat
   (back-compat); the `NEUTRAL_STYLEKIT` and the default `kurzgesagt` kit carry NO `paint`, so existing
   demos are unchanged.

2. **A generic painting MECHANISM** (`src/render/paint.ts` pure helpers + `src/render/shading.tsx` +
   the `Scene.tsx`/`ShapeLayer.tsx` wrappers) applied uniformly to EVERY shape/asset layer, on top of
   parallax/effects, **gated by `floor.shading`**:
   - **Form-fill:** a solid `fill` token → an SVG linear/radial gradient whose stops are an **AUTO
     shade-ramp** derived from that fill via `culori` (OKLab L±deltas + warm-highlight/cool-shadow hue
     shift), oriented along `lightDeg`. Any content paints volumetric with ZERO per-token authoring.
   - **Rim:** a lighter inner stroke (`rimColor` = the ramp highlight pushed lighter) masked by a
     light-direction gradient so the bright edge sits on the lit side only.
   - **Texture + Glow:** emitted as the **core-effects `grain`/`glow`** ops (seeded deterministically
     from the layer id) through the SAME engine `effects` registry the authored `effects[]` use — paint
     never reimplements glow/grain.
   - **Atmosphere (scene-level):** a dark backdrop gradient + a warm focal pool behind the world
     (`<Atmosphere>`), the existing `<SceneLook>` vignette scaled by `paint.atmosphere.vignette`, and a
     per-layer **depth grade** (`depthGrade`) that darkens/desaturates far (low-parallax) layers toward
     the atmosphere.

3. **AUTO culori ramps** (locked over authored-per-token): a fill is treated as a colour *family*
   (shadow → base → highlight) via culori — the "limited rich palette" look is disciplined ramps, not
   few colours. An optional per-token override is reserved but not required.

## Consequences

- **Build once → every object looks painted.** The content stays dumb (generic ellipses/rects + a
  scatter field); the STYLE carries the look. No per-subject plugin. Proven by the forest-cross-section
  study (`examples/forest-study.yaml`): the same shapes render painted under `kurzgesagt-nature` and
  FLAT under `plain` (`floor.shading` off) — paint is opt-out.
- **Determinism preserved.** culori + SVG gradients + seeded `feTurbulence` are pure functions of
  (fill, light, z, stylekit) — no clock/RNG. The study is **byte-identical across two cold processes**.
- **Standing gates hold.** domain-clean (no subject words in `src/`), style-clean (the painted VALUES
  live in `library/stylekits/kurzgesagt-nature.json`, only the schema + neutral fallback in `src/`),
  delete-the-plugin (effects stay a plugin) — all green.
- **Reuse over invent.** culori does all colour math; core-effects glow/grain are reused, not
  duplicated; `SceneLook`/`light`/`shading` are extended, not replaced.

## Alternatives rejected

- **A per-object painting plugin** (a "tree"/"foliage" provider that paints itself) — re-couples style
  to content, violates ADR-006/007 (core/front-end specialize in nothing) and doesn't scale to arbitrary
  subjects. Rejected: painting is a transform, applied generically.
- **Authored ramps per palette token** — more control, more DATA, and every new colour needs authoring.
  Rejected in favour of AUTO culori ramps (decision locked); a per-token override stays reserved.
