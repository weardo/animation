// Pipeline pass P5 — Lowering: Story IR → Scene IR. Spec §5, §6.2, §15 (M1 vertical slice).
//
// A PURE function: `(StoryIR, opts?) → SceneIR`. Seeded RNG only (seeds derived from the story
// hash via P0's `deriveSeed`), no wall-clock, no Math.random, no I/O. It turns each semantic beat
// into a concrete scene of layers + keyframes + a camera move, drawing all motion/look constants
// from the StyleKit so quality is the floor (spec §9), and emits easing *refs* (names into
// `defs.easings`) on every keyframe so no segment is ever accidentally linear (spec §6.2/§9).
//
// M1 scope (spec §15): one beat → one scene containing
//   • a parallax BACKGROUND asset layer (proves 2.5D depth),
//   • a bead-string GENERATOR layer (seeded; proves the procedural generator family),
//   • a DragonBones RIG layer with an idle clip (identity-stable character),
//   • a CAMERA with a slow push-in (zoom 1.0→1.15) + a slight pan (drives the parallax differential).
//
// Library resolution: if a `Library` (P2 facade) is supplied, asset/rig defs are filled from the
// resolved catalog entries (name@version → uri), exercising the content-addressing seam (spec §15).
// Without one, the pass falls back to deterministic synthetic `defs` so it stays a pure, runnable
// function on its own. Either way the output validates against the Scene-IR Zod schema.

import {
  type AssetLayer,
  type RigLayer,
  type GeneratorLayer,
  type ShapeLayer,
  type Effect,
  type RigClip,
  type Transform,
  type AssetDef,
  type RigDef,
  type Palette,
  type Easings,
  type EasingDef,
  type StoryIR,
  type Beat,
  type ShowItem,
  type Character,
  type CameraIntent,
  type Transition,
  type Duration,
} from '../ir/index.js';
import type { LoweredLayer } from './contract.js';
import {
  DEFAULT_PALETTE,
  DEFAULT_EASINGS,
  MOTION_DEFAULTS,
} from '../render/stylekit.js';
import { storyHash, deriveSeed } from './parse.js';
import type { LoweredSceneIR, LoweredScene } from './contract.js';

/** This pass's id + version — folded into cache keys / provenance (spec §5). */
export const PASS_ID = 'lower';
export const PASS_VERSION = '1.0';

/** The render config for the M1 slice: one 5-second, 1920×1080, 30fps scene (spec §15). */
export const M1_CONFIG = {
  w: 1920,
  h: 1080,
  fps: 30,
  /** 5 seconds at 30fps. */
  durationFrames: 150,
} as const;

/**
 * Default per-beat scene length when a beat declares no `duration` (spec task: "a sensible default
 * e.g. 4s"). Expressed in SECONDS and resolved to frames against the scene fps so it scales with the
 * config. The M1 single-beat slice overrides this via `M1_CONFIG.durationFrames` (5s) when the story
 * has exactly one beat and the caller passed no override, preserving M1 byte-output (see lowerStory).
 */
export const DEFAULT_BEAT_SECONDS = 4 as const;

/**
 * Default transition length (frames) used when a beat carries a `transition` with no explicit
 * `duration`. A hard `cut` is zero-length (no overlap). Kept here as the one StyleKit-adjacent
 * tunable so every defaulted transition reads the same length. (Spec §11.2.)
 */
export const DEFAULT_TRANSITION_FRAMES = 15 as const;

/** Default M1 catalog refs (name@version) the lowering pass resolves (matches library/index.json). */
export const M1_REFS = {
  background: 'bg_gradient@1.0.0',
  beadStringPath: 'axon_curve@1.0.0',
  /** Fallback rig if a beat declares no character (the M1 sample rig). */
  rig: 'dragon@1.0.0',
} as const;

/**
 * The DragonBones animation the M1 rig clip drives. The bundled 'starter' demo armature (spec
 * spike) ships exactly one animation, "throw", whose hand/finger slots are skinned meshes that
 * deform under bone motion — this is the M1 "mesh-deformed (FFD) element" acceptance criterion
 * (spec §15). A richer rig with a named "idle" would override this in its own lowering.
 */
