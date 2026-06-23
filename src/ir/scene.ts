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
import { StyleKitSchema } from './stylekit.js';

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

/** An asset definition (URI + kind). `video`/`lottie` back a `footage` layer (frame-seeked playback). */
export const AssetDefSchema = z
  .object({
    uri: z.string().min(1),
    kind: z.enum(['svg', 'lottie', 'image', 'video']),
  })
  .strict();
export type AssetDef = z.infer<typeof AssetDefSchema>;
export const AssetsSchema = z.record(AssetDefSchema);

/**
 * A rig definition (ADR-006). `provider` is the id of the PROVIDER plugin that renders this layer
 * (e.g. "dragonbones", "blob-creature", future "chart"/"widget"). The compositor dispatches by it
 * through the engine's `providers` registry — core knows no rig "kind"/domain.
 *
 * `spec` is OPAQUE to the core (`z.record(unknown)`): it travels in the Scene IR but is validated and
 * interpreted ONLY by the named provider (e.g. blob-creature parses it as its CharacterSpec). This
 * keeps the engine free of any domain entity — a provider's spec shape never leaks into core.
 */
/**
 * A rig MOUNT point (spec §8.1): a named bone/slot another layer may `attach` to, plus an OPTIONAL
 * local offset (px, in the rig's own centred space) at which the mount sits. `bone` follows a bone
 * (the attached child keeps its own draw order); `slot` injects into the parent's draw order. The
 * offset lets a static-art / blob-creature rig declare an approximate anchor position (e.g. `handR`
 * at `[40,-10]`) without a live skeleton — the compositor composes the child onto parent.position +
 * this offset. Carried as DATA from the rig library manifest into the Scene-IR rig def by the loader.
 */
export const RigMountSchema = z
  .object({
    bone: z.string().min(1).optional(),
    slot: z.string().min(1).optional(),
    /** Local offset (px) of this mount in the rig's own centred coordinate space. */
    offset: z.tuple([z.number(), z.number()]).optional(),
  })
  .strict();
export type RigMount = z.infer<typeof RigMountSchema>;

