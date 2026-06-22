// core-dataviz — tiny pure helpers: a linear scale (d3-scale is NOT a dependency; a linear map is
// trivial and dependency-free) + the draw-on easing/progress math. Pure functions of their inputs —
// no clock, no RNG (CLAUDE.md rule 1: everything is a function of frame).

import type { DrawOn } from './types.js';

/** A linear scale mapping [d0,d1] → [r0,r1], clamped to the range. Pure. (Replaces d3-scaleLinear.) */
export function linearScale(
  d0: number,
  d1: number,
  r0: number,
  r1: number,
): (v: number) => number {
  const dspan = d1 - d0;
  return (v: number): number => {
    if (dspan === 0) return r0;
    const t = (v - d0) / dspan;
    return r0 + t * (r1 - r0);
  };
}

/** Clamp x to [0,1]. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Easing curves for the draw-on ramp. All map [0,1]→[0,1], pure. */
export function ease(kind: DrawOn['easing'], t: number): number {
  const x = clamp01(t);
  switch (kind) {
    case 'linear':
      return x;
    case 'easeOut':
      // cubic ease-out
      return 1 - Math.pow(1 - x, 3);
    case 'easeInOut':
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case 'spring': {
      // A critically-ish damped overshoot, deterministic and bounded near 1 at x=1.
      if (x >= 1) return 1;
      const omega = 8; // angular frequency
      const zeta = 0.45; // damping ratio (<1 → slight overshoot)
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      const env = Math.exp(-zeta * omega * x);
      return 1 - env * Math.cos(wd * x);
    }
    default:
      return x;
  }
}

/**
 * Per-element draw-on progress in [0,1]. Element `index` starts at `delay + index*stagger` and
 * fully draws over `duration` frames, then is shaped by `easing`. Pure function of `frame`.
 */
export function drawProgress(d: DrawOn, frame: number, index: number): number {
  const start = d.delay + index * d.stagger;
  if (d.duration <= 0) return frame >= start ? 1 : 0;
  const raw = (frame - start) / d.duration;
  return ease(d.easing, raw);
}
