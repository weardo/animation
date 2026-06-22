// Scene IR — concrete, deterministic. JSON = Remotion `inputProps`. Lottie superset. Spec §6.2, §7.
//
// Adopts the `{a,k}` animated-property model (animated.ts) and GSAP-style label positioning.
// Extends Lottie with: camera/parallax, `rig` layers (DragonBones refs), `generator` layers,
// `audio` cues, and morph/effects channels.
//
// M1 IMPLEMENTS the layer types: 'asset' (parallax background), 'rig' (DragonBones ref +
// transform + rig_state.clips), 'generator' (gen + seed + path + params), plus 'shape' (carries
// the morph channel — kept minimal in M1). All fields the spec mentions for later milestones
// (audio[], parts, attach, morph, effects[], post[], stagger, transition_in, light, shading,
// gradient fills, clip layers) are RESERVED here as optional/unused so later milestones need no
// schema migration.

import { z } from 'zod';
import {
  animated,
  AnimatedColorSchema,
  AnimatedNumberSchema,
  AnimatedVec2Schema,
  ColorSchema,
} from './animated.js';

// --- defs ---

/** Palette: token name → color. */
export const PaletteSchema = z.record(ColorSchema);
export type Palette = z.infer<typeof PaletteSchema>;

/**
 * Easings: token name → curve definition.
 * Either a cubic-bezier control array [x1,y1,x2,y2] or a named curve string (e.g. "backOut").
 */
export const EasingDefSchema = z.union([
  z.tuple([z.number(), z.number(), z.number(), z.number()]),
  z.string().min(1),
]);
export type EasingDef = z.infer<typeof EasingDefSchema>;
export const EasingsSchema = z.record(EasingDefSchema);
export type Easings = z.infer<typeof EasingsSchema>;

/** An asset definition (URI + kind). */
export const AssetDefSchema = z
  .object({
    uri: z.string().min(1),
    kind: z.enum(['svg', 'lottie', 'image']),
  })
  .strict();
export type AssetDef = z.infer<typeof AssetDefSchema>;
export const AssetsSchema = z.record(AssetDefSchema);

/** A rig definition. `kind` selects the provider that renders it (spec ADR-001): a vendor
 *  DragonBones skeleton, or a code-only `procedural` character (shape-composition; no vendor mesh). */
export const RigDefSchema = z
  .object({
    uri: z.string().min(1),
    kind: z.enum(['dragonbones', 'procedural']),
    /** For `procedural` rigs: the embedded CharacterSpec (loose here to avoid an ir→factory cycle;
     *  validated by the factory's parseSpec at the compositor). Travels in the Scene IR (shareable). */
    spec: z.record(z.unknown()).optional(),
  })
  .strict();
export type RigDef = z.infer<typeof RigDefSchema>;
export const RigsSchema = z.record(RigDefSchema);

export const DefsSchema = z
  .object({
    palette: PaletteSchema.default({}),
    easings: EasingsSchema.default({}),
    assets: AssetsSchema.default({}),
    rigs: RigsSchema.default({}),
  })
  .strict();
export type Defs = z.infer<typeof DefsSchema>;

// --- config ---

export const SceneConfigSchema = z
  .object({
    w: z.number().int().positive(),
    h: z.number().int().positive(),
    fps: z.number().positive(),
    duration_frames: z.number().int().positive(),
  })
  .strict();
export type SceneConfig = z.infer<typeof SceneConfigSchema>;

// --- camera ---

/** Camera: position (pan) + zoom as animated `{a,k}` props with easing-ref'd keyframes. */
export const CameraSchema = z
  .object({
    position: AnimatedVec2Schema,
    zoom: AnimatedNumberSchema,
  })
  .strict();
export type Camera = z.infer<typeof CameraSchema>;

// --- reserved channels (defined now, unused in M1) ---

/** RESERVED (M2 look): gradient fill spec. */
export const GradientFillSchema = z
  .object({
    type: z.enum(['linear', 'radial']),
    stops: z.array(z.tuple([ColorSchema, z.number()])),
    angle: z.number().optional(),
  })
  .strict();

