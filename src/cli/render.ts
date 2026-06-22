// CLI — project-centric render. A video is a PROJECT (src/project): a reproducible bundle of
// {story.yaml, scene.json, project.lock, project.json, media/}. Two modes:
//
//   tsx render.ts <story.yaml> --project <id> [--name N]   COMPILE a story into projects/<id>/ and render
//   tsx render.ts <id>                                      RE-RENDER an existing project from its pinned
//                                                           scene.json (+ project.lock) → byte-identical
//
// Compile path: parse+lower+validate the Story IR → Scene IR, write all project artifacts, pin the
// library deps into project.lock, then render. Reproduce path: read the project's scene.json and
// render it directly (no pipeline, no library re-resolution) — the lock guarantees the same bytes
// even if the shared library has since changed.
//
// DETERMINISM: scene.json is the deterministic engine input; gl:'angle' (procedural scenes are SVG/
// DOM-deterministic — NEVER software GL, which balloons Chromium CacheStorage and fills the disk).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia } from '@remotion/renderer';
import objectHash from 'object-hash';

import { runPipeline, lowerStory, M1_REFS } from '../pipeline/index.js';
import type { Frontend } from '../pipeline/index.js';
import { parseStory } from '../pipeline/parse.js';
import { Library } from '../library/index.js';
import type { SceneIR } from '../ir/index.js';
import { COMPOSITION_ID } from '../render/Root.js';
import {
  projectPaths,
  projectExists,
  ensureDirs,
  writeSource,
  writeSceneIR,
  readSceneIR,
  writeManifest,
  type ProjectPaths,
  type ProjectManifest,
} from '../project/index.js';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REMOTION_ENTRY = resolvePath(PROJECT_ROOT, 'src', 'render', 'index.ts');
const ENGINE = 'remotion@4.0.481';

/** Library refs a story pins into its project.lock (background + bead-string path + the rig). */
function lockRefsForScript(scriptPath: string): string[] {
  const story = parseStory(readFileSync(scriptPath, 'utf8'));
  const firstChar = Object.values(story.characters)[0];
  const rigRef = firstChar ? (firstChar.rig.includes('@') ? firstChar.rig : `${firstChar.rig}@1.0.0`) : M1_REFS.rig;
  return [M1_REFS.background, M1_REFS.beadStringPath, rigRef];
}

function libraryFrontend(library: Library): Frontend {
  return { parse: parseStory, lower: (story) => lowerStory(story, { library }) };
}

interface Args {
  target: string;
  id?: string | undefined;
  name?: string | undefined;
}
function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { target: positional[0] ?? 'examples/character.yaml', id: flag('--project'), name: flag('--name') };
}

/** Bundle + select + render a Scene IR to an mp4. Shared by both modes. */
async function renderScene(sceneIR: SceneIR, videoOut: string): Promise<{ frames: number; w: number; h: number; fps: number }> {
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir: resolvePath(PROJECT_ROOT, 'public'),
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: { ...(config.resolve?.extensionAlias ?? {}), '.js': ['.ts', '.tsx', '.js'], '.jsx': ['.tsx', '.jsx'] },
      },
    }),
  });
  const inputProps = sceneIR as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  console.log(`[render] ${composition.width}x${composition.height}@${composition.fps} (${composition.durationInFrames}f) → ${videoOut}`);
  await renderMedia({
    composition,
    serveUrl,
    codec: 'h264',
    outputLocation: videoOut,
    inputProps,
    imageFormat: 'png',
    concurrency: 1,
    // gl:'angle' — procedural scenes are SVG/DOM-deterministic; software GL ('swiftshader') balloons
    // Chromium CacheStorage to ~26GB and crashes (verified 2026-06-22). See DECISIONS.
    chromiumOptions: { gl: 'angle' },
    disallowParallelEncoding: true,
    x264Preset: 'medium',
    crf: 18,
    colorSpace: 'bt709',
  });
  return { frames: composition.durationInFrames, w: composition.width, h: composition.height, fps: composition.fps };
}

/** Extract a poster frame from the rendered video (ffmpeg). Best-effort; non-fatal on failure. */
function makeThumbnail(p: ProjectPaths, frame: number): void {
  try {
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', p.video, '-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', p.thumbnail]);
  } catch {
    console.warn('[render] thumbnail skipped (ffmpeg unavailable)');
  }
}

async function main(): Promise<void> {
  const { target, id: idFlag, name } = parseArgs(process.argv.slice(2));

  let paths: ProjectPaths;
  let sceneIR: SceneIR;

  if (projectExists(PROJECT_ROOT, target)) {
    // --- reproduce: render an existing project from its pinned scene.json ---
    paths = projectPaths(PROJECT_ROOT, target);
    ensureDirs(paths);
    sceneIR = readSceneIR(paths);
    console.log(`[render] project '${target}' — reproducing from scene.json`);
  } else {
    // --- compile: a story file → a project ---
    const storyPath = resolvePath(PROJECT_ROOT, target);
    if (!existsSync(storyPath)) {
      throw new Error(`'${target}' is neither an existing project id nor a story file`);
    }
    const id = idFlag ?? basename(target).replace(/\.[^.]+$/, '');
    paths = projectPaths(PROJECT_ROOT, id);
    ensureDirs(paths);

    const library = Library.open(PROJECT_ROOT);
    console.log(`[render] compiling '${target}' → project '${id}'`);
    sceneIR = runPipeline(storyPath, { rootDir: PROJECT_ROOT, frontend: libraryFrontend(library) });

    const refs = lockRefsForScript(storyPath);
    writeSource(paths, readFileSync(storyPath, 'utf8'));
    writeSceneIR(paths, sceneIR);
    writeFileSync(paths.lock, JSON.stringify(library.buildLock(refs), null, 2) + '\n', 'utf8');

    const now = new Date().toISOString();
    const manifest: ProjectManifest = {
      project_version: '1.0',
      id,
      name: name ?? id,
      created: now,
      updated: now,
      config: sceneIR.config,
      source: 'story.yaml',
      scene: 'scene.json',
      lock: 'project.lock',
      scene_ir_hash: objectHash(sceneIR),
      engine: ENGINE,
      deps: refs,
      outputs: { video: 'media/out.mp4', thumbnail: 'media/thumbnail.png' },
    };
    writeManifest(paths, manifest);
    console.log(`[render] project written → projects/${id}/`);
  }

  const meta = await renderScene(sceneIR, paths.video);
  makeThumbnail(paths, Math.min(30, Math.max(0, meta.frames - 1)));
  console.log(`[render] done → ${paths.video}`);
}

main().catch((err: unknown) => {
  console.error('[render] failed:', err);
  process.exit(1);
});
