// Pipeline composition — `runPipeline(scriptPath) → SceneIR`. Spec §5 (the pass chain + content-hash
// caching), §6 (the two-layer IR), §15 (M1 vertical slice).
//
// Composition: parse (P0) → lower (P5) → layout (lite-P6) → camera (lite-P8) → validate (V).
//   • parse (parseStory) + lower (lowerStory) are the front-end (parse.ts / lower.ts).
//   • layout / camera / validate are the back-end lite passes (this directory). They are pure,
//     deterministic, idempotent refinements: lowering already bakes positions/camera, so the lite
//     passes pass those through; an alternate lowering may instead emit anchors / camera intent for
//     them to resolve.
//
// DETERMINISM + CACHING (CLAUDE.md golden rule 1 & 4): a run is keyed by a content hash over the
// pass identities + the script file contents (object-hash). A cache HIT returns the previously
// computed Scene IR verbatim from `.cache/`, so re-running is byte-stable and free. No wall-clock,
// no RNG anywhere in the chain (the only seeds derive from the story hash, in lowering).

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import objectHash from 'object-hash';

import type { SceneIR } from '../ir/index.js';
import type { Frontend, LoweredSceneIR } from './contract.js';
import { parseStory, PASS_ID as PARSE_PASS_ID, PASS_VERSION as PARSE_PASS_VERSION } from './parse.js';
import { lowerStory, PASS_ID as LOWER_PASS_ID, PASS_VERSION as LOWER_PASS_VERSION } from './lower.js';
import { layout, LAYOUT_PASS } from './layout.js';
import { camera, CAMERA_PASS } from './camera.js';
import { validate, VALIDATE_PASS } from './validate.js';

// --- re-exports: the whole pipeline surface from one module ------------------------------------

// P0 — parse + validate YAML → Story IR (+ content-hash & seed derivation helpers).
export {
  parseStory,
  storyHash,
  deriveSeed,
  PASS_ID as PARSE_PASS_ID,
  PASS_VERSION as PARSE_PASS_VERSION,
} from './parse.js';

// P5 — lowering: Story IR → Scene IR (domain-agnostic; ADR-007).
export {
  lowerStory,
  RENDER_CONFIG,
  DEFAULT_BEAT_SECONDS,
  DEFAULT_TRANSITION_FRAMES,
  DEFAULT_RIG_CLIP,
  DEFAULT_RIG_PROVIDER,
  PASS_ID as LOWER_PASS_ID,
  PASS_VERSION as LOWER_PASS_VERSION,
} from './lower.js';
export type { LowerOptions, LibraryLike } from './lower.js';

// lite-P6 / lite-P8 / V — the back-end passes (this directory).
export { layout, LAYOUT_PASS, ANCHORS, resolveAnchor, isAnchorName } from './layout.js';
export type { AnchorName } from './layout.js';
export {
  camera,
  CAMERA_PASS,
  cameraFromIntent,
  isKnownIntent,
  CAMERA_EASING,
  DEFAULT_INTENT,
} from './camera.js';
export type { KnownIntent } from './camera.js';
export { validate, VALIDATE_PASS } from './validate.js';

// shared pass contract (the parse/lower ↔ layout/camera seam).
export type { Frontend, LoweredSceneIR, LoweredScene, LoweredLayer } from './contract.js';

// --- caching ----------------------------------------------------------------------------------

/** Default cache directory (relative to the project root). Spec §5: "cache dir `.cache/`". */
export const DEFAULT_CACHE_DIR = '.cache';

/**
 * The ordered pass identities folded into the cache key, so bumping ANY pass version invalidates
 * stale cache entries (spec §5: "per-stage versioning in the cache key").
 */
const PASS_CHAIN = [
  `${PARSE_PASS_ID}@${PARSE_PASS_VERSION}`,
  `${LOWER_PASS_ID}@${LOWER_PASS_VERSION}`,
  LAYOUT_PASS,
  CAMERA_PASS,
  VALIDATE_PASS,
] as const;

/** Compute the content-hash cache key for a script + the pass chain (pure, no wall-clock). */
function cacheKey(scriptContents: string): string {
  return objectHash(
    { passes: PASS_CHAIN, script: scriptContents },
    { algorithm: 'sha1', encoding: 'hex' }
  );
}

// --- composition ------------------------------------------------------------------------------

/** Options for {@link runPipeline}. */
export interface RunPipelineOptions {
  /** Project root used to resolve the script path + the cache dir. Default: `process.cwd()`. */
  rootDir?: string;
  /** Cache directory (relative to `rootDir`). Set to `null` to disable caching. */
  cacheDir?: string | null;
  /**
   * Inject the front-end (parse + lower) instead of using the bundled `parseStory` / `lowerStory`.
   * For tests and for callers that wire a custom front-end.
   */
  frontend?: Frontend;
}

/** The default front-end: the bundled parse (P0) + lower (P5). */
const DEFAULT_FRONTEND: Frontend = { parse: parseStory, lower: lowerStory };

/**
 * Run the back-end (lite) passes on a lowered Scene IR: layout (P6) → camera (P8) → validate (V).
 * Exported so callers/tests can drive the deterministic tail of the pipeline directly. Pure:
 * returns a validated {@link SceneIR}; does not mutate the input.
 */
export function runBackend(lowered: LoweredSceneIR): SceneIR {
  const laidOut = layout(lowered);
  const directed = camera(laidOut);
  return validate(directed);
}

/**
 * Run the whole pipeline for a script file and return a validated {@link SceneIR}.
 *
 * `script.yaml → Story IR → lowered Scene IR → (layout) → (camera) → (validate) → Scene IR`.
 *
 * Deterministic + content-hash cached: identical script contents + pass versions ⇒ the cached
 * Scene IR is returned verbatim (byte-stable). Pass `cacheDir: null` to bypass the cache.
 */
export function runPipeline(
  scriptPath: string,
  opts: RunPipelineOptions = {}
): SceneIR {
  const rootDir = opts.rootDir ?? process.cwd();
  const fullScriptPath = resolvePath(rootDir, scriptPath);
  if (!existsSync(fullScriptPath)) {
    throw new Error(`script not found: ${fullScriptPath}`);
  }
  const scriptContents = readFileSync(fullScriptPath, 'utf8');

  // --- cache lookup ---
  const cachingEnabled = opts.cacheDir !== null;
  const cacheDir = opts.cacheDir ?? DEFAULT_CACHE_DIR;
  const key = cacheKey(scriptContents);
  const cacheFile = resolvePath(rootDir, cacheDir, `scene-${key}.json`);

  if (cachingEnabled && existsSync(cacheFile)) {
    const cached = JSON.parse(readFileSync(cacheFile, 'utf8')) as unknown;
    // Re-validate on read so a tampered/stale cache file can never inject an invalid IR.
    return validate(cached);
  }

  // --- front-end (P0 parse, P5 lower) ---
  const frontend = opts.frontend ?? DEFAULT_FRONTEND;
  const story = frontend.parse(scriptContents);
  const lowered = frontend.lower(story);

  // --- back-end (lite-P6 layout, lite-P8 camera, V validate) ---
  const scene = runBackend(lowered);

  // --- cache write ---
  if (cachingEnabled) {
    mkdirSync(dirname(cacheFile), { recursive: true });
    // Stable, human-diffable JSON (spec §15 acceptance #5: Scene IR is human-readable/diffable).
    writeFileSync(cacheFile, JSON.stringify(scene, null, 2) + '\n', 'utf8');
  }

  return scene;
}