export type GradientFill = z.infer<typeof GradientFillSchema>;

/** A layer fill: a flat (animated) color or a gradient. */
export const FillSchema = z.union([
  AnimatedColorSchema,
  z.object({ gradient: GradientFillSchema }).strict(),
]);
export type Fill = z.infer<typeof FillSchema>;

/** A shape stroke: color (palette token or hex) + width in px. Both optional. */
export const StrokeSchema = z
  .object({
    color: ColorSchema.optional(),
    width: z.number().nonnegative().optional(),
  })
  .strict();
export type Stroke = z.infer<typeof StrokeSchema>;

/**
 * A shape PRIMITIVE descriptor (ADR-003 #1): a `kind` selecting a `@remotion/shapes` constructor
 * plus its free-form numeric params (validated loosely here; the renderer applies per-kind defaults).
 * Kinds map 1:1 to `@remotion/shapes` makers: rect/circle/ellipse/triangle/star/polygon/pie/heart.
 */
export const ShapePrimitiveSchema = z
  .object({
    kind: z.enum(['rect', 'circle', 'ellipse', 'triangle', 'star', 'polygon', 'pie', 'heart']),
  })
  .passthrough();
export type ShapePrimitive = z.infer<typeof ShapePrimitiveSchema>;

/** Morph channel — animated path `d` strings (interpolated between keyframes with flubber). */
export const MorphChannelSchema = animated(z.string().min(1));

/** RESERVED (M2): a single per-layer effect (glow/drop_shadow/motion_blur/…). Loosely typed. */
export const EffectSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();
export type Effect = z.infer<typeof EffectSchema>;

/** RESERVED (M3): a single composition post-process (color_grade/vignette/grain/bloom/…). */
export const PostSchema = z
  .object({
    kind: z.string().min(1),
  })
  .passthrough();
export type Post = z.infer<typeof PostSchema>;

/** RESERVED (M2): per-layer shading (supporting gradient shapes). */
export const ShadingSchema = z
  .object({
    form: z.boolean().optional(),
    contact_shadow: z.boolean().optional(),
    rim: z.number().optional(),
    ao: z.boolean().optional(),
    glow: z.number().optional(),
  })
  .strict();

/** RESERVED (M2): scene light source. */
export const LightSchema = z
  .object({
    dir: z.number(),
    elevation: z.number(),
    color: ColorSchema,
    intensity: z.number(),
    ambient: z.number(),
  })
  .strict();

/** RESERVED (M2): inter-rig attachment (scene-graph parenting). */
export const AttachSchema = z
  .object({
    to: z.string().min(1),
    bone: z.string().min(1).optional(),
    slot: z.string().min(1).optional(),
    inherit: z.array(z.string()).optional(),
  })
  .strict();

// --- layer transform (used by rig + reusable) ---

export const TransformSchema = z
  .object({
    position: AnimatedVec2Schema.optional(),
    scale: AnimatedNumberSchema.optional(),
    rotation: AnimatedNumberSchema.optional(),
    opacity: AnimatedNumberSchema.optional(),
  })
  .strict();
export type Transform = z.infer<typeof TransformSchema>;

// --- rig_state ---

/** A clip selection on a rig: which internal animation, looped or one-shot at a frame. */
export const RigClipSchema = z
  .object({
    anim: z.string().min(1),
    loop: z.boolean().optional(),
    /** Frame at which this clip starts (relative to scene). */
    at: z.number().optional(),
  })
  .strict();
export type RigClip = z.infer<typeof RigClipSchema>;

export const RigStateSchema = z
  .object({
    clips: z.array(RigClipSchema).min(1),
    /** Optional pose hints (expression etc.) — thin pointer, never re-describes bones. */
    pose: z.record(z.unknown()).optional(),
  })
  .strict();
export type RigState = z.infer<typeof RigStateSchema>;

// --- common layer fields shared by every layer type ---

const layerBase = {
  id: z.string().min(1),
  /** Z-order; higher = front. */
  z: z.number().default(0),
  // --- reserved-now look/effect channels (unused in M1) ---
  effects: z.array(EffectSchema).optional(),
  shading: ShadingSchema.optional(),
  /** RESERVED (M2): cascade offset metadata. */
  stagger: z.number().optional(),
} as const;