export const RigDefSchema = z
  .object({
    uri: z.string().min(1),
    /** Provider id → the engine `providers` registry entry that renders this rig. */
    provider: z.string().min(1),
    /** OPAQUE, provider-validated spec/sources. Travels in the Scene IR (shareable). */
    spec: z.record(z.unknown()).optional(),
    /**
     * Named MOUNT points (spec §8.1) the rig exposes — bone/slot anchors another layer may `attach`
     * to, each with an optional local offset. Copied from the rig's library manifest (`manifest.mounts`)
     * by the loader so the compositor can resolve an `attach.bone`/`attach.slot` to a position WITHOUT
     * poking the provider's internals (a rig stays a typed black box). Empty/absent → no mounts.
     */
    mounts: z.record(RigMountSchema).optional(),
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
    /**
     * Resolved clip (nested-composition) DEFINITIONS, keyed by `defs.clips[ref]` (the Lottie `assets`
     * precomp model). Each clip used in the scene appears ONCE here (deduped by lowering); every `clip`
     * layer references one by `ref`, so N instances share one def. Recursive: a def's own `clip` layers
     * resolve their refs into this same map (lowering recurses + cycle-detects). Defaulted empty for
     * back-compat (a scene with no clips has none). M2 (nested composition).
     */
    clips: z.lazy(() => ClipsSchema).default({}),
    /**
     * The RESOLVED stylekit (ADR-008 I2/I3). Lowering selects a `stylekit` library entry (default
     * "kurzgesagt"), seeds `palette`/`easings` from it, AND carries the whole resolved stylekit here
     * so render-time reads motion/liveness/shading/floor from the IR deterministically — no core
     * constant imports at render. Optional for back-compat: an IR without it renders with renderer
     * defaults (the neutral fallback at the seams).
     */
    stylekit: StyleKitSchema.optional(),
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

/**
 * Inter-rig ATTACHMENT (scene-graph parenting, spec §8.1). A layer with `attach` is parented to
 * another layer (`to` = a sibling layer id): each frame the compositor resolves the parent's anchor
 * (its evaluated `transform.position`, plus the offset of the named `bone`/`slot` MOUNT from the
 * parent rig def's `mounts`) and composes the child's own transform ON TOP of it (prop in hand, hat
 * on head, character on vehicle). `bone` follows a bone (child keeps its own draw order); `slot`
 * injects into the parent's draw order. `inherit` lists which channels propagate from the parent
 * (default `["position"]`); `offset` is an extra explicit child offset (px) past the mount.
 */
export const AttachSchema = z
  .object({
    /** The sibling layer id to parent onto (an earlier layer in the same scene). */
    to: z.string().min(1),
    /** Parent rig mount BONE to follow (resolved via the parent rig def's `mounts`). */
    bone: z.string().min(1).optional(),
    /** Parent rig mount SLOT to inject into (resolved via the parent rig def's `mounts`). */
    slot: z.string().min(1).optional(),
    /** Which transform channels propagate from the parent. Default `["position"]`. */
    inherit: z.array(z.enum(['position', 'rotation', 'scale', 'opacity'])).optional(),
    /** An extra explicit child offset (px) applied past the resolved mount. */
    offset: z.tuple([z.number(), z.number()]).optional(),
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

// --- compositing: blend mode + track matte / mask (M2 §11, ADR-003) ---

/**
 * A per-layer BLEND MODE (compositing): how this layer's pixels combine with what is already drawn
 * beneath it. Maps 1:1 to the CSS `mix-blend-mode` property (the runtime primitive — never
 * reimplemented), applied generically in the layer wrapper. `normal` (the default) is a no-op.
 * Covers the standard Porter-Duff / separable + non-separable modes (multiply for shadows, screen/
 * add for light, overlay/soft-light for grades, etc.).
 */
export const BlendModeSchema = z.enum([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
]);
export type BlendMode = z.infer<typeof BlendModeSchema>;

/**
 * A TRACK MATTE / MASK on a layer (compositing): clip this layer's visible area by the LUMINANCE or
 * ALPHA of a source. The source is EITHER another sibling layer's rendered output (`from` = a layer
 * id — an AE-style track matte) OR an external image/SVG asset (`ref` = a `defs.assets` key). Applied
 * generically in the layer wrapper via an SVG `<mask>` (luma) / `clipPath` + CSS `mask-image` (the
 * runtime primitives — never reimplemented), so it composes with blend/effects/parallax uniformly.
 *   • `mode: 'luma'`   — bright pixels of the source reveal (the default; AE luminance matte).
 *   • `mode: 'alpha'`  — opaque pixels of the source reveal (AE alpha matte).
 *   • `invert: true`   — invert the matte (a STENCIL / hole instead of a reveal).
 * Exactly one of `from`/`ref` is the source; both absent → no-op.
 */
export const MatteSchema = z
  .object({
    /** A sibling layer id whose rendered output is the matte source (AE track matte). */
    from: z.string().min(1).optional(),
    /** A `defs.assets` key (image/svg) used as the matte source. */
    ref: z.string().min(1).optional(),
    /** Luminance matte (bright reveals) or alpha matte (opaque reveals). Default `luma`. */
    mode: z.enum(['luma', 'alpha']).default('luma'),
    /** Invert the matte (reveal → stencil/hole). */
    invert: z.boolean().optional(),
  })
  .strict();
export type Matte = z.infer<typeof MatteSchema>;

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
  /**
   * COMPOSITING — per-layer blend mode (CSS `mix-blend-mode`). How this layer mixes with the layers
   * beneath it. Omitted/`normal` → ordinary alpha over (back-compat). Applied generically in the
   * layer wrapper (LayerView), so EVERY layer type gets it uniformly.
   */
  blend: BlendModeSchema.optional(),
  /**
   * COMPOSITING — per-layer track matte / mask. Clips this layer by the luma/alpha of a sibling layer
   * (`from`) or an asset (`ref`). Applied generically in the layer wrapper (LayerView) via SVG mask /
   * CSS mask-image. Omitted → unmasked (back-compat).
   */
  matte: MatteSchema.optional(),
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
    // --- compositional fields (M2, spec §8.1) ---
    /**
     * INTRA-RIG variant selection (spec §8.1): axis name → chosen part/skin name (e.g.
     * `{ head:"head_round", outfit:"lab_coat", palette:"warm" }`). OPAQUE to the core — forwarded to
     * the rig's PROVIDER, which interprets the selection against its own spec (DragonBones skins/
     * slot-swaps; blob-creature palette/part variants). The valid axes are declared by the rig's
     * library manifest `variants`; an unknown axis is the provider's concern, not core's.
     */
    parts: z.record(z.string()).optional(),
    /** INTER-RIG attachment (scene-graph parenting onto another layer's mount; spec §8.1). */
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

/**
 * A kinetic-typography animation channel for a text layer. `preset` selects an entrance/behaviour
 * built on the Remotion `interpolate`/`spring`/`Series` primitives + StyleKit easing (never linear,
 * unless `floor.nonLinearMotion=false`):
 *   • none      — static (no motion).
 *   • fade      — opacity 0→1 over `duration` frames, eased.
 *   • rise      — translateY (`distance` px) + fade in, eased.
 *   • stagger   — per-`unit` (char|word) entrance offset by index × `stagger` frames (a cascade).
 *   • typewriter— reveal characters over time at `cps` chars/second from `delay`.
 *   • count_up  — animate the rendered NUMBER from `from`→`to` over `duration` frames (eased),
 *                 formatted with `decimals` and optional `prefix`/`suffix`.
 * Params are loose (passthrough) — the renderer reads per-preset fields with sane defaults; the IR
 * boundary keeps them flexible (CLAUDE.md rule 5).
 */
export const TextAnimSchema = z
  .object({
    preset: z.enum(['none', 'fade', 'rise', 'stagger', 'typewriter', 'count_up']),
  })
  .passthrough();
export type TextAnim = z.infer<typeof TextAnimSchema>;

/**
 * text layer: first-class TYPOGRAPHY as a GENERIC core primitive (the taxonomy lists asset/text).
 * A thin adapter over the Remotion ecosystem — `@remotion/layout-utils` (fitText/measureText) for
 * box-fit, a VENDORED LOCAL font loaded via @font-face + `delayRender` (deterministic, offline; no
 * CDN), and `interpolate`/`spring` for the kinetic presets — composed with the SAME camera + §11.1
 * shading + parallax wrappers as every other layer.
 *
 * `color` reuses the shape/asset `fill` convention: a palette token (resolved via `defs.palette`) OR a
 * hex string. `box` requests fit-to-box layout (fitText scales the font to `box.w`). `font` is a
 * font-family NAME; `fontUri` (lowering-supplied) is the vendored font FILE the renderer @font-face's
 * — embedding it in the IR as an `asset://…` URI means the project bundler auto-vendors it.
 */
export const TextLayerSchema = z
  .object({
    type: z.literal('text'),
    ...layerBase,
    /** The text to render. For `count_up` this is overridden by the animated number. */
    content: z.string(),
    /** Font-family name (matches the @font-face family the renderer registers). */
    font: z.string().min(1).optional(),
    /** Vendored font FILE URI (e.g. `asset://fonts/DejaVuSans.ttf`) the renderer @font-face's. */
    fontUri: z.string().min(1).optional(),
    /** Font size in px (ignored when `box` drives fit-to-box layout). */
    size: z.number().positive().optional(),
    /** Font weight — numeric (100..900) or a CSS keyword ("normal"/"bold"). */
    weight: z.union([z.number(), z.string()]).optional(),
    /** Text color: a `defs.palette` token OR a hex string (the fill/color convention). */
    color: ColorSchema.optional(),
    /** Horizontal alignment. */
    align: z.enum(['left', 'center', 'right']).optional(),
    /** Line height multiplier (unitless). */
    lineHeight: z.number().positive().optional(),
    /** Letter spacing (tracking) in px. */
    tracking: z.number().optional(),
    /** Fit-to-box: the renderer scales the font (fitText) so the text fits this width/height. */
    box: z.object({ w: z.number().positive(), h: z.number().positive() }).strict().optional(),
    /** Kinetic-typography animation channel (entrance/behaviour). */
    anim: TextAnimSchema.optional(),
    transform: TransformSchema.optional(),
  })
  .strict();
export type TextLayer = z.infer<typeof TextLayerSchema>;

/**
 * clip layer (M2 nested composition): a PRE-COMPOSITION instance — a reference to a shared clip
 * definition (`defs.clips[ref]`, the Lottie `assets` precomp model) plus the per-instance overrides
 * (`args` = the AE Essential-Graphics / .mogrt Master Properties) and a group `transform`/`effects`/
 * `parallax` that move/affect the WHOLE unit. `from`/`duration_frames` give the local-timeline window
 * (rendered as a Remotion `<Sequence>`, which resets the inner frame to 0). The clip's inner layers
 * are NOT inlined here — they live ONCE in `defs.clips[ref].layers` and are shared by every instance
 * (DRY, like a Lottie file with one precomp used many times), namespaced + per-instance-seeded at
 * render time so two instances never collide and each is byte-identical (CLAUDE.md r.1).
 *
 * RECURSION: a clip def's own `layers` are the full {@link LayerSchema} union, which INCLUDES this
 * ClipLayer — so a clip can contain a clip to any depth. The union below is therefore declared with
 * `z.lazy` to break the self-reference. `args` is a free-form param override map (loose at the IR
 * boundary, like generator/shape args; resolved by the renderer's `resolveParams`).
 */
/**
 * A clip layer is a pre-composition INSTANCE. It carries NO nested `layers` of its own — those live
 * ONCE on the DEFINITION ({@link ClipDefSchema}, stored in `defs.clips[ref]`); an instance only
 * references a def by `ref` plus its per-instance `args`. So this is a plain strict object (no
 * recursion needed at the instance level): the RECURSION (a clip containing a clip) lives entirely in
 * the def's `layers`, which is the {@link LayerSchema} union — and that union includes `clip`, so a
 * resolved def's `clip` layers re-enter the same dispatch. No `z.lazy` is required because the
 * instance and the def are split (the def's `layers` are loose templates, validated post-substitution).
 */
export const ClipLayerSchema = z
  .object({
    type: z.literal('clip'),
    ...layerBase,
    /** defs.clips key — the shared precomp definition (resolved + deduped by lowering). */
    ref: z.string().min(1),
    /** Per-instance param overrides (the exposed Essential-Graphics controls). Loose at the boundary. */
    args: z.record(z.unknown()).optional(),
    /** Group transform applied to the whole unit (position/scale/rotation/opacity), `{a,k}`. */
    transform: TransformSchema.optional(),
    /** Parallax factor for the whole unit (2.5D depth), like an asset layer. */
    parallax: z.number().optional(),
    /** Local start frame within the parent timeline (Remotion `<Sequence from>`). */
    from: z.number().int().optional(),
    /** Local window length (Remotion `<Sequence durationInFrames>`); defaults to the def's length. */
    duration_frames: z.number().int().positive().optional(),
  })
  .strict();
export type ClipLayer = z.infer<typeof ClipLayerSchema>;

/**
 * footage layer (M2 compositing): plays time-based EXTERNAL media — a VIDEO file or a LOTTIE
 * animation — from a `defs.assets` ref, FRAME-SEEKED by Remotion so it is deterministic (CLAUDE.md
 * r.1). "Reuse over invent" (r.3): the renderer is a thin adapter over Remotion's `<OffthreadVideo>`/
 * `<Video>` (video) and `@remotion/lottie`'s `<Lottie>` (vector loops) — never reimplemented. The
 * media kind is read from the resolved `defs.assets[ref].kind` (`video` → video element; `lottie` →
 * Lottie). `from`/`playbackRate` window/retime the source; the standard `transform` + camera/parallax
 * + the generic blend/matte/effects wrappers compose it like every other layer.
 */
export const FootageLayerSchema = z
  .object({
    type: z.literal('footage'),
    ...layerBase,
    /** defs.assets key — must resolve to a `video` or `lottie` asset def. */
    ref: z.string().min(1),
    /** Local start frame of the source within this layer (offsets which source frame plays). */
    from: z.number().int().optional(),
    /** Playback-rate multiplier (1 = real time). Deterministic: still a pure function of frame. */
    playbackRate: z.number().positive().optional(),
    /** Loop the source when the timeline outlasts it (video: <Loop>; lottie: loop prop). */
    loop: z.boolean().optional(),
    /** Object-fit for video media within the layer box (cover/contain/fill). Default `contain`. */
    fit: z.enum(['cover', 'contain', 'fill']).optional(),
    /** Parallax factor for the whole footage unit (2.5D depth), like an asset/clip layer. */
    parallax: z.number().optional(),
    transform: TransformSchema.optional(),
  })
  .strict();
export type FootageLayer = z.infer<typeof FootageLayerSchema>;

/** Discriminated union of all layer types (M1 + the M2 `clip` precomp + `footage`). */
export const LayerSchema = z.discriminatedUnion('type', [
  AssetLayerSchema,
  RigLayerSchema,
  GeneratorLayerSchema,
  ShapeLayerSchema,
  TextLayerSchema,
  ClipLayerSchema,
  FootageLayerSchema,
]);
export type Layer = z.infer<typeof LayerSchema>;

/**
 * A clip DEFINITION — the shared precomp stored ONCE in `defs.clips[id]` (Lottie `assets` precomp).
 * `params` are the EXPOSED, typed+defaulted controls (Essential-Graphics / .mogrt); `layers` are the
 * Scene-IR layer TEMPLATES that may reference a param via `{ "$param": "name" }` (any value) or
 * `"…{{name}}…"` (string interpolation), and may themselves be `clip` layers (nesting). `layers` is
 * the recursive {@link LayerSchema} union, so a def can reference other clips. Only `$param`-wired
 * props are overridable per instance — a prop not wired to a param is fixed by the clip author.
 */
export const ClipParamSchema = z
  .object({
    type: z.enum(['string', 'number', 'color', 'boolean', 'enum']),
    /** The default value when an instance does not override it. Loose (per `type`). */
    default: z.unknown().optional(),
    /** For `enum`: the allowed values. */
    options: z.array(z.unknown()).optional(),
  })
  .strict();
export type ClipParam = z.infer<typeof ClipParamSchema>;

export const ClipDefSchema = z
  .object({
    /** Exposed param controls: name → { type, default? }. */
    params: z.record(ClipParamSchema).default({}),
    /** The clip's own (local) length in frames. */
    duration_frames: z.number().int().positive(),
    /**
     * The clip's layer TEMPLATES (recursive: may contain `clip` layers). Loosely typed at the IR
     * boundary because templates carry un-substituted `$param`/`{{}}` references (any value), so they
     * can't satisfy the strict {@link LayerSchema} until the renderer's pure `resolveParams`
     * substitutes them. After substitution each becomes a real {@link LayerSchema} member (incl.
     * `clip` → arbitrary nesting). Kept as loose records here; validated post-substitution at render.
     */
    layers: z.array(z.record(z.unknown())),
  })
  .strict();
export type ClipDef = z.infer<typeof ClipDefSchema>;

export const ClipsSchema = z.record(ClipDefSchema);
export type Clips = z.infer<typeof ClipsSchema>;

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
    /**
     * COLOR-SCRIPT (spec §11.4): a per-scene PALETTE OVERRIDE — a partial token map (token → color)
     * that the renderer merges OVER `defs.palette` for THIS scene only, so every fill/stroke/light
     * that resolves a token recolors coherently when the mood shifts. Carried as a DIFF vs the base
     * (only the tokens that change), emitted by the lowering color-script pass. Across a transition
     * the entering scene's override is the OKLab-interpolated blend toward the previous scene's palette
     * at the transition's leading edge (culori), so a mood change reads as a smooth global shift.
     * Omitted → the scene uses the base `defs.palette` unchanged (back-compat).
     */
    palette: PaletteSchema.optional(),
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
    /** Loop the source to fill the cue window (a music bed shorter than the timeline). */
    loop: z.boolean().optional(),
    /** Source loop length in frames (a music bed's own duration) — drives Remotion `<Loop>` tiling. */
    loop_frames: z.number().int().positive().optional(),
    /**
     * MIX controls (A3) for a `kind:"music"` bed: the per-frame volume the compositor applies. `gain`
     * is the base volume (no narration); `duck` the reduced volume while a narration cue overlaps the
     * frame; `fade` the linear ramp (frames) on each side of a narration cue. The compositor computes a
     * pure per-frame `volume(frame)` from these + the narration cue windows (deterministic). Ignored on
     * non-music cues.
     */
    mix: z
      .object({
        gain: z.number().min(0).max(1).optional(),
        duck: z.number().min(0).max(1).optional(),
        fade: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type AudioCue = z.infer<typeof AudioCueSchema>;

// --- caption cue (spec §11.3 narration-synced text / §12 captions) ---

/**
 * A CAPTION (subtitle) cue — on-screen narration-synced text. VISUAL (distinct from the `audio[]`
 * track), but DERIVED from a narration AudioCue: same authored `text` + same `at`/`duration_frames`,
 * so it is deterministic WITHOUT whisper (we authored the `say` line — golden rule 1). The compositor
 * renders it as a styled, readable caption (bottom-centre, semi-opaque bg) in a `<Sequence>` timed to
 * the cue. `mode` selects the on-screen cadence:
 *   • `line`  — the full transcript line shows for the whole cue window (the default).
 *   • `words` — the words reveal cumulatively, EVEN-SPLIT across `duration_frames` (a deterministic
 *     karaoke-style progression that needs no whisper word-timestamps; precise word alignment is the
 *     deferred whisper follow-up). `words[]` carries the tokens so the renderer needn't re-tokenize.
 * Carried as a top-level `SceneIR.captions[]` (parallel to `audio[]`), emitted by the narrate pass and
 * dropped on an alpha render (the caption belongs to the finished film, like the narration track).
 */
export const CaptionCueSchema = z
  .object({
    id: z.string().min(1),
    /** The full transcript line (the authored `say`). */
    text: z.string().min(1),
    /** Global timeline start frame (matches the source narration cue's `at`). */
    at: z.number().int().nonnegative(),
    /** On-screen length in frames (matches the source narration cue's `duration_frames`). */
    duration_frames: z.number().int().positive(),
    /** Cadence: whole line, or cumulative even-split word reveal. Default `line`. */
    mode: z.enum(['line', 'words']).default('line'),
    /** Pre-tokenized words (for `mode:"words"`); the renderer reveals them even-split across the window. */
    words: z.array(z.string()).optional(),
  })
  .strict();
export type CaptionCue = z.infer<typeof CaptionCueSchema>;

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
     * On-screen CAPTIONS (subtitles) synced to the narration (spec §11.3 / §12). Emitted by the
     * narrate pass alongside the narration `audio[]` cues (one caption per `say` line), VISUAL +
     * deterministic (derived from the authored transcript + cue window — no whisper). Default empty
     * (a silent / caption-disabled project has none). Rendered by the compositor's caption track and
     * dropped on an alpha render (the caption belongs to the finished film).
     */
    captions: z.array(CaptionCueSchema).default([]),
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