export const M1_RIG_ANIM = 'throw' as const;

/**
 * Per-rig clip plans. A rig declares its own internal named animations (DragonBones); the lowering
 * pass selects/sequences them via `rig_state.clips` (a thin pointer, never re-describing bones —
 * spec §6.2/§8). The default plan loops the rig's single demo anim ("throw"); a richer rig (the M2
 * `blip` character) loops "idle" and fires an expressive "wave" mid-scene. Blink runs as host
 * liveness (RigLayer eye-slot toggle) on top, so it is not sequenced here.
 *
 * Keyed by rig NAME (the part of the ref before `@`). Falls back to the default demo clip.
 */
const RIG_CLIP_PLANS: Record<string, (durationFrames: number) => RigClip[]> = {
  blip: (durationFrames) => [
    { anim: 'idle', loop: true },
    // Expressive beat: wave once, starting ~40% in, then settle back to the looping idle.
    { anim: 'wave', loop: false, at: Math.floor(durationFrames * 0.4) },
    { anim: 'idle', loop: true, at: Math.floor(durationFrames * 0.4) + 48 },
  ],
};

/** Resolve the clip plan for a rig ref (`name@version` or `name`). */
function clipsForRig(rigRef: string, durationFrames: number): RigClip[] {
  const name = rigRef.split('@')[0] ?? rigRef;
  const plan = RIG_CLIP_PLANS[name];
  if (plan) return plan(durationFrames);
  return [{ anim: M1_RIG_ANIM, loop: true }];
}

// --- beat duration + transition resolution ----------------------------------------------------

/**
 * Resolve a beat's `duration` intent into an absolute frame count. The Story IR duration is one of:
 *   • a bare number          → SECONDS (the authoring-friendly Story-IR unit),
 *   • `{ seconds }`          → SECONDS,
 *   • `{ frames }`           → already frames.
 * Seconds are converted with the scene `fps` and rounded to the nearest whole frame (deterministic).
 * Returns `undefined` when the beat declares no duration, so the caller can apply its default.
 */
function resolveBeatFrames(
  duration: Duration | undefined,
  fps: number
): number | undefined {
  if (duration === undefined) return undefined;
  if (typeof duration === 'number') return Math.max(1, Math.round(duration * fps));
  if ('frames' in duration) return duration.frames;
  return Math.max(1, Math.round(duration.seconds * fps));
}

/**
 * Lower a beat's Story-IR `transition` into a Scene-IR `transition_in`, defaulting the `duration`
 * (frames) when the author omitted it. A hard `cut` stays zero-overlap (no `duration`). Returns
 * `undefined` when the beat has no transition (a plain hard cut at the boundary). Pure structural
 * copy — passthrough fields (dir, from/to, match) carry through unchanged (spec §11.2).
 */
function resolveTransitionIn(beat: Beat): Transition | undefined {
  const t = beat.transition;
  if (!t) return undefined;
  if (t.kind === 'cut') {
    // A hard cut is a zero-length boundary; drop any duration so it never overlaps.
    const { duration: _drop, ...rest } = t as Transition & { duration?: number };
    return rest as Transition;
  }
  if (t.duration === undefined) {
    return { ...t, duration: DEFAULT_TRANSITION_FRAMES } as Transition;
  }
  return t as Transition;
}

/**
 * The overlap (in frames) a scene's leading transition consumes from the PREVIOUS scene's tail.
 * `@remotion/transitions` plays a transition by overlapping the two adjacent scenes, so the global
 * timeline shortens by this amount at every transitioned boundary. A `cut` (or no transition) is
 * zero. The first scene never overlaps (nothing precedes it) — the caller guards that.
 */
function overlapFrames(transitionIn: Transition | undefined): number {
  if (!transitionIn) return 0;
  if (transitionIn.kind === 'cut') return 0;
  return transitionIn.duration ?? DEFAULT_TRANSITION_FRAMES;
}

// --- camera intent extraction ------------------------------------------------------------------

