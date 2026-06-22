// P8 — Camera director (lite). Spec §5, §6.2 (camera = animated position + zoom with easing-ref'd
// keyframes), §15 (M1: "one camera move: slow push-in + slight pan"). NOT a smart cinematographer
// (that is the later P9) — this pass maps a beat's camera-INTENT keyword to concrete camera keyframes.
//
// PURE + DETERMINISTIC (CLAUDE.md golden rule 1): output is a function of (intent, scene duration)
// only — no wall-clock, no RNG. Each intent is a fixed recipe over the scene's frame span, so the
// resulting keyframes are byte-stable.
//
// Every produced keyframe carries an `e` easing ref into `defs.easings` (the StyleKit "smooth"
// curve), so no camera move is ever accidentally linear (CLAUDE.md golden rule 7 / spec §9).

import type {
  AnimatedVec2,
  AnimatedNumber,
  Camera,
  CameraIntent,
} from '../ir/index.js';
import type { LoweredSceneIR, LoweredScene } from './contract.js';

/** Pass identity for cache keys / provenance (spec §5: per-stage versioning). */
export const CAMERA_PASS = 'camera@0.1' as const;

/**
 * The StyleKit easing token every camera move uses. It must exist in `defs.easings` (the lowering
 * pass seeds `DEFAULT_EASINGS`, which includes "smooth"). Named, not inlined, so a palette/easing
 * swap re-tunes all camera motion coherently.
 */
export const CAMERA_EASING = 'smooth' as const;

/** Default camera intent when a beat declares none — a calm, locked frame. */
export const DEFAULT_INTENT = 'hold' as const satisfies CameraIntent;

// ---------------------------------------------------------------------------------------------
// Intent recipes. Each recipe is a pure function of the scene's duration (in frames) → a concrete
// `Camera` ({a,k} position + zoom). Pan offsets are in pixels relative to the resting frame center
// (the compositor applies camera position as a translation); zoom is a multiplier (1.0 = neutral).
// ---------------------------------------------------------------------------------------------

/** Build a single-segment animated number from start→end across [0, dur]. */
function ramp(start: number, end: number, dur: number): AnimatedNumber {
  if (start === end) return { a: 0, k: start };
  return {
    a: 1,
    k: [
      { t: 0, s: start, e: CAMERA_EASING },
      { t: dur, s: end },
    ],
  };
}

/** Build a single-segment animated vec2 from start→end across [0, dur]. */
function rampVec2(
  start: readonly [number, number],
  end: readonly [number, number],
  dur: number
): AnimatedVec2 {
  if (start[0] === end[0] && start[1] === end[1]) {
    return { a: 0, k: [start[0], start[1]] };
  }
  return {
    a: 1,
    k: [
      { t: 0, s: [start[0], start[1]], e: CAMERA_EASING },
      { t: dur, s: [end[0], end[1]] },
    ],
  };
}

/** A camera recipe: scene duration → concrete camera channels. */
type Recipe = (dur: number) => Camera;

/**
 * The intent table. Keep these conservative and Kurzgesagt-tasteful: gentle, never-linear moves.
 *   • hold          — locked frame (no move). The safe default.
 *   • establishing  — start slightly wide and pulled out, ease toward neutral (settle the audience).
 *   • slow_push_in  — the M1 hero move: gentle zoom 1.0→1.15 plus a slight rightward pan (drives the
 *                     parallax differential, spec §15).
 *   • slow_pull_out — the inverse: ease out from a tight frame to neutral.
 *   • pan_left / pan_right — a small lateral drift at constant zoom.
 */
const RECIPES = {
  hold: (): Camera => ({
    position: { a: 0, k: [0, 0] },
    zoom: { a: 0, k: 1 },
  }),
  establishing: (dur): Camera => ({
    position: rampVec2([0, -20], [0, 0], dur),
    zoom: ramp(0.92, 1.0, dur),
  }),
  slow_push_in: (dur): Camera => ({
    position: rampVec2([0, 0], [60, 0], dur),
    zoom: ramp(1.0, 1.15, dur),
  }),
  slow_pull_out: (dur): Camera => ({
    position: rampVec2([0, 0], [0, 0], dur),
    zoom: ramp(1.15, 1.0, dur),
  }),
  pan_left: (dur): Camera => ({
    position: rampVec2([0, 0], [-80, 0], dur),
    zoom: { a: 0, k: 1 },
  }),
  pan_right: (dur): Camera => ({
    position: rampVec2([0, 0], [80, 0], dur),
    zoom: { a: 0, k: 1 },
  }),
} as const satisfies Record<string, Recipe>;

/** A known camera intent keyword (key of {@link RECIPES}). */
export type KnownIntent = keyof typeof RECIPES;

/** True if `intent` is a known camera intent keyword. */
export function isKnownIntent(intent: string): intent is KnownIntent {
  return Object.prototype.hasOwnProperty.call(RECIPES, intent);
}

/**
 * Expand a camera intent keyword into concrete camera keyframes for a scene of `durationFrames`.
 * Throws on an unknown intent (spec: no silent fallback to a wrong move). An absent intent should
 * be normalized to {@link DEFAULT_INTENT} by the caller.
 */
export function cameraFromIntent(
  intent: CameraIntent,
  durationFrames: number
): Camera {
  // A camera intent is either a bare preset name or an object carrying `{ move, ... }`.
  const move = typeof intent === 'string' ? intent : intent.move;
  if (!isKnownIntent(move)) {
    throw new Error(
      `unknown camera intent "${move}". Known intents: ${Object.keys(RECIPES).join(', ')}.`
    );
  }
  return RECIPES[move](durationFrames);
}

/**
 * Expand one lowered scene's `camera_intent` into a concrete `camera`, dropping the intent so the
 * result conforms to the strict Scene-IR scene schema. An explicit `camera` already present is
 * respected (lowering was specific); otherwise the intent (or {@link DEFAULT_INTENT}) is expanded.
 */
function directScene(scene: LoweredScene): LoweredScene {
  const { camera_intent, ...rest } = scene;

  // If lowering already produced a concrete camera, keep it and just drop the intent hint.
  if ('camera' in rest && (rest as { camera?: Camera }).camera !== undefined) {
    return rest as LoweredScene;
  }

  const intent = camera_intent ?? DEFAULT_INTENT;
  const camera = cameraFromIntent(intent, scene.duration_frames);
  return { ...rest, camera } as LoweredScene;
}

/**
 * P8 (lite). Turn every scene's camera intent into concrete camera keyframes. Pure: returns a new
 * IR; does not mutate the input. After this pass every scene has a concrete `camera` and no
 * `camera_intent`, so the IR is ready for the Zod Scene-IR boundary (`validate.ts`).
 */
export function camera(ir: LoweredSceneIR): LoweredSceneIR {
  return {
    ...ir,
    scenes: ir.scenes.map(directScene),
  };
}
