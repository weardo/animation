// Animated-property evaluator — resolve a Scene-IR `{a,k}` property at a frame, with StyleKit easing.
//
// The Scene IR expresses every animatable value as `{ a, k }` (src/ir/animated.ts): a=0 → static
// literal; a=1 → keyframes `[{t,s,e?}]` where `e` names a `defs.easings` curve and governs the
// segment t→t+1. This helper evaluates such a property at a scene-relative frame, resolving the
// easing name through the StyleKit (`easingFn`) so NO segment is ever accidentally linear (spec §9).
//
// PURE / DETERMINISTIC: a function of (prop, frame, easings) only. Reused by <RigLayer> to resolve
// its `transform` channels (position/scale/rotation/opacity) per frame. Kept local to the core-rigs
// plugin; a shared compositor evaluator can later supersede it without changing this API.

import { interpolate } from 'remotion';
import type { Easings } from '../../src/ir/index.js';
import { easingFn, type EasingFunction } from '../../src/render/stylekit.js';

/** The generic `{a,k}` shape this evaluator accepts (number- or vector-valued). */
interface Keyframe<V> {
  t: number;
  s: V;
  e?: string | undefined;
}
interface AnimatedProp<V> {
  a: 0 | 1;
  k: V | Keyframe<V>[];
}

/** Resolve an easing-name against the scene's `defs.easings` (seeded from the stylekit); default smooth. */
function resolveEasing(name: string | undefined, easings: Easings): EasingFunction {
  return easingFn(name ?? 'smooth', easings); // never linear by default (spec §9)
}

/**
 * Locate the active segment for `frame` within a sorted keyframe array.
 * Returns either a single boundary keyframe (hold), or a `[a, b]` pair to interpolate between.
 */
function locate<V>(
  kfs: Keyframe<V>[],
  frame: number,
): { hold: Keyframe<V> } | { a: Keyframe<V>; b: Keyframe<V> } {
  if (kfs.length === 0) throw new Error('animated property has no keyframes');
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (kfs.length === 1 || frame <= first.t) return { hold: first };
  if (frame >= last.t) return { hold: last };
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame >= a.t && frame <= b.t) {
      // Degenerate (equal-t) segment → hold the left value (interpolate requires strictly
      // increasing input).
      if (a.t === b.t) return { hold: a };
      return { a, b };
    }
  }
  return { hold: last };
}

/** Evaluate a scalar `{a,k}` number property at `frame`. */
export function evalNumber(
  prop: AnimatedProp<number> | undefined,
  frame: number,
  easings: Easings,
  fallback: number,
): number {
  if (prop === undefined) return fallback;
  if (prop.a === 0) return prop.k as number;
  const loc = locate(prop.k as Keyframe<number>[], frame);
  if ('hold' in loc) return loc.hold.s;
  return interpolate(frame, [loc.a.t, loc.b.t], [loc.a.s, loc.b.s], {
    easing: resolveEasing(loc.a.e, easings),
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
}

/** Evaluate a `{a,k}` vec2 property `[x,y]` at `frame`. */
export function evalVec2(
  prop: AnimatedProp<[number, number]> | undefined,
  frame: number,
  easings: Easings,
  fallback: [number, number],
): [number, number] {
  if (prop === undefined) return fallback;
  if (prop.a === 0) return prop.k as [number, number];
  const loc = locate(prop.k as Keyframe<[number, number]>[], frame);
  if ('hold' in loc) return loc.hold.s;
  const easing = resolveEasing(loc.a.e, easings);
  const x = interpolate(frame, [loc.a.t, loc.b.t], [loc.a.s[0], loc.b.s[0]], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const y = interpolate(frame, [loc.a.t, loc.b.t], [loc.a.s[1], loc.b.s[1]], {
    easing,
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return [x, y];
}