/**
 * Extract a beat's camera INTENT (a keyword like "slow_push_in", or `{ move, amount, ... }`) for the
 * lite camera-director pass (P8) to expand into concrete keyframes. Lowering deliberately emits the
 * intent rather than baking camera here, so each beat's camera move is resolved per-scene by P8
 * (spec §5/§8: lower emits intent; the camera pass owns the recipe). `undefined` → P8 applies its
 * DEFAULT_INTENT ("hold").
 */
function cameraIntentForBeat(beat: Beat): CameraIntent | undefined {
  return beat.camera;
}

/** Minimal structural view of the Library facade this pass needs (kept loose to avoid coupling). */
export interface LibraryLike {
  toAssetDef(ref: string): AssetDef;
  toRigDef(ref: string): RigDef;
  /** Optional: resolve a ref's content hash (used for provenance only). */
  hashOf?(ref: string): string;
}

/** Options for {@link lowerStory}. All optional — the pass is runnable with none. */
export interface LowerOptions {
  /** Library facade (P2). When present, defs are filled from resolved catalog entries. */
  library?: LibraryLike;
  /** Override the per-scene duration in frames (default {@link M1_CONFIG}.durationFrames). */
  durationFrames?: number;
}

// --- StyleKit → IR adapters -------------------------------------------------------------------

/**
 * Convert the StyleKit `DEFAULT_EASINGS` table into a Scene-IR `defs.easings` map. Each value is
 * already either a cubic-bezier tuple or a known curve name — exactly the IR `EasingDef` union — so
 * this is a structural copy that pins the StyleKit curves into the scene (spec §6.2/§9).
 */
function defaultEasings(): Easings {
  const out: Record<string, EasingDef> = {};
  for (const [name, def] of Object.entries(DEFAULT_EASINGS)) {
    out[name] = Array.isArray(def) ? ([...def] as EasingDef) : (def as EasingDef);
  }
  return out;
}

/** The default palette tokens, copied into a Scene-IR `defs.palette` (spec §6.2/§9). */
function defaultPalette(): Palette {
  return { ...DEFAULT_PALETTE };
}

// --- def resolution ---------------------------------------------------------------------------

/**
 * Resolve an asset def from the library, or synthesize a deterministic fallback `asset://<name>.svg`
 * so the pass runs standalone. The synthetic uri is a pure function of the ref name.
 */
function resolveAsset(ref: string, lib: LibraryLike | undefined): AssetDef {
  if (lib) return lib.toAssetDef(ref);
  const name = ref.split('@')[0] ?? ref;
  return { uri: `asset://${name}.svg`, kind: 'svg' };
}

/** Resolve a rig def from the library, or synthesize a deterministic fallback. */
function resolveRig(ref: string, lib: LibraryLike | undefined): RigDef {
  if (lib) return lib.toRigDef(ref);
  const name = ref.split('@')[0] ?? ref;
  return { uri: `rig://${name}.dbones.json`, provider: 'dragonbones' };
}

/**
 * Pick the rig ref for a beat: the first declared character's rig (resolved to name@version), or
 * the M1 fallback rig. A character's `rig` may omit a version (`name` or `name@x.y.z`); we default
 * an unversioned name to `@1.0.0` so the M1 catalog resolves it.
 */
function rigRefForStory(story: StoryIR): string {
  const first: Character | undefined = Object.values(story.characters)[0];
  if (!first) return M1_REFS.rig;
  return first.rig.includes('@') ? first.rig : `${first.rig}@1.0.0`;
}

// --- layer builders ---------------------------------------------------------------------------

/** The parallax BACKGROUND asset layer (spec §15: proves 2.5D depth). z=0, far parallax. */
function buildBackgroundLayer(): AssetLayer {
  return {
    type: 'asset',
    id: 'L_bg',
    ref: 'bg_gradient',
    z: 0,
    // Far layer → low parallax factor (moves least with the camera) for depth (StyleKit bounds).
    parallax: MOTION_DEFAULTS.parallax.farFactor + 0.1,
  };
}

/**
 * The bead-string GENERATOR layer (spec §15: a neuron chain — traveling pulse + wavy bending +
 * blobby beads). Seeded deterministically from the story hash + the layer handle. Params follow the
 * Scene-IR example (spec §6.2): pulse propagation `phase = frame*speed − index*phase_step`.
 */