// --- M1 layer types ---

/** asset layer: fixed art with a parallax factor (M1 background). */
export const AssetLayerSchema = z
  .object({
    type: z.literal('asset'),
    ...layerBase,
    /** defs.assets key. */
    ref: z.string().min(1),
    /** Parallax factor (0 = static far, 1 = moves with camera). 2.5D depth. */
    parallax: z.number().default(0),
    transform: TransformSchema.optional(),
  })
  .strict();
export type AssetLayer = z.infer<typeof AssetLayerSchema>;

/** rig layer: a DragonBones rig with a transform + rig_state.clips. */
export const RigLayerSchema = z
  .object({
    type: z.literal('rig'),
    ...layerBase,
    /** defs.rigs key. */
    ref: z.string().min(1),
    transform: TransformSchema.optional(),
    rig_state: RigStateSchema,
    // --- reserved compositional fields (M2) ---
    /** Intra-rig variant selection (reserved; M2). */
    parts: z.record(z.string()).optional(),
    /** Inter-rig attachment (reserved; M2). */
    attach: AttachSchema.optional(),
  })
  .strict();
export type RigLayer = z.infer<typeof RigLayerSchema>;

/** generator layer: a procedural component (gen + seed + path + params). */
export const GeneratorLayerSchema = z
  .object({
    type: z.literal('generator'),
    ...layerBase,
    /** Registered generator name (e.g. "bead-string"). */
    gen: z.string().min(1),
    /** Deterministic seed. */
    seed: z.number().int(),
    /** Optional path the generator places along (e.g. "asset://axon.svg#path"). */
    path: z.string().min(1).optional(),
    /** Free-form, generator-specific parameters. */
    params: z.record(z.unknown()).default({}),
    transform: TransformSchema.optional(),
  })
  .strict();
export type GeneratorLayer = z.infer<typeof GeneratorLayerSchema>;

/**
 * shape layer: a first-class vector shape (ADR-003 #1). It carries EITHER a `shape` PRIMITIVE
 * descriptor (a `@remotion/shapes` kind + params → rect/circle/ellipse/triangle/star/polygon/pie/
 * heart) OR a `morph` channel (animated path `d` strings, interpolated with flubber). `fill` is a
 * solid (animated) color or a linear/radial gradient; `stroke` is optional. The `transform` is the
 * standard `{a,k}` position/scale/rotation/opacity. When both `shape` and `morph` are present, the
 * morph (path animation) takes precedence as the rendered geometry.
 */
export const ShapeLayerSchema = z
  .object({
    type: z.literal('shape'),
    ...layerBase,
    /** Primitive descriptor (kind + params) rendered via `@remotion/shapes`. */
    shape: ShapePrimitiveSchema.optional(),
    /** Animated path morph (`d` strings) interpolated with flubber. */
    morph: MorphChannelSchema.optional(),
    fill: FillSchema.optional(),
    stroke: StrokeSchema.optional(),
    transform: TransformSchema.optional(),
  })
  .strict();
export type ShapeLayer = z.infer<typeof ShapeLayerSchema>;

/** Discriminated union of all M1 layer types. */
export const LayerSchema = z.discriminatedUnion('type', [
  AssetLayerSchema,
  RigLayerSchema,
  GeneratorLayerSchema,
  ShapeLayerSchema,
]);
export type Layer = z.infer<typeof LayerSchema>;

// --- reserved: stagger group + transition (defined now, unused in M1) ---

export const StaggerGroupSchema = z
  .object({
    group: z.array(z.string()),
    offset_frames: z.number(),
  })
  .strict();

/**
 * A scene-boundary transition. Expressive by design: a concrete `kind` + passthrough params so the
 * compositor can read kind-specific fields (dir, from/to, match links) without a schema change.
 * Lowers to `@remotion/transitions` (fade/wipe/slide/iris), an SVG mask (mask/shape-reveal),
 * `flubber` (morph-match), or shared-element/camera continuity (match-cut / camera-continuous).
 * Spec §11.2.
 *
 * Common (kind-specific) passthrough params the compositor may use:
 *   - duration (frames)            — transition length
 *   - dir: left|right|up|down      — wipe/slide direction
 *   - from / to (asset or layer id)— morph-match endpoints
 *   - match: { from, to }          — match-cut shared-element link ("L_x@sceneA" → "L_y@sceneB")
 */
