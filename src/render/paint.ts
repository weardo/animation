// Painting mechanism (Painting Style System design §1–§4) — the PURE color/geometry helpers that turn
// a SOLID fill + the resolved `defs.stylekit.paint` model into the "painted" look of the reference
// frames (form-shading gradients, shade-ramps, rim, atmosphere). This module has NO React/Remotion
// dependency and NO domain words — it is the generic STYLE math the renderer applies to any shape.
//
// "Reuse over invent" (CLAUDE.md r.3): all color math goes through `culori` (OKLab/OKLCH ramps), never
// hand-rolled. The grain TEXTURE + the GLOW are reused from the core-effects plugin (built in the
// renderer, not here). Ramps are AUTO-derived from each fill (design decision 1) so ANY content paints
// with zero per-token authoring.
//
// DETERMINISM (CLAUDE.md r.1): every function here is pure — a function of (color, paint, light). No
// clock, no RNG. Same inputs ⇒ same hex strings ⇒ byte-identical SVG/CSS every run (CPU raster).

import { converter, formatHex, interpolate as culoriInterpolate } from 'culori';
import type { Paint, StyleLight as Light } from '../ir/stylekit.js';
import type { Effect } from '../ir/index.js';

const toOklch = converter('oklch');

/** Clamp a number to [lo,hi]. */
function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Shift a color in OKLCH: add `dL` to lightness, rotate hue by `dH` degrees, optionally scale chroma.
 * Returns a #rrggbb hex (deterministic). Falls back to the input on an unparseable color.
 */
export function shade(color: string, dL: number, dH = 0, chromaScale = 1): string {
  const o = toOklch(color);
  if (!o) return color;
  const l = clamp((o.l ?? 0) + dL, 0, 1);
  const h = ((o.h ?? 0) + dH) % 360;
  const c = clamp((o.c ?? 0) * chromaScale, 0, 0.5);
  return formatHex({ mode: 'oklch', l, c, h }) ?? color;
}

/**
 * Mix `color` toward `target` by `t` (0 = color, 1 = target) in OKLab (perceptually even). Returns a
 * #rrggbb. Pure culori. Used for AERIAL-PERSPECTIVE hazing of far layers toward the atmosphere colour.
 */
export function mixToward(color: string, target: string, t: number): string {
  if (t <= 0) return color;
  const tt = clamp(t, 0, 1);
  const mixer = culoriInterpolate([color, target], 'oklab');
  return formatHex(mixer(tt)) ?? color;
}

/**
 * A resolved form-shade ramp. `highlight`/`base`/`shadow` are the limited-palette anchors; `mid` is a
 * MIDTONE between base and shadow (M8b-c: a SOFTER ramp reads less plasticky — the reference's foliage
 * goes highlight → base → midtone → shadow, not a hard two-stop sweep). All are #rrggbb. Warm-light /
 * cool-shadow hue shifts applied.
 */
export interface Ramp {
  highlight: string;
  base: string;
  mid: string;
  shadow: string;
}

/**
 * Derive a shade-ramp from a single fill color via the paint model (design §1, decision 1: AUTO).
 * The HIGHLIGHT is lighter (+`highlightL`) and rotated WARM (`warmHighlight`); the SHADOW is darker
 * (`shadowL`) and rotated COOL (`coolShadow`) — exactly the "limited rich palette" discipline of the
 * reference (lighter-toward-the-light, cooler-in-shadow). The MIDTONE (M8b-c) sits ~45% of the way
 * from base to shadow (a partial L-drop + a partial cool shift) so the falloff is gradual, not a
 * two-stop step. Pure culori math.
 */
export function ramp(color: string, paint: Paint): Ramp {
  const f = paint.form;
  return {
    highlight: shade(color, f.highlightL, f.warmHighlight, 1.04),
    base: color,
    mid: shade(color, f.shadowL * 0.42, f.coolShadow * 0.45, 0.97),
    shadow: shade(color, f.shadowL, f.coolShadow, 0.92),
  };
}

/**
 * The form-shading gradient for a shape, as objectBoundingBox-space endpoints (linear) or a radial.
 * `lightDeg` is the light azimuth (screen-space, y-down, 0=+x): the gradient runs FROM the light side
 * (highlight) TO the away side (shadow). For a radial form the highlight pools at the light-offset
 * centre and falls to shadow at the rim. Returns the geometry + the three ramp stops.
 */
export interface FormGradient {
  type: 'linear' | 'radial';
  /** linear endpoints (objectBoundingBox 0..1). */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** radial focal/centre + radius (objectBoundingBox). */
  cx: number;
  cy: number;
  r: number;
  fx: number;
  fy: number;
  stops: ReadonlyArray<{ offset: number; color: string }>;
}