function buildBeadStringLayer(seed: number, pathUri: string): GeneratorLayer {
  return {
    type: 'generator',
    id: 'L_neuron',
    gen: 'bead-string',
    z: 4,
    seed,
    path: pathUri,
    params: {
      beads: 9,
      bead_radius: 14,
      blobbiness: 0.35,
      pulse: { amp: 0.25, speed: 1.4, phase_step: 0.6 },
      wave: { amp: 10, speed: 0.8 },
      gooey: true,
      fill: 'accent',
      glow: true,
    },
  };
}

/**
 * A generic procedural GENERATOR layer (spec §10/§10.1) lowered from a `show[].generator` item —
 * `scatter` (the Kurzgesagt "hundreds of tiny shapes" ambience), `water`, `particles`, `fire`,
 * `crowd`, or any future registered generator EXCEPT `bead-string` (which has its own M1 builder).
 * "Families are sockets; libraries are plugs": the lowering pass does NOT know any generator's
 * params — it just forwards the authored `gen` name + the item's free-form `args` and assigns a
 * deterministic seed (story hash + beat id + handle) and a LOW z so the field composites BEHIND the
 * bead-string (z=4) and the protagonist rig (z=10) but ABOVE the background (z=0). Each generator's
 * own Zod schema validates the params at render time (CLAUDE.md rule 5: params stay loose at the IR
 * boundary). This is how each beat gets its own DISTINCT world (ocean / void / hearth / stadium)
 * with NO IR or compositor change — the registry resolves `gen` → component on the render side.
 */
function buildGeneratorLayer(
  id: string,
  gen: string,
  seed: number,
  params: Record<string, unknown>,
  effects?: Effect[]
): GeneratorLayer {
  return {
    type: 'generator',
    id,
    gen,
    // Low z: behind the neuron chain (z=4) and the character (z=10), above the background (z=0).
    z: 1,
    seed,
    // Free-form, validated by the generator's own Zod schema at render time. Empty args → defaults.
    params,
    // Authored per-layer effects[] stack (ADR-003 #2) — pass straight through; each entry's params
    // are validated by its registered effect's own Zod at render time (CLAUDE.md rule 5).
    ...(effects && effects.length > 0 ? { effects } : {}),
  };
}

/**
 * A first-class SHAPE layer (ADR-003 #1) lowered from a `show[].shape` directive. "Families are
 * sockets; libraries are plugs": the rendered geometry is a `@remotion/shapes` PRIMITIVE (kind +
 * params) and/or a flubber-morphed path (`morph`), with a solid- or gradient-`fill` and optional
 * `stroke` — all of which arrive in the item's free-form `args` and pass straight through to the
 * Scene-IR `shape` layer (validated by the ShapeLayer Zod schema at the boundary; CLAUDE.md rule 5).
 *
 * The `as` handle becomes the layer id (stable → byte-identical re-renders); `z`/`scale`/`rotation`/
 * `opacity` in `args` build the layer transform (a static `pop`-free transform here; the ShapeLayer
 * evaluates animated `{a,k}` morph/fill itself). Placement is carried as a layout `anchor` (from the
 * item's `at`), resolved to `transform.position` by the layout pass — so a shape stages like any
 * other layer. Pure structural lowering: no wall-clock, no RNG.
 */
