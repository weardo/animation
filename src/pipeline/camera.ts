// P8 — Camera director (lite). Spec §5, §6.2 (camera = animated position + zoom with easing-ref'd
// keyframes), §15. ADR-008 I4 — the camera RECIPE TABLE is DATA, not hardcoded core magic numbers.
//
// This pass is the generic EXPANSION MECHANISM only. The recipe magic numbers (slow_push_in /
// pan_* / establishing / hold offsets + zooms) live in DATA: `library/camera/presets.json`. The pass
// reads that table and turns a beat's camera INTENT into concrete `{a,k}` camera keyframes. It also
// passes ARBITRARY explicit keyframes straight through (I4a) — a front-end may author any move, not
// just a named preset.
//
// PURE + DETERMINISTIC (CLAUDE.md golden rule 1): output is a function of (intent, scene duration,
// preset table) only — no wall-clock, no RNG. The table is read ONCE at module load from the data
// file; each preset is a fixed from→to ramp over the scene's frame span, so the keyframes are
// byte-stable. Every produced keyframe carries the table's easing ref into `defs.easings` (default
// "smooth"), so no camera move is ever accidentally linear (spec §9).

import { readFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AnimatedVec2,
  AnimatedNumber,
  Camera,
  CameraIntent,
} from '../ir/index.js';
import type { LoweredSceneIR, LoweredScene } from './contract.js';

/** Pass identity for cache keys / provenance (spec §5: per-stage versioning). */
export const CAMERA_PASS = 'camera@0.2' as const;

// ---------------------------------------------------------------------------------------------
// Recipe table — loaded from DATA (ADR-008 I4). The pass owns NO magic numbers; they live in
// `library/camera/presets.json`. Each preset is a from→to ramp; the pass expands it generically.
// ---------------------------------------------------------------------------------------------

/** One DATA recipe: a position offset ramp + a zoom ramp (from→to over the scene's frame span). */
interface PresetRecipe {
  position: { from: readonly [number, number]; to: readonly [number, number] };
  zoom: { from: number; to: number };
}

/** The whole DATA recipe document (library/camera/presets.json). */
interface PresetTable {
  default: string;
  easing: string;
  presets: Record<string, PresetRecipe>;
}

/**
 * Locate `library/camera/presets.json`. The pass file lives at `src/pipeline/camera.ts`; the data
 * file is at `<root>/library/camera/presets.json`. We resolve up two dirs from this module so the
 * lookup is independent of the process cwd (a pure, deterministic path).
 */
const PRESETS_PATH = resolvePath(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'library',
  'camera',
  'presets.json',
);

/** The recipe table, read ONCE from data at module load. Pure (no clock/RNG); the file is static. */
const TABLE: PresetTable = JSON.parse(readFileSync(PRESETS_PATH, 'utf8')) as PresetTable;

/** The easing token every preset move uses (from the DATA table). Must exist in `defs.easings`. */
export const CAMERA_EASING: string = TABLE.easing;

/** Default camera intent when a beat declares none — the DATA table's `default` (a calm, locked frame). */
export const DEFAULT_INTENT: CameraIntent = TABLE.default;

// ---------------------------------------------------------------------------------------------
// Generic expansion mechanism. Builds animated `{a,k}` channels from a DATA recipe's from→to ramp.
// Pan offsets are pixels relative to the resting frame centre; zoom is a multiplier (1.0 = neutral).
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

/** Expand a DATA recipe into concrete camera channels for a scene of `dur` frames. */
function expandRecipe(recipe: PresetRecipe, dur: number): Camera {
  return {
    position: rampVec2(recipe.position.from, recipe.position.to, dur),
    zoom: ramp(recipe.zoom.from, recipe.zoom.to, dur),
  };
}

/** A known camera intent keyword (a key in the DATA preset table). */
export type KnownIntent = string;

/** True if `intent` is a known camera intent keyword (present in the DATA table). */
export function isKnownIntent(intent: string): boolean {
  return Object.prototype.hasOwnProperty.call(TABLE.presets, intent);
}

/** Shape of the object-form camera intent (a named preset and/or arbitrary explicit keyframes). */
type CameraIntentObject = Exclude<CameraIntent, string>;

/**
 * Expand a camera intent into a concrete `Camera` for a scene of `durationFrames`.
 *   • a bare preset NAME, or an object `{ move }`  → expanded from the DATA recipe table;
 *   • an object carrying explicit `position`/`zoom` keyframes (I4a) → passed straight through
 *     (those `{a,k}` channels win; the strict Scene-IR boundary validates them).
 * Throws on an unknown preset name (spec: no silent fallback to a wrong move).
 */
export function cameraFromIntent(
  intent: CameraIntent,
  durationFrames: number
): Camera {
  // ARBITRARY explicit keyframes (I4a): when the intent object carries position/zoom channels, use
  // them verbatim — defaulting the missing axis to a neutral static channel. This lets a front-end
  // author any move without a preset, with no recipe magic numbers involved.
  if (typeof intent === 'object') {
    const obj = intent as CameraIntentObject;
    const hasExplicit = obj.position !== undefined || obj.zoom !== undefined;
    if (hasExplicit) {
      return {
        position: (obj.position as AnimatedVec2) ?? { a: 0, k: [0, 0] },
        zoom: (obj.zoom as AnimatedNumber) ?? { a: 0, k: 1 },
      };
    }
  }

  // Otherwise expand a named preset from the DATA table.
  const move = typeof intent === 'string' ? intent : intent.move ?? TABLE.default;
  if (!isKnownIntent(move)) {
    throw new Error(
      `unknown camera intent "${move}". Known intents: ${Object.keys(TABLE.presets).join(', ')}.`
    );
  }
  return expandRecipe(TABLE.presets[move] as PresetRecipe, durationFrames);
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