/**
 * A shape's silhouette hint for PER-SHAPE form-shading (M8b-a). `aspect` = bbox width / height in
 * SCREEN space (so a tall trunk is <1, a wide mound >1). `blobiness` (0=hard geometry, 1=organic) is
 * the resolved `paint.shape.blobiness` the caller may override per shape. Absent → a 1:1 hard shape.
 */
export interface ShapeHint {
  aspect: number;
  blobiness: number;
  /**
   * Effective depth (1 = near, 0 = far). When < 1 the ramp colours haze TOWARD the atmosphere colour
   * (M8b-b aerial perspective), so a far trunk's whole shade-ramp — not just an overlay — desaturates
   * into the backdrop. Absent → near (no haze).
   */
  depth01?: number | undefined;
}

/**
 * The form-shading gradient for a shape (M8b-a: PER-SILHOUETTE, not one global sweep). The light
 * azimuth gives the shade DIRECTION; the shape's own bbox `aspect` re-orients that direction into the
 * shape's objectBoundingBox space so a THIN trunk shades across its true (vertical) major axis instead
 * of being washed by a single global linear sweep, and the highlight pool scales to the shape's size.
 *
 * Mechanism: objectBoundingBox space is the shape's bbox normalised to a unit square, so a screen-space
 * unit light vector (dx,dy) must be DIVIDED by (aspect, 1) to keep its true angle once the box is
 * squashed — without this a vertical light on a 1:8 trunk would still read as a near-horizontal sweep
 * after the box stretch. We then renormalise. ORGANIC shapes (high `blobiness`) bias toward a RADIAL
 * pool (the reference's foliage blobs read as rounded volumes, not flat ramps) regardless of the kit's
 * `form.type`; hard shapes keep the kit's type. A softer 4-stop ramp (highlight→base→mid→shadow).
 */
export function formGradient(
  color: string,
  paint: Paint,
  light: Light,
  hint?: ShapeHint,
): FormGradient {
  let r = ramp(color, paint);
  // M8b-b: aerial perspective — haze the whole ramp toward the atmosphere colour for FAR shapes, so a
  // distant trunk/foliage clump desaturates INTO the backdrop (silhouette-perfect, since it's the
  // fill colour itself, not a rectangular overlay). Strength = how far + the kit's depthDesaturate.
  const depth = hint?.depth01;
  if (depth !== undefined && depth < 0.999) {
    const target = atmosphereTintColor(paint);
    if (target) {
      const t = clamp((1 - clamp(depth, 0, 1)) * (1 - clamp(depth, 0, 1)) * paint.atmosphere.depthDesaturate, 0, 0.7);
      if (t > 0.004) {
        r = {
          highlight: mixToward(r.highlight, target, t),
          base: mixToward(r.base, target, t),
          mid: mixToward(r.mid, target, t),
          shadow: mixToward(r.shadow, target, t),
        };
      }
    }
  }
  // light azimuth: the paint override (design §1 "or inherit stylekit.light" — fall back to the scene
  // light when the kit declares a sentinel <0 to defer to the light).
  const deg = paint.form.lightDeg < 0 ? light.dir : paint.form.lightDeg;
  const rad = (deg * Math.PI) / 180;
  // Screen-space light direction, then mapped into the shape's objectBoundingBox space by the bbox
  // aspect so the ramp follows the shape's OWN major axis (per-silhouette orientation).
  const aspect = hint && hint.aspect > 0 ? hint.aspect : 1;
  let ux = Math.cos(rad) / aspect;
  let uy = Math.sin(rad);
  const mag = Math.hypot(ux, uy) || 1;
  ux /= mag;
  uy /= mag;
  // linear: from the lit side (towards the light) to the away side.
  const x1 = clamp(0.5 + ux * 0.5, 0, 1);
  const y1 = clamp(0.5 + uy * 0.5, 0, 1);
  const x2 = clamp(0.5 - ux * 0.5, 0, 1);
  const y2 = clamp(0.5 - uy * 0.5, 0, 1);
  // radial: pool the highlight slightly toward the light.
  const fx = clamp(0.5 + ux * 0.28, 0, 1);
  const fy = clamp(0.5 + uy * 0.28, 0, 1);
  const stops = [
    { offset: 0, color: r.highlight },
    { offset: 0.34, color: r.base },
    { offset: 0.68, color: r.mid },
    { offset: 1, color: r.shadow },
  ];
  // Organic (blobby) ROUNDED shapes read better as rounded volumes → bias to radial; ELONGATED shapes
  // (a tall trunk / wide bar, aspect far from 1) keep the kit's LINEAR ramp along their major axis so
  // the volume reads as a cylinder, not a sphere. Hard (low-blobiness) shapes always keep the kit.
  const blob = hint?.blobiness ?? paint.shape.blobiness;
  const elongation = Math.max(aspect, 1 / aspect); // 1 = round, >1 = elongated
  const organic = blob >= 0.5 && elongation < 1.7;
  const type = organic ? 'radial' : paint.form.type;
  return { type, x1, y1, x2, y2, cx: 0.5, cy: 0.5, r: 0.72, fx, fy, stops };
}