function buildShapeLayer(item: ShowItem, index: number): LoweredLayer {
  const kind = item.shape!;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const id = `L_shape_${item.as ?? `${kind}_${index}`}`;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 5;

  // Geometry: an explicit `morph` channel wins; else the named primitive (unless the sentinel
  // `morph` kind was used without a morph — then nothing draws, which we avoid by requiring args).
  const morph = args['morph'] as ShapeLayer['morph'] | undefined;
  const shape =
    kind === 'morph'
      ? (args['shape'] as ShapeLayer['shape'] | undefined)
      : ({ kind, ...((args['params'] as Record<string, unknown>) ?? {}) } as ShapeLayer['shape']);

  // Transform: scale/rotation/opacity from args (position comes from the anchor via layout). A bare
  // number is wrapped as a static `{a:0,k}` channel; an authored `{a,k}` object passes straight through
  // (so an effect like motion_blur has a real animated move to smear). The ShapeLayer evaluates these.
  const transform: Transform = {};
  const channel = (v: unknown): Transform['scale'] | undefined =>
    typeof v === 'number' ? { a: 0, k: v } : v && typeof v === 'object' ? (v as Transform['scale']) : undefined;
  const scaleCh = channel(args['scale']);
  const rotationCh = channel(args['rotation']);
  const opacityCh = channel(args['opacity']);
  if (scaleCh) transform.scale = scaleCh;
  if (rotationCh) transform.rotation = rotationCh;
  if (opacityCh) transform.opacity = opacityCh;

  const layer: ShapeLayer = {
    type: 'shape',
    id,
    z,
    ...(shape ? { shape } : {}),
    ...(morph ? { morph } : {}),
    ...(args['fill'] !== undefined ? { fill: args['fill'] as ShapeLayer['fill'] } : {}),
    ...(args['stroke'] !== undefined ? { stroke: args['stroke'] as ShapeLayer['stroke'] } : {}),
    // Authored per-layer effects[] stack (ADR-003 #2): pass `args.effects` straight through to the
    // Scene-IR layer `effects[]`. Each entry is `{ kind, ...params }`; the registered effect validates
    // its own params at render time (CLAUDE.md rule 5). Layers without effects are left untouched.
    ...(Array.isArray(args['effects']) ? { effects: args['effects'] as Effect[] } : {}),
    ...(Object.keys(transform).length > 0 ? { transform } : {}),
  };

  // Carry the placement anchor (default "center") for the layout pass to resolve to a position.
  const anchor = typeof item.at === 'string' ? item.at : 'center';
  return { ...layer, anchor } as LoweredLayer;
}

/**
 * The DragonBones RIG layer with an idle clip (spec §15: identity-stable character). A StyleKit
 * "pop" entrance (scale + opacity overshoot) makes the character appear with life (spec §9); the
 * idle clip loops so even a static shot feels alive. Centered, ground-anchored position.
 */
function buildRigLayer(ref: string, w: number, h: number, clips: RigClip[]): RigLayer {
  const transform: Transform = {
    position: { a: 0, k: [w * 0.5, h * 0.62] },
    // "pop" entrance: scale 0→100 over 12 frames with the overshoot curve (StyleKit "pop").
    scale: {
      a: 1,
      k: [
        { t: 0, s: 0, e: 'pop' },
        { t: 12, s: 100 },
      ],
    },
    opacity: {
      a: 1,
      k: [
        { t: 0, s: 0, e: 'pop' },
        { t: 12, s: 100 },
      ],
    },
  };
  return {
    type: 'rig',
    id: 'L_narr',
    ref,
    z: 10,
    transform,
    rig_state: {
      clips,
    },
  };
}

// --- scene builder ----------------------------------------------------------------------------

/**
 * Lower one beat into one scene placed on the GLOBAL timeline (one beat → one scene). Emits the
 * scene's own layers (background + bead-string generator + rig), its `camera_intent` (the beat's
 * camera move, expanded later by P8), its `duration_frames`, its global `at`, and its `transition_in`
 * (lowered from the beat's `transition`). Returns a {@link LoweredScene} (camera still an intent);
 * the lite camera pass concretizes it before the Scene-IR boundary.
 */
