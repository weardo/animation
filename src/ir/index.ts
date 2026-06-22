// IR layer — Zod schemas (single source of truth) + inferred TS types + JSON-Schema export.
// Story IR (semantic, YAML-authored) and Scene IR (concrete, Remotion inputProps, Lottie superset).
// See spec §6 (the two-layer IR), §7 (layer taxonomy), §15 (M1 subset).
//
// Other modules import from here. Schemas end in `Schema`; their inferred types share the base name.

// Animated-property convention (`{a,k}` Lottie superset) + value primitives.
export {
  animated,
  staticProp,
  keyframe,
  EasingRefSchema,
  ColorSchema,
  Vec2Schema,
  AnimatedNumberSchema,
  AnimatedVec2Schema,
  AnimatedColorSchema,
  NumberKeyframeSchema,
} from './animated.js';
export type {
  EasingRef,
  Color,
  Vec2,
  AnimatedNumber,
  AnimatedVec2,
  AnimatedColor,
  NumberKeyframe,
} from './animated.js';

// Story IR.
export {
  StoryIRSchema,
  CharacterSchema,
  BeatSchema,
  ShowItemSchema,
  ActionItemSchema,
  PlaceItemSchema,
  CameraIntentSchema,
  DurationSchema,
  StoryTransitionSchema,
} from './story.js';
export type {
  StoryIR,
  Character,
  Beat,
  ShowItem,
  ActionItem,
  PlaceItem,
  CameraIntent,
  Duration,
  StoryTransition,
} from './story.js';

// Scene IR.
export {
  SceneIRSchema,
  SceneConfigSchema,
  DefsSchema,
  PaletteSchema,
  EasingsSchema,
  EasingDefSchema,
  AssetDefSchema,
  RigDefSchema,
  CameraSchema,
  SceneSchema,
  LayerSchema,
  AssetLayerSchema,
  RigLayerSchema,
  GeneratorLayerSchema,
  ShapeLayerSchema,
  TransformSchema,
  RigStateSchema,
  RigClipSchema,
  FillSchema,
  GradientFillSchema,
  StrokeSchema,
  ShapePrimitiveSchema,
  MorphChannelSchema,
  EffectSchema,
  PostSchema,
  ShadingSchema,
  LightSchema,
  AttachSchema,
  StaggerGroupSchema,
  TransitionSchema,
  AudioCueSchema,
  ProvenanceSchema,
} from './scene.js';
export type {
  SceneIR,
  SceneConfig,
  Defs,
  Palette,
  Easings,
  EasingDef,
  AssetDef,
  RigDef,
  Camera,
  Scene,
  Layer,
  AssetLayer,
  RigLayer,
  GeneratorLayer,
  ShapeLayer,
  Transform,
  RigState,
  RigClip,
  Fill,
  GradientFill,
  Stroke,
  ShapePrimitive,
  Effect,
  Post,
  Transition,
  AudioCue,
  Provenance,
} from './scene.js';

// Validation helpers + JSON-Schema export.
export {
  validate,
  safeValidate,
  validateStoryIR,
  validateSceneIR,
  validateLayer,
  storyIRJsonSchema,
  sceneIRJsonSchema,
} from './validate.js';