/** A stable, collision-free gradient id for a layer's form-fill (mirrors ShapeLayer's id convention). */
export function formGradientId(layerId: string): string {
  return `paint-form-${layerId}`;
}

/** The RIM color (a bright inner edge where the light hits) — the ramp highlight pushed lighter. */
export function rimColor(color: string, paint: Paint): string {
  return shade(color, paint.form.highlightL + paint.rim.lightL, paint.form.warmHighlight, 1.0);
}

/**
 * The scene ATMOSPHERE backdrop as a CSS `linear-gradient` (top→bottom) over the paint backdrop stops.
 * Returns undefined when no backdrop is authored (so the caller can skip the layer).
 */
export function backdropGradient(paint: Paint): string | undefined {
  const stops = paint.atmosphere.backdrop;
  if (!stops || stops.length === 0) return undefined;
  if (stops.length === 1) return stops[0];
  const parts = stops.map((c, i) => `${c} ${((i / (stops.length - 1)) * 100).toFixed(0)}%`);
  return `linear-gradient(180deg, ${parts.join(', ')})`;
}

/** A small deterministic integer seed derived from a layer id (FNV-1a) — for the grain noise. */
export function seedFromId(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return Math.abs(h) % 1000;
}

/**
 * The paint-derived `effects[]` entries for a layer — built so they run through the SAME engine
 * `effects` registry (the core-effects `glow`/`grain` ops) the authored `effects[]` use. This is the
 * "reuse core-effects, do not duplicate" path (design §2/§4): paint never re-implements glow/grain; it
 * just emits the registered ops with style-derived params. Returned in apply order (texture, then glow
 * so the bloom sits outside the grained fill). Empty when paint adds nothing.
 *
 *   • TEXTURE → the `grain` op, seeded deterministically from the layer id, clipped to the silhouette.
 *   • GLOW    → the `glow` op (only when `glowFlag`), tinted by the scene light, the bloom under source.
 */
export function paintEffects(
  layerId: string,
  paint: Paint,
  glowFlag: boolean,
  light: Light,
): Effect[] {
  const out: Effect[] = [];
  if (paint.texture.amount > 0) {
    out.push({
      kind: 'grain',
      amount: paint.texture.amount,
      size: paint.texture.scale,
      seed: seedFromId(layerId),
    } as unknown as Effect);
  }
  if (glowFlag && paint.glow.intensity > 0) {
    out.push({
      kind: 'glow',
      color: light.color,
      radius: paint.glow.radius,
      intensity: Math.min(1, paint.glow.intensity),
    } as unknown as Effect);
  }
  return out;
}

/**
 * The DEPTH grade for a layer at parallax/effective-depth `depth01` (0 = far/atmosphere, 1 = near):
 * far layers are darkened + desaturated toward the atmosphere (design §4 "far reads as atmosphere").
 * Returns a CSS `filter` fragment, or undefined when the layer is near enough to need no grade.
 * `depthDesaturate` scales the maximum effect. Pure.
 */
export function depthGrade(depth01: number, paint: Paint): string | undefined {
  const amt = paint.atmosphere.depthDesaturate;
  if (amt <= 0) return undefined;
  const far = clamp(1 - depth01, 0, 1);
  if (far <= 0.001) return undefined;
  // M8b-b: the per-shape ramp now hazes far fills TOWARD the atmosphere colour (which already shifts
  // value), so this outer grade only needs a GENTLE extra desaturate — a heavy brightness cut here on
  // top of the haze crushed dark tokens (trunks) to near-black. Keep saturate, trim brightness.
  const desat = 1 - far * amt * 0.7; // saturate(<1)
  const dark = 1 - far * amt * 0.18; // brightness(<1) — light touch; haze carries the value shift
  if (desat > 0.999 && dark > 0.999) return undefined;
  return `saturate(${desat.toFixed(3)}) brightness(${dark.toFixed(3)})`;
}

/**
 * The mid-tone of the atmosphere backdrop — the colour FAR layers tint toward (aerial perspective).
 * Picks the middle backdrop stop (the body of the gradient, not its dark extremes). Pure; undefined
 * when no backdrop is authored.
 */
export function atmosphereTintColor(paint: Paint): string | undefined {
  const stops = paint.atmosphere.backdrop;
  if (!stops || stops.length === 0) return undefined;
  return stops[Math.floor((stops.length - 1) / 2)] ?? stops[0];
}

