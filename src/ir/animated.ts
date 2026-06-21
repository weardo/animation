// Animated-property convention (Lottie `{a,k}` superset). Spec §6.2.
//
// Every animatable value is expressed as `{ a, k }`:
//   - `a` (animated?): 0 = static, 1 = animated.
//   - `k` (value-or-keyframes): when a=0, the literal value; when a=1, an array of keyframes.
// A keyframe is `{ t, s, e? }`:
//   - `t` = frame number (relative to the scene), `s` = value AT that frame,
//   - `e` = optional easing reference — a *name* into `defs.easings` (StyleKit), so no
//     motion is ever accidentally linear. The easing on keyframe N governs the segment N→N+1.
//
// `animated(valueSchema)` is a generic factory: it builds the discriminated `{a,k}` schema for
// any value type (number, [x,y], color string, path string, …). This is the single source of
// truth — the inferred TS type and the JSON-Schema export both derive from it.

import { z } from 'zod';

/** A name referencing an entry in `defs.easings` (e.g. "smooth", "pop"). */
export const EasingRefSchema = z.string().min(1);
export type EasingRef = z.infer<typeof EasingRefSchema>;

/**
 * A keyframe over an arbitrary value type.
 * `t` = frame, `s` = value at this keyframe, `e` = easing ref for the segment to the next keyframe.
 */
export const keyframe = <V extends z.ZodTypeAny>(value: V) =>
  z
    .object({
      t: z.number(),
      s: value,
      e: EasingRefSchema.optional(),
    })
    .strict();

/**
 * Animated-property factory. Produces the `{a,k}` schema for a given value type.
 * a=0 → k is the literal value; a=1 → k is a non-empty keyframe array.
 *
 * NOTE: kept as a permissive union (not a discriminated union) so callers may author either form;
 * `a` is the authoritative flag the lowering/render passes read.
 */
export const animated = <V extends z.ZodTypeAny>(value: V) =>
  z
    .object({
      a: z.union([z.literal(0), z.literal(1)]),
      k: z.union([value, z.array(keyframe(value)).min(1)]),
    })
    .strict();

/** Convenience: a static-only `{a:0,k:value}` shape, when animation is not allowed. */
export const staticProp = <V extends z.ZodTypeAny>(value: V) =>
  z
    .object({
      a: z.literal(0),
      k: value,
    })
    .strict();

// --- Common value primitives reused across both IRs ---

/** Hex/CSS color string. */
export const ColorSchema = z.string().min(1);
export type Color = z.infer<typeof ColorSchema>;

/** A 2D vector `[x, y]`. */
export const Vec2Schema = z.tuple([z.number(), z.number()]);
export type Vec2 = z.infer<typeof Vec2Schema>;

// --- Concrete animated-property aliases (the ones M1 uses) ---

export const AnimatedNumberSchema = animated(z.number());
export type AnimatedNumber = z.infer<typeof AnimatedNumberSchema>;

export const AnimatedVec2Schema = animated(Vec2Schema);
export type AnimatedVec2 = z.infer<typeof AnimatedVec2Schema>;

export const AnimatedColorSchema = animated(ColorSchema);
export type AnimatedColor = z.infer<typeof AnimatedColorSchema>;

/** A keyframe over numbers (the common case), exported for reuse/tests. */
export const NumberKeyframeSchema = keyframe(z.number());
export type NumberKeyframe = z.infer<typeof NumberKeyframeSchema>;
