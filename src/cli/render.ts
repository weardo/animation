// CLI — `build:m1`: the single command that turns a story script into out.mp4. Spec §15 (M1
// acceptance #1: "script.yaml → out.mp4 runs with a single command; no manual steps").
//
// Flow (all deterministic — CLAUDE.md golden rule 1):
//   1. Resolve the project root + script path (default examples/neuron.yaml).
//   2. Open the library catalog (library/index.json) and bind it into the lowering pass, so
//      asset/rig refs resolve name@version → content hash through the registry (spec §15 seam).
//   3. runPipeline(script) → validated Scene IR (P0 parse → P5 lower → lite layout/camera → V).
//   4. Write the Scene IR to .cache/scene.json (human-readable/diffable; acceptance #5) and pin
//      the resolved library hashes into animation.lock (deterministic re-renders; spec §13.2).
//   5. bundle() the Remotion entry → selectComposition() with the Scene IR as inputProps (this runs
//      calculateMetadata so w/h/fps/duration come straight from the IR config) → renderMedia() with
//      the SAME Scene IR as inputProps → out.mp4.
//
// DETERMINISM render settings (spike-proven, spec §14.1 retired risk): PNG intermediate frames,
// the ANGLE GL backend (so WebGL/Pixi/DragonBones is reproducible), concurrency 1. Two runs of the
// same script produce a byte-identical MP4 (acceptance #4).

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';

import { runPipeline, lowerStory, M1_REFS } from '../pipeline/index.js';
import type { Frontend } from '../pipeline/index.js';
import { parseStory } from '../pipeline/parse.js';
import { Library } from '../library/index.js';
import type { SceneIR } from '../ir/index.js';
import { COMPOSITION_ID } from '../render/Root.js';

/** Project root = two levels up from this file (src/cli/ → src/ → root). */
const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The Remotion entry that registers the SceneIR composition (registerRoot lives here). */
const REMOTION_ENTRY = resolvePath(PROJECT_ROOT, 'src', 'render', 'index.ts');

/** The library refs the M1 slice depends on — pinned into animation.lock for deterministic renders. */
const M1_LOCK_REFS = [M1_REFS.background, M1_REFS.beadStringPath, M1_REFS.rig] as const;

interface CliOptions {
  scriptPath: string;
  outPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  const positional = argv.filter((a) => !a.startsWith('-'));
  return {
    scriptPath: positional[0] ?? 'examples/neuron.yaml',
    outPath: positional[1] ?? 'out.mp4',
  };
}

/** Build a Frontend whose lowering pass resolves refs through the live library catalog (P2 seam). */
function libraryFrontend(library: Library): Frontend {
  return {
    parse: parseStory,
    lower: (story) => lowerStory(story, { library }),
  };
}

async function main(): Promise<void> {
  const { scriptPath, outPath } = parseArgs(process.argv.slice(2));
  const fullOut = resolvePath(PROJECT_ROOT, outPath);

  // --- 1+2. Open the library and bind it into the lowering pass. ---
  const library = Library.open(PROJECT_ROOT);

  // --- 3. Run the pipeline → validated Scene IR. ---
  console.log(`[build:m1] pipeline: ${scriptPath}`);
  const sceneIR: SceneIR = runPipeline(scriptPath, {
    rootDir: PROJECT_ROOT,
    frontend: libraryFrontend(library),
  });

  // --- 4. Persist the Scene IR (.cache/scene.json) + pin library hashes (animation.lock). ---
  const cacheDir = resolvePath(PROJECT_ROOT, '.cache');
  mkdirSync(cacheDir, { recursive: true });
  const sceneJsonPath = resolvePath(cacheDir, 'scene.json');
  writeFileSync(sceneJsonPath, JSON.stringify(sceneIR, null, 2) + '\n', 'utf8');
  console.log(`[build:m1] scene IR → ${sceneJsonPath}`);

  const lockPath = library.writeLock(M1_LOCK_REFS);
  console.log(`[build:m1] library lock → ${lockPath}`);

  // --- 5. Bundle → select composition (calculateMetadata from IR config) → render. ---
  console.log('[build:m1] bundling Remotion project…');
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir: resolvePath(PROJECT_ROOT, 'public'),
    // The codebase authors ESM/NodeNext-style `.js` import specifiers that point at `.ts`/`.tsx`
    // source (tsx resolves these natively). Teach Remotion's webpack the same mapping so the
    // browser bundle resolves `./Root.js` → `Root.tsx` etc.
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: {
          ...(config.resolve?.extensionAlias ?? {}),
          '.js': ['.ts', '.tsx', '.js'],
          '.jsx': ['.tsx', '.jsx'],
        },
      },
    }),
  });

  const inputProps = sceneIR as unknown as Record<string, unknown>;

  console.log(`[build:m1] selecting composition "${COMPOSITION_ID}"…`);
  const composition = await selectComposition({
    serveUrl,
    id: COMPOSITION_ID,
    inputProps,
  });

  console.log(
    `[build:m1] rendering ${composition.width}x${composition.height}@${composition.fps} ` +
      `(${composition.durationInFrames} frames) → ${fullOut}`,
  );
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: fullOut,
    inputProps,
    // --- deterministic render settings (spec §14.1 / spike) ---
    imageFormat: 'png', // lossless intermediate frames (no JPEG quantization variance)
    concurrency: 1, // single browser worker (the absolute-seek rig path is order-independent anyway)
    // SOFTWARE GL backend (SwiftShader): hardware 'angle' rasterizes WebGL non-deterministically
    // across independent runs (GPU/driver float variance), breaking byte-identical determinism.
    // 'swangle' rasterizes in software → reproducible Pixi/DragonBones frames. Verified 2026-06-22.
    chromiumOptions: { gl: 'swangle' },
    // Pin the H.264 encode so the MUXED MP4 is byte-identical too, not just the source frames:
    // sequential single-pass encoding (no thread-scheduling variance) + fixed preset/crf.
    disallowParallelEncoding: true,
    x264Preset: 'medium',
    crf: 18,
    colorSpace: 'bt709',
  });

  console.log(`[build:m1] done → ${fullOut}`);
}

main().catch((err: unknown) => {
  console.error('[build:m1] failed:', err);
  process.exit(1);
});
