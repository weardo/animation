// Geometry for path-following generators. Spec §10: reuse `d3-shape` for smooth curves through
// moving points and `simplex-noise` for organic bending. Everything here is a PURE function of its
// arguments (seed + frame + params) — no clock, no global state — so the rendered SVG is byte-
// reproducible for a given (seed, frame).
//
// Why we don't use the browser's SVGPathElement.getPointAtLength: the renderer runs the component
// to produce SVG markup deterministically and we want placement math that is testable in plain Node
// (no DOM). We build the chain's control points analytically, bend them with simplex noise, smooth
// them with d3-shape's Catmull-Rom curve, and place beads at the (already smooth) control points —
// which lie ON a Catmull-Rom curve by construction (the curve interpolates its control points).

import { line as d3line, curveCatmullRom, curveCatmullRomClosed } from 'd3-shape';
import { createNoise2D } from 'simplex-noise';
import { mulberry32, mixSeed } from './rng.js';

/** A 2D point. */
export interface Point {
  x: number;
  y: number;
}

/** Parameters controlling the chain's resting layout + per-frame organic bend. */
export interface ChainGeometryParams {
  /** Number of control points (= beads) along the chain. */
  count: number;
  /** Bend amplitude in pixels (sideways simplex displacement). */
  bendAmp: number;
  /** Bend speed in cycles/second (sampled at frame/fps). */
  bendSpeedHz: number;
}

/**
 * The straight resting baseline of the chain: evenly spaced points across the middle of the frame
 * with comfortable horizontal margins. This is the layout used when no explicit path is supplied
 * (M1 has no asset path loader). Pure function of size + count.
 */
export function defaultBaseline(width: number, height: number, count: number): Point[] {
  const marginX = width * 0.12;
  const usable = width - marginX * 2;
  const y = height * 0.5;
  const pts: Point[] = [];
  // Guard count===1 (single bead sits centered) to avoid divide-by-zero.
  const denom = count > 1 ? count - 1 : 1;
  for (let i = 0; i < count; i++) {
    const t = count > 1 ? i / denom : 0.5;
    pts.push({ x: marginX + usable * t, y });
  }
  return pts;
}

/**
 * Bend a baseline of points with seeded simplex noise to get the wavy "axon" shape AT a given frame.
 *
 * The displacement is applied perpendicular to the chain's overall direction (here: vertical, since
 * the baseline runs horizontally), so the chain undulates up/down like a living fibre. Each point
 * samples a 2D noise field at (position-along-chain, time) so neighbours move coherently and the
 * whole wave travels — a pure function of (seed, frame).
 *
 * Endpoints are damped toward zero displacement so the chain stays anchored (a half-sine taper),
 * which reads better than a chain whose ends flap freely.
 */
export function bendPoints(
  baseline: Point[],
  seed: number,
  frame: number,
  fps: number,
  params: ChainGeometryParams,
): Point[] {
  // Seed a dedicated noise field for bending (independent sub-stream from per-bead jitter).
  const noise2D = createNoise2D(mulberry32(mixSeed(seed, 0x6265_6e64))); // "bend"
  const time = (frame / fps) * params.bendSpeedHz;
  const n = baseline.length;

  return baseline.map((p, i) => {
    const along = n > 1 ? i / (n - 1) : 0.5;
    // Endpoint taper: 0 at the ends, 1 in the middle (half-sine) — keeps ends anchored.
    const taper = Math.sin(Math.PI * along);
    // Sample a travelling 2D noise field: x = position along chain, y = time.
    const disp = noise2D(along * 2.0, time) * params.bendAmp * taper;
    return { x: p.x, y: p.y + disp };
  });
}

/**
 * Build a smooth SVG path `d` string through the (already bent) points using d3-shape's
 * Catmull-Rom curve. Catmull-Rom INTERPOLATES its control points, so the beads (placed at those
 * points) sit exactly on the rendered connector. Pure.
 */
export function smoothPath(points: Point[]): string {
  const gen = d3line<Point>()
    .x((p) => p.x)
    .y((p) => p.y)
    .curve(curveCatmullRom.alpha(0.5));
  return gen(points) ?? '';
}

/**
 * A blobby (organic) closed path for one bead, centered at `(cx, cy)` with mean radius `r`.
 *
 * Instead of a perfect circle we sample N vertices around the circle and perturb each vertex radius
 * with seeded simplex noise (modulated over time so the blob gently wobbles). A CLOSED Catmull-Rom
 * curve through the vertices smooths it into an organic blob. This is the spec §10 "blobby wobble"
 * built from `simplex-noise` + `d3-shape` (we keep the dependency surface to libs already in the
 * stack rather than adding `blobshape`, and stay deterministic).
 *
 *  - `blobbiness` 0 ⇒ (near) circle; higher ⇒ stronger radius variation.
 *  - `beadSeed` makes each bead wobble with its own phase (passed by the caller, derived from seed).
 *  Pure function of all arguments.
 */
export function blobPath(
  cx: number,
  cy: number,
  r: number,
  blobbiness: number,
  beadSeed: number,
  frame: number,
  fps: number,
): string {
  // A perfect circle when there is no blobbiness — keeps the cheap/clean case exact.
  if (blobbiness <= 0) {
    return circlePath(cx, cy, r);
  }
  const noise2D = createNoise2D(mulberry32(mixSeed(beadSeed, 0x626c_6f62))); // "blob"
  const segments = 10; // enough vertices for a smooth organic blob, cheap to render
  const wobbleTime = (frame / fps) * 0.6; // slow, calm wobble
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    // Noise sampled on the unit circle (cos,sin) + time → coherent, seamless-around wobble.
    const nx = Math.cos(a);
    const ny = Math.sin(a);
    const wobble = noise2D(nx + wobbleTime, ny - wobbleTime); // [-1, 1]
    const rr = r * (1 + wobble * blobbiness * 0.5);
    pts.push({ x: cx + nx * rr, y: cy + ny * rr });
  }
  const gen = d3line<Point>()
    .x((p) => p.x)
    .y((p) => p.y)
    .curve(curveCatmullRomClosed.alpha(0.5));
  const d = gen(pts);
  return d ? `${d}Z` : circlePath(cx, cy, r);
}

/** An exact circle as an SVG path `d` (two arcs). Pure. */
export function circlePath(cx: number, cy: number, r: number): string {
  return (
    `M ${cx - r} ${cy} ` +
    `a ${r} ${r} 0 1 0 ${r * 2} 0 ` +
    `a ${r} ${r} 0 1 0 ${-r * 2} 0 Z`
  );
}