function buildScene(
  beat: Beat,
  at: number,
  durationFrames: number,
  hash: string,
  rigDefKey: string,
  rigRef: string,
  beadPathUri: string,
  cfg: { w: number; h: number },
  transitionIn: Transition | undefined
): LoweredScene {
  // Honor the beat's `show` intent: the bead-string GENERATOR layer is emitted only for beats that
  // actually introduce/keep it on screen (a `show[].generator === 'bead-string'`). This makes the
  // film read as a story — e.g. an intro beat with no `show` shows just the character, and the neuron
  // network appears in the beat that introduces it (spec §6.1: beats declare what is on screen). The
  // background + rig (the protagonist) are present in every beat.
  const showsBeadString = (beat.show ?? []).some((s) => s.generator === 'bead-string');
  // Seed is derived from the story hash + the beat id + the layer handle, so every beat's generator
  // gets a distinct, deterministic seed (no cross-beat seed collisions, no wall-clock).
  const seed = deriveSeed(hash, `${beat.id}:L_neuron`);

  // GENERATOR ambience (spec §10/§10.1): a beat may declare one or more `show[].generator` items
  // (scatter / water / particles / fire / crowd / any registered generator EXCEPT `bead-string`,
  // which has its own M1 builder above). Each becomes a low-z procedural layer whose look comes from
  // the item's free-form `args`; each gets a distinct deterministic seed keyed by its name+handle and
  // a stable layer id (`L_gen_<gen>_<handle>`) so re-renders are byte-identical. The authored
  // `s.generator` flows straight through as the IR `gen` name — the registry resolves it to a
  // component on the render side. Distinct per beat → per-scene variety (each beat its own world).
  const generatorLayers: GeneratorLayer[] = (beat.show ?? [])
    .filter((s): s is typeof s & { generator: string } =>
      typeof s.generator === 'string' && s.generator !== 'bead-string'
    )
    .map((s, i) => {
      const gen = s.generator;
      const handle = s.as ?? `${gen}_${i}`;
      const genSeed = deriveSeed(hash, `${beat.id}:${gen}:${handle}`);
      const gArgs = (s.args ?? {}) as Record<string, unknown>;
      const gEffects = Array.isArray(gArgs['effects']) ? (gArgs['effects'] as Effect[]) : undefined;
      return buildGeneratorLayer(`L_gen_${gen}_${handle}`, gen, genSeed, s.args ?? {}, gEffects);
    });

  // SHAPE layers (ADR-003 #1): every `show[].shape` item becomes a first-class Scene-IR shape layer
  // (a @remotion/shapes primitive and/or a flubber morph, with solid/gradient fill + stroke). Carried
  // with a layout `anchor` so the layout pass stages it; no seed needed (shapes are deterministic).
  const shapeLayers: LoweredLayer[] = (beat.show ?? [])
    .filter((s) => typeof s.shape === 'string')
    .map((s, i) => buildShapeLayer(s, i));

  const layers: LoweredLayer[] = [
    buildBackgroundLayer(),
    ...generatorLayers,
    ...(showsBeadString ? [buildBeadStringLayer(seed, beadPathUri)] : []),
    ...shapeLayers,
    buildRigLayer(rigDefKey, cfg.w, cfg.h, clipsForRig(rigRef, durationFrames)),
  ];
  // A single GSAP-style label at mid-scene (the "reveal" beat the spec example uses).
  const reveal = Math.floor(durationFrames / 2);
  const scene: LoweredScene = {
    id: beat.id,
    at,
    duration_frames: durationFrames,
    labels: { reveal },
    layers,
  };
  // Carry the beat's camera move as an INTENT for P8 to expand (omitted → P8 applies its default).
  const intent = cameraIntentForBeat(beat);
  if (intent !== undefined) scene.camera_intent = intent;
  // Carry the beat's transition onto the scene's leading boundary (omitted on a hard cut / no
  // transition — the compositor then renders a plain cut). The first scene drops it (no predecessor).
  if (transitionIn) scene.transition_in = transitionIn;
  return scene;
}

// --- the pass ---------------------------------------------------------------------------------

