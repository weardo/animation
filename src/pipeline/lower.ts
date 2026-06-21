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
  validateSceneIR,
  type SceneIR,
  type Scene,
  type Layer,
  type AssetLayer,
  type RigLayer,
  type GeneratorLayer,
  type RigClip,
  type Camera,
  type Transform,
  type AssetDef,
  type RigDef,
  type Palette,
  type Easings,
  type EasingDef,
  type StoryIR,
  type Beat,
  type Character,
} from '../ir/index.js';
import {
  DEFAULT_PALETTE,
  DEFAULT_EASINGS,
  MOTION_DEFAULTS,
} from '../render/stylekit.js';
import { storyHash, deriveSeed } from './parse.js';

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
  return { uri: `rig://${name}.dbones.json`, kind: 'dragonbones' };
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

// --- camera builder ---------------------------------------------------------------------------

/**
 * The CAMERA: a slow push-in (zoom 1.0→1.15) + a slight pan, eased with the StyleKit "smooth"
 * curve over the whole scene (spec §15). The pan + per-layer parallax factors produce the 2.5D
 * depth differential. Pan magnitude scales with frame width so it reads the same at any resolution.
 */
function buildCamera(durationFrames: number, w: number): Camera {
  const end = durationFrames - 1;
  // A gentle rightward+downward drift — "slight pan" (spec §15). ~3% of frame width.
  const panX = Math.round(w * 0.03);
  return {
    position: {
      a: 1,
      k: [
        { t: 0, s: [0, 0], e: 'smooth' },
        { t: end, s: [panX, Math.round(panX * 0.4)] },
      ],
    },
    zoom: {
      a: 1,
      k: [
        { t: 0, s: 1.0, e: 'smooth' },
        { t: end, s: 1.15 },
      ],
    },
  };
}

// --- scene builder ----------------------------------------------------------------------------

/** Lower one beat into one concrete scene (the M1 mapping: one beat → one scene). */
function buildScene(
  beat: Beat,
  at: number,
  durationFrames: number,
  hash: string,
  rigDefKey: string,
  rigRef: string,
  beadPathUri: string,
  cfg: { w: number; h: number }
): Scene {
  const seed = deriveSeed(hash, `${beat.id}:L_neuron`);
  const layers: Layer[] = [
    buildBackgroundLayer(),
    buildBeadStringLayer(seed, beadPathUri),
    buildRigLayer(rigDefKey, cfg.w, cfg.h, clipsForRig(rigRef, durationFrames)),
  ];
  // A single GSAP-style label at mid-scene (the "reveal" beat the spec example uses).
  const reveal = Math.floor(durationFrames / 2);
  return {
    id: beat.id,
    at,
    duration_frames: durationFrames,
    labels: { reveal },
    camera: buildCamera(durationFrames, cfg.w),
    layers,
  };
}

// --- the pass ---------------------------------------------------------------------------------

/**
 * P5: lower a Story IR into a validated Scene IR.
 *
 * Pure + deterministic: same `(story, opts)` ⇒ same Scene IR (generator seeds derive from the
 * story hash; all motion uses StyleKit easing refs; no wall-clock). Each beat becomes one scene;
 * `defs` is seeded once from the StyleKit + resolved library entries and shared by all scenes.
 *
 * @param story validated Story IR (from P0).
 * @param opts  optional library facade (P2) + duration override.
 * @returns the validated Scene IR (Remotion `inputProps`).
 */
export function lowerStory(story: StoryIR, opts: LowerOptions = {}): SceneIR {
  const lib = opts.library;
  const durationFrames = opts.durationFrames ?? M1_CONFIG.durationFrames;
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

  // Lower each beat to a scene, laying them back-to-back on the global timeline.
  const scenes: Scene[] = [];
  let at = 0;
  for (const beat of story.beats) {
    scenes.push(
      buildScene(beat, at, durationFrames, hash, 'narrator', rigRef, beadPathDef.uri, { w, h })
    );
    at += durationFrames;
  }

  const totalFrames = durationFrames * story.beats.length;

  const sceneIR = {
    scene_ir_version: '1.0',
    config: { w, h, fps, duration_frames: totalFrames },
    defs,
    audio: [],
    scenes,
    provenance: {
      story_ir_hash: hash,
      passes: [`${PASS_ID}@${PASS_VERSION}`],
    },
  };

  // Validate at the IR boundary (spec §4/§5): applies defaults + throws a labelled error on drift.
  return validateSceneIR(sceneIR);
}
