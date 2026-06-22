// StyleKit IR schema (ADR-008 I2) — the PURE Zod shape of a selectable "house style", with NO
// runtime/render dependency (no remotion). It lives in the IR layer so the Scene IR can carry the
// resolved stylekit as `defs.stylekit` without the IR depending on the renderer.
//
// The VALUES that fill this shape are library DATA (`library/stylekits/*.json`); the easing HELPER
// functions that turn these curves into Remotion easing fns live in `src/render/stylekit.ts` (which
// re-exports these types). One schema → types + validation (CLAUDE.md golden rule 3).

import { z } from 'zod';

/** A cubic-bezier easing curve tuple [x1,y1,x2,y2] (the Scene-IR `EasingDef` canonical form). */
export const CubicBezierSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);
export type CubicBezier = readonly [number, number, number, number];

/**
 * An easing curve definition: a cubic-bezier tuple OR a known curve NAME (a key into the same
 * `easings` table). Exactly the Scene-IR `EasingDef` union, so stylekit easings round-trip into
 * `defs.easings`.
 */
export const StyleEasingDefSchema = z.union([CubicBezierSchema, z.string().min(1)]);
export type StyleEasingDef = z.infer<typeof StyleEasingDefSchema>;

/** A spring config — field names match Remotion `spring({ config })` so callers spread it directly. */
export const SpringConfigSchema = z
  .object({
    stiffness: z.number(),
    damping: z.number(),
    mass: z.number(),
  })
  .strict();
export type SpringConfig = z.infer<typeof SpringConfigSchema>;

/** Idle micro-motion params (degrees / pixels / Hz / seconds). Drives the always-alive idle layer. */
export const IdleSchema = z
  .object({
    swayAmplitudeDeg: z.number(),
    swaySpeedHz: z.number(),
    driftAmplitudePx: z.number(),
    driftSpeedHz: z.number(),
    saccadeAmplitudeDeg: z.number(),
    saccadeMeanSeconds: z.number(),
  })
  .strict();
export type Idle = z.infer<typeof IdleSchema>;

/** Breathing oscillation: a scale-delta amplitude + a period in seconds. */
export const BreathingSchema = z
  .object({
    amplitude: z.number(),
    periodSeconds: z.number(),
  })
  .strict();
export type Breathing = z.infer<typeof BreathingSchema>;

/** Poisson blink: mean blinks/sec (λ) + eye-closed frame count. */
export const BlinkSchema = z
  .object({
    rateHz: z.number(),
    closeFrames: z.number(),
  })
  .strict();
export type Blink = z.infer<typeof BlinkSchema>;

/** Stagger cascade: per-index reveal delay in frames. */
export const StaggerSchema = z
  .object({
    offsetFrames: z.number(),
  })
  .strict();
export type Stagger = z.infer<typeof StaggerSchema>;

/** Parallax bounds the lite camera pass interpolates between by layer `z`. */
export const ParallaxSchema = z
  .object({
    nearFactor: z.number(),
    farFactor: z.number(),
  })
  .strict();
export type Parallax = z.infer<typeof ParallaxSchema>;

/** The motion sub-table: springs + idle/breathing/blink + stagger/parallax + motion-blur shutter. */
export const StyleMotionSchema = z
  .object({
    spring: SpringConfigSchema,
    springHeavy: SpringConfigSchema,
    springBouncy: SpringConfigSchema,
    idle: IdleSchema,
    breathing: BreathingSchema,
    blink: BlinkSchema,
    stagger: StaggerSchema,
    parallax: ParallaxSchema,
    /** Motion-blur shutter angle, degrees (180° = cinematic). */
    motionBlurShutter: z.number(),
  })
  .strict();
export type StyleMotion = z.infer<typeof StyleMotionSchema>;

/** A scene light source. `dir` is a screen-space azimuth in degrees (0=+x right, 90=down, 270=up). */
export const StyleLightSchema = z
  .object({
    dir: z.number(),
    elevation: z.number(),
    color: z.string(),
    intensity: z.number(),
    ambient: z.number(),
  })
  .strict();
export type StyleLight = z.infer<typeof StyleLightSchema>;

/** Per-object shading toggles/strengths (spec §11.1). */
export const StyleShadingSchema = z
  .object({
    form: z.boolean(),
    contact_shadow: z.boolean(),
    rim: z.number(),
    ao: z.boolean(),
    glow: z.number(),
  })
  .strict();
export type StyleShading = z.infer<typeof StyleShadingSchema>;

/**
 * The quality-FLOOR toggles (ADR-008 I3). Each is a generic mechanism switch the renderer/providers
 * honor — NOT a Kurzgesagt value. A `plain`/technical look turns these OFF for a flat result:
 *   • liveness        — providers run idle + breathe + blink (default-alive). false → static rigs.
 *   • parallax        — per-layer 2.5D camera-follow depth. false → all layers ride the camera flat.
 *   • shading         — the §11.1 compositional shading (contact shadow, rim/AO, scene look). false → none.
 *   • nonLinearMotion — when false, linear easing is allowed (no "never linear" enforcement).
 */
export const FloorSchema = z
  .object({
    liveness: z.boolean(),
    parallax: z.boolean(),
    shading: z.boolean(),
    nonLinearMotion: z.boolean(),
  })
  .strict();
export type Floor = z.infer<typeof FloorSchema>;

/**
 * A complete StyleKit: a named curve `easings` table + `defaultEasings` (the `defs.easings` seed) +
 * a `palette` token set + the `motion` sub-table + a scene `light` + default `shading` + the `floor`
 * toggles. This is the shape carried in the Scene IR as `defs.stylekit` and read at render time.
 */
export const StyleKitSchema = z
  .object({
    /** Named curve table: name → cubic-bezier tuple or another name. */
    easings: z.record(StyleEasingDefSchema),
    /** The subset of `easings` seeded into every Scene IR `defs.easings` (name → tuple/name). */
    defaultEasings: z.record(StyleEasingDefSchema),
    /** Palette tokens (token name → color). */
    palette: z.record(z.string()),
    motion: StyleMotionSchema,
    light: StyleLightSchema,
    shading: StyleShadingSchema,
    floor: FloorSchema,
  })
  .strict();
export type StyleKit = z.infer<typeof StyleKitSchema>;