/**
 * P5: lower a MULTI-BEAT Story IR into a sequenced, multi-scene Scene IR on the global timeline.
 *
 * MULTI-SCENE STORYTELLING (spec §11.2 / §15 M2): each beat becomes ONE scene, and the scenes are
 * laid out back-to-back on the GLOBAL timeline with transitions between them:
 *   • duration  — each scene's `duration_frames` comes from the beat's `duration` (seconds/frames),
 *                 falling back to {@link DEFAULT_BEAT_SECONDS} (×fps). The single-beat M1 case keeps
 *                 its 5s slice (M1_CONFIG) when no duration/override is given, preserving M1 output.
 *   • at        — cumulative: scene[i].at = scene[i-1].at + scene[i-1].duration − overlap[i], where
 *                 overlap[i] is the frames scene[i]'s `transition_in` overlaps the previous tail
 *                 (0 for a hard cut / no transition; a transitioned boundary shortens the timeline).
 *   • transition— each beat's `transition` lowers onto the scene's `transition_in` (the FIRST beat's
 *                 transition is dropped — nothing precedes it).
 *   • camera    — each beat's camera INTENT is carried as `camera_intent`; the lite camera pass (P8)
 *                 expands it into concrete per-scene keyframes (so every beat gets its own move).
 *   • total     — `config.duration_frames` = Σ duration_frames − Σ overlaps (the real film length on
 *                 the timeline once transition overlaps are accounted for).
 *
 * Pure + deterministic: same `(story, opts)` ⇒ same Scene IR (generator seeds derive from the story
 * hash; all motion uses StyleKit easing refs; no wall-clock, no RNG). `defs` is resolved once and
 * shared by all scenes.
 *
 * Returns a {@link LoweredSceneIR}: scenes carry `camera_intent` (not yet a concrete camera), so the
 * lite camera pass (P8) runs next; the final Zod Scene-IR boundary is `validate.ts` (V).
 *
 * @param story validated Story IR (from P0).
 * @param opts  optional library facade (P2) + per-beat duration override.
 * @returns the lowered Scene IR (camera as intent), ready for the layout+camera lite passes.
 */
export function lowerStory(story: StoryIR, opts: LowerOptions = {}): LoweredSceneIR {
  const lib = opts.library;
  const { w, h, fps } = M1_CONFIG;

  const hash = storyHash(story);
  const rigRef = rigRefForStory(story);

  // Resolve the def tables once (shared by all scenes). The bead-string places along the axon path;
  // we keep the asset's `#path` fragment for the generator's `path` field (spec §6.2 example).
  const bgDef = resolveAsset(M1_REFS.background, lib);
  const beadPathDef = resolveAsset(M1_REFS.beadStringPath, lib);
  const rigDef = resolveRig(rigRef, lib);

  const defs = {
    palette: defaultPalette(),
    easings: defaultEasings(),
    assets: { bg_gradient: bgDef },
    // The rig layers reference the def by the key 'narrator' (spec §6.2 example uses that handle).
    rigs: { narrator: rigDef },
  };

  // Per-beat duration default. A single-beat story with NO duration/override keeps the 5s M1 slice
  // (M1_CONFIG.durationFrames) so the M1 vertical slice's output is unchanged. Multi-beat stories
  // (or an explicit override) use the per-beat default of DEFAULT_BEAT_SECONDS × fps.
  const singleBeat = story.beats.length === 1;
  const beatDefaultFrames =
    opts.durationFrames ??
    (singleBeat ? M1_CONFIG.durationFrames : Math.round(DEFAULT_BEAT_SECONDS * fps));

  // Lower each beat to a scene, sequencing them on the global timeline with transition overlaps.
  const scenes: LoweredScene[] = [];
  let at = 0;
  let total = 0;
  story.beats.forEach((beat, i) => {
    // Resolve this scene's length: the beat's explicit duration, else the (possibly overridden)
    // default. An explicit per-beat duration always wins over the default.
    const durationFrames = resolveBeatFrames(beat.duration, fps) ?? beatDefaultFrames;

    // The leading transition (dropped on the first scene — nothing precedes it). It overlaps the
    // PREVIOUS scene's tail, so it shortens both this scene's `at` and the running total.
    const transitionIn = i === 0 ? undefined : resolveTransitionIn(beat);
    const overlap = overlapFrames(transitionIn);

    // Pull this scene back over the previous tail by the overlap so the transition cross-fades.
    at -= overlap;

    scenes.push(
      buildScene(
        beat,
        at,
        durationFrames,
        hash,
        'narrator',
        rigRef,
        beadPathDef.uri,
        { w, h },
        transitionIn
      )
    );

    at += durationFrames;
    // Total film length = sum of durations minus the overlaps consumed at each boundary.
    total += durationFrames - overlap;
  });

  const loweredIR: LoweredSceneIR = {
    scene_ir_version: '1.0',
    config: { w, h, fps, duration_frames: total },
    defs,
    audio: [],
    scenes,
    provenance: {
      story_ir_hash: hash,
      passes: [`${PASS_ID}@${PASS_VERSION}`],
    },
  };

  return loweredIR;
}
