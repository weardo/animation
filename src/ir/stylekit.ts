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

// ---------------------------------------------------------------------------------------------------
// PAINT model (Painting Style System design §1) — the OPTIONAL "painting" sub-table that turns a flat
// vector look into the reference's PAINTED look: gradient form-shading (auto shade-ramps), glow, rim,
// in-fill texture, and scene atmosphere. It is style DATA (lives in `library/stylekits/*.json`); the
// render-side MECHANISM (src/render/paint.ts + shading.tsx) reads it. Optional + floor-gated: a kit
// with no `paint` (or `floor.shading=false`) renders FLAT — paint is opt-out, never mandated.
// ---------------------------------------------------------------------------------------------------

/** Gradient FORM-SHADING params: how a solid fill becomes a volumetric ramp (auto-derived via culori). */
export const PaintFormSchema = z
  .object({
    /** 'linear' (ramp along the light) | 'radial' (highlight pools toward the light point). */
    type: z.enum(['linear', 'radial']),
    /** Light direction (screen-space azimuth, deg) the ramp runs along. */
    lightDeg: z.number(),
    /** OKLab L delta on the AWAY side (negative = darker shadow). */
    shadowL: z.number(),
    /** OKLab L delta on the LIGHT side (positive = lighter highlight). */
    highlightL: z.number(),
    /** Hue rotation (deg) of the highlight toward WARM. */
    warmHighlight: z.number(),
    /** Hue rotation (deg) of the shadow toward COOL. */
    coolShadow: z.number(),
  })
  .strict();
export type PaintForm = z.infer<typeof PaintFormSchema>;

/** Soft outer GLOW for `glow`-flagged layers (reuses the core-effects `glow` op). */
export const PaintGlowSchema = z
  .object({ radius: z.number(), intensity: z.number() })
  .strict();
export type PaintGlow = z.infer<typeof PaintGlowSchema>;

/** RIM (edge) light: a lighter inner edge where the light hits. */
export const PaintRimSchema = z
  .object({ width: z.number(), lightL: z.number() })
  .strict();
export type PaintRim = z.infer<typeof PaintRimSchema>;

/** In-fill TEXTURE so fills read as PAINTED, not flat vector (reuses the core-effects `grain` op). */
export const PaintTextureSchema = z
  .object({ kind: z.enum(['grain']), amount: z.number(), scale: z.number() })
  .strict();
export type PaintTexture = z.infer<typeof PaintTextureSchema>;

/** A scene focal-light POOL (a warm wash over the centre of interest). */
export const PaintFocalSchema = z
  .object({
    at: z.enum(['center']),
    color: z.string(),
    radius: z.number(),
    intensity: z.number(),
  })
  .strict();
export type PaintFocal = z.infer<typeof PaintFocalSchema>;

/** Scene-level ATMOSPHERE: a dark backdrop gradient, vignette, focal pool, and depth desaturation. */
export const PaintAtmosphereSchema = z
  .object({
    /** Dark rich base gradient stops (top→bottom). */
    backdrop: z.array(z.string()),
    /** Vignette strength 0..1 (darkened corners). */
    vignette: z.number(),
    /** A focal light pool over the centre. */
    focal: PaintFocalSchema,
    /** Far (low-parallax / high-z) layers → darker + desaturated (atmospheric depth) 0..1. */
    depthDesaturate: z.number(),
  })
  .strict();
export type PaintAtmosphere = z.infer<typeof PaintAtmosphereSchema>;

/** The complete PAINT model carried in `defs.stylekit.paint` (design §1). Every field required once present. */
export const PaintSchema = z
  .object({
    form: PaintFormSchema,
    glow: PaintGlowSchema,
    rim: PaintRimSchema,
    texture: PaintTextureSchema,
    atmosphere: PaintAtmosphereSchema,
    /** Organic-form default for shape primitives (reserved hint; 0 = hard geometry). */
    shape: z.object({ blobiness: z.number() }).strict(),
  })
  .strict();
export type Paint = z.infer<typeof PaintSchema>;

/**
 * A complete StyleKit: a named curve `easings` table + `defaultEasings` (the `defs.easings` seed) +
 * a `palette` token set + the `motion` sub-table + a scene `light` + default `shading` + the `floor`
 * toggles + an OPTIONAL `paint` model (the painted look). This is the shape carried in the Scene IR
 * as `defs.stylekit` and read at render time.
 */
/**
 * Channel BRAND (spec 2026-07-09-india-storyboard): a persistent corner logo BUG + an end-card, plus
 * accent colours for the branded framing. All values are DATA in the stylekit JSON; core owns only this
 * schema + the generic overlay mechanism (src/render/BrandOverlay.tsx). Absent → strict no-op.
 */
export const BrandBugSchema = z
  .object({
    /** Public-relative logo asset (e.g. "brand/india-storyboard-bug.png"), resolved via staticFile. */
    asset: z.string(),
    corner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']).default('top-left'),
    /** Bug width as a percent of frame width. */
    widthPct: z.number().min(2).max(40).default(13),
    opacity: z.number().min(0).max(1).default(0.85),
    /** Margin from the frame edges as a percent of frame width. */
    marginPct: z.number().min(0).max(20).default(4),
  })
  .strict();
export const BrandEndcardSchema = z
  .object({
    enabled: z.boolean().default(true),
    seconds: z.number().min(0.5).max(5).default(1.5),
    /** Full logo asset for the end-card (public-relative). */
    logo: z.string(),
  })
  .strict();
export const BrandAccentSchema = z
  .object({
    headlineUnderline: z.string().optional(),
    captionPill: z.string().optional(),
    captionEdge: z.string().optional(),
  })
  .strict();
export const BrandSchema = z
  .object({
    name: z.string(),
    handle: z.string().optional(),
    tagline: z.string().optional(),
    bug: BrandBugSchema.optional(),
    endcard: BrandEndcardSchema.optional(),
    accent: BrandAccentSchema.optional(),
  })
  .strict();
export type Brand = z.infer<typeof BrandSchema>;

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
    /** OPTIONAL painting model (design §1). Absent → flat (no form-shading/glow/atmosphere). */
    paint: PaintSchema.optional(),
    /** OPTIONAL channel BRAND (India Storyboard spec). Absent → no bug/end-card (strict no-op). */
    brand: BrandSchema.optional(),
  })
  .strict();
export type StyleKit = z.infer<typeof StyleKitSchema>;