export const TransitionSchema = z
  .object({
    /** Transition family. `cut` = hard cut (a zero-length boundary; renders as no effect). */
    kind: z.enum([
      'cut',
      'fade',
      'wipe',
      'slide',
      'iris',
      'mask',
      'morph-match',
      'match-cut',
      'camera-continuous',
    ]),
    /** Direction for directional kinds (wipe/slide). */
    dir: z.enum(['left', 'right', 'up', 'down']).optional(),
    /** Transition length in frames. The compositor overlaps this with the adjacent scene. */
    duration: z.number().int().positive().optional(),
  })
  .passthrough();
export type Transition = z.infer<typeof TransitionSchema>;

// --- scene ---

export const SceneSchema = z
  .object({
    id: z.string().min(1),
    /** Start frame of this scene on the global timeline. */
    at: z.number().int().nonnegative(),
    duration_frames: z.number().int().positive(),
    /** GSAP-style named frame labels (label → frame). */
    labels: z.record(z.number()).default({}),
    camera: CameraSchema,
    layers: z.array(LayerSchema),
    // --- reserved-now (unused in M1) ---
    light: LightSchema.optional(),
    stagger: z.array(StaggerGroupSchema).optional(),
    /**
     * Transition INTO this scene, played at its leading boundary (from the previous scene).
     * The compositor overlaps `transition_in.duration` frames with the previous scene's tail.
     * Omit (or `kind:'cut'`) on the first scene. (Spec §11.2.)
     */
    transition_in: TransitionSchema.optional(),
    /**
     * Transition OUT of this scene, played at its trailing boundary (into the next scene).
     * Redundant with the next scene's `transition_in` but useful when a scene owns its exit
     * (e.g. a morph-match that originates here) or when authoring a scene in isolation. If both a
     * scene's `transition_out` and the next scene's `transition_in` are set, the compositor treats
     * `transition_in` (the inbound side) as authoritative.
     */
    transition_out: TransitionSchema.optional(),
  })
  .strict();
export type Scene = z.infer<typeof SceneSchema>;

// --- reserved: audio cue (defined now, empty in M1; filled by the later TTS pass) ---

export const AudioCueSchema = z
  .object({
    id: z.string().min(1),
    kind: z.string().min(1),
    src: z.string().optional(),
    at: z.number(),
    duration_frames: z.number(),
    transcript: z.string().optional(),
    align: z.array(z.unknown()).optional(),
  })
  .strict();
export type AudioCue = z.infer<typeof AudioCueSchema>;

// --- provenance ---

export const ProvenanceSchema = z
  .object({
    story_ir_hash: z.string().optional(),
    passes: z.array(z.string()).optional(),
  })
  .passthrough();
export type Provenance = z.infer<typeof ProvenanceSchema>;

// --- Scene IR root ---

export const SceneIRSchema = z
  .object({
    scene_ir_version: z.string().default('1.0'),
    config: SceneConfigSchema,
    defs: DefsSchema,
    /** RESERVED (M3): empty in M1, filled by the later TTS pass. */
    audio: z.array(AudioCueSchema).default([]),
    /**
     * The sequenced film: one or more scenes laid out on the GLOBAL timeline. Each scene's `at` is
     * its start frame and `duration_frames` its length; scenes play back-to-back (a scene's
     * `transition_in.duration` overlaps the previous scene's tail). A single-scene film is the M1
     * case and still validates. The lowering pass emits this array from the Story IR beats[], and
     * the compositor sequences it (Remotion `<Series>`/`<TransitionSeries>`).
     */
    scenes: z.array(SceneSchema).min(1),
    /** RESERVED (M3): full-frame post grade. */
    post: z.array(PostSchema).optional(),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();
export type SceneIR = z.infer<typeof SceneIRSchema>;
