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

import { converter, formatHex } from 'culori';
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

/** A resolved form-shade ramp: highlight → base → shadow (#rrggbb), warm light / cool shadow applied. */
export interface Ramp {
  highlight: string;
  base: string;
  shadow: string;
}

/**
 * Derive a shade-ramp from a single fill color via the paint model (design §1, decision 1: AUTO).
 * The HIGHLIGHT is lighter (+`highlightL`) and rotated WARM (`warmHighlight`); the SHADOW is darker
 * (`shadowL`) and rotated COOL (`coolShadow`) — exactly the "limited rich palette" discipline of the
 * reference (lighter-toward-the-light, cooler-in-shadow). Pure culori math.
 */
export function ramp(color: string, paint: Paint): Ramp {
  const f = paint.form;
  return {
    highlight: shade(color, f.highlightL, f.warmHighlight, 1.04),
    base: color,
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

export function formGradient(color: string, paint: Paint, light: Light): FormGradient {
  const r = ramp(color, paint);
  // light azimuth: the paint override (design §1 "or inherit stylekit.light" — fall back to the scene
  // light when the kit declares a sentinel <0 to defer to the light).
  const deg = paint.form.lightDeg < 0 ? light.dir : paint.form.lightDeg;
  const rad = (deg * Math.PI) / 180;
  const dx = Math.cos(rad);
  const dy = Math.sin(rad);
  // linear: from the lit side (towards the light) to the away side.
  const x1 = 0.5 + dx * 0.5;
  const y1 = 0.5 + dy * 0.5;
  const x2 = 0.5 - dx * 0.5;
  const y2 = 0.5 - dy * 0.5;
  // radial: pool the highlight slightly toward the light.
  const fx = clamp(0.5 + dx * 0.28, 0, 1);
  const fy = clamp(0.5 + dy * 0.28, 0, 1);
  const stops = [
    { offset: 0, color: r.highlight },
    { offset: 0.45, color: r.base },
    { offset: 1, color: r.shadow },
  ];
  return { type: paint.form.type, x1, y1, x2, y2, cx: 0.5, cy: 0.5, r: 0.72, fx, fy, stops };
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
  const desat = 1 - far * amt; // saturate(<1)
  const dark = 1 - far * amt * 0.5; // brightness(<1)
  if (desat > 0.999 && dark > 0.999) return undefined;
  return `saturate(${desat.toFixed(3)}) brightness(${dark.toFixed(3)})`;
}
