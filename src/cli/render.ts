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

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import objectHash from 'object-hash';

import { runPipeline, lowerStory } from '../pipeline/index.js';
import type { Frontend } from '../pipeline/index.js';
import { parseStory } from '../pipeline/parse.js';
import { Library } from '../library/index.js';
import type { SceneIR, Format } from '../ir/index.js';
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

// DISK SAFETY: Remotion writes its per-render webpack bundle + Chromium profile to os.tmpdir() (`/tmp`),
// which here is a SMALL tmpfs (7.7G, RAM-backed) — many renders accumulate 25MB bundles until it hits
// ENOSPC ("disk full") + crash. Redirect all render temp to a dir on the PROJECT partition (big disk)
// by setting TMPDIR BEFORE any bundle/Chromium temp is created. Bundles are also removed per-render
// (see prepare()/renderScene). This is the durable fix for the recurring "root partition full".
const RENDER_TMP = resolvePath(PROJECT_ROOT, '.render-tmp');
mkdirSync(RENDER_TMP, { recursive: true });
process.env.TMPDIR = RENDER_TMP;
// The composition root (render-entry.tsx) loads the enabled plugins before registering the Remotion
// root; it lives at the repo root so the engine core (src/) names no plugin (ADR-007).
const REMOTION_ENTRY = resolvePath(PROJECT_ROOT, 'render-entry.tsx');
const ENGINE = 'remotion@4.0.481';

/**
 * The library refs a compiled scene pins into its `project.lock` — DOMAIN-AGNOSTIC (ADR-007 #4).
 * Walks the Scene IR's resolved `defs` (the asset + rig defs the lowering pass emitted from ONLY the
 * refs the story declared) and reconstructs each as a `name@version` ref. Nothing hardcoded: a scene
 * with no rig pins no rig; a scene with three assets pins three. Def keys are bare names, so we pin
 * the canonical `name@1.0.0` (matching how lowering resolves an unversioned story ref). Sorted +
 * deduped for a stable, diffable lock.
 */
function lockRefsForScene(sceneIR: SceneIR): string[] {
  const refs = new Set<string>();
  const add = (name: string): void => {
    refs.add(name.includes('@') ? name : `${name}@1.0.0`);
  };
  for (const name of Object.keys(sceneIR.defs?.assets ?? {})) add(name);
  for (const name of Object.keys(sceneIR.defs?.rigs ?? {})) add(name);
  // Clip (nested-composition) defs are content-addressed library entries too — pin each one (and its
  // transitively-nested clips, all present in `defs.clips` after the recursive resolve) into the lock.
  for (const name of Object.keys(sceneIR.defs?.clips ?? {})) add(name);
  return [...refs].sort();
}

function libraryFrontend(library: Library, format?: Format): Frontend {
  return { parse: parseStory, lower: (story) => lowerStory(story, { library, format }) };
}

interface Args {
  target: string;
  id?: string | undefined;
  name?: string | undefined;
  frames?: string | undefined;
  gpu: boolean;
  /** I1: CLI override of the story's output format (aspect/size/fps). */
  format?: Format | undefined;
}
function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    // bare "--frames" (no value, or followed by another flag) → "auto"
    if (n === '--frames' && i >= 0 && (argv[i + 1] === undefined || argv[i + 1]!.startsWith('-'))) return 'auto';
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const num = (n: string): number | undefined => {
    const v = flag(n);
    const x = v !== undefined ? Number(v) : NaN;
    return Number.isFinite(x) ? x : undefined;
  };
  // I1: assemble an optional format override from --aspect/--fps/--width/--height.
  const fmt: Format = {};
  const aspect = flag('--aspect');
  if (aspect) fmt.aspect = aspect as Format['aspect'];
  const fps = num('--fps');
  if (fps !== undefined) fmt.fps = fps;
  const width = num('--width');
  if (width !== undefined) fmt.width = width;
  const height = num('--height');
  if (height !== undefined) fmt.height = height;
  const format = Object.keys(fmt).length > 0 ? fmt : undefined;
  return { target: positional[0] ?? 'examples/character.yaml', id: flag('--project'), name: flag('--name'), frames: flag('--frames'), gpu: argv.includes('--gpu'), format };
}

/**
 * Vendor the project's source artifacts into `assets/` so the bundle is SELF-CONTAINED and renders
 * without the shared library (cf. OTIO .otiod media copy / dotLottie asset bundling). Copies:
 *   • every `asset://…` file the scene references (from public/) → assets/<path>  (runtime-needed)
 *   • each procedural character's source spec + preview (from library/) → assets/characters/<id>/
 * Returns the vendored relative paths (recorded in the manifest). assets/ doubles as the render
 * publicDir, so the procedural spec (already inlined in scene.json) + these files are all it needs.
 */
function vendorAssets(sceneIR: SceneIR, paths: ProjectPaths): string[] {
  const vendored: string[] = [];
  const copy = (src: string, relInAssets: string): void => {
    if (!existsSync(src)) return;
    const dst = resolvePath(paths.dir, 'assets', relInAssets);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    vendored.push(`assets/${relInAssets}`);
  };
  // 1. asset:// files referenced anywhere in the scene (served from public/ at runtime)
  const uris = new Set<string>();
  JSON.stringify(sceneIR, (_k, v) => {
    if (typeof v === 'string' && v.startsWith('asset://')) uris.add(v);
    return v;
  });
  for (const uri of uris) {
    const rel = uri.replace(/^asset:\/\//, '').split('#')[0] ?? '';
    if (rel) copy(resolvePath(PROJECT_ROOT, 'public', rel), rel);
  }
  // 2. Rig source material, vendored for a self-contained bundle. Keyed on the rig URI SCHEME (a
  // generic data convention), NOT on any provider plugin name — core names no provider (ADR-007):
  //   • proc://<id>      — an inlined-spec entry: vendor its co-located <id>.spec.json + preview.
  //   • rig://<dir>/<base>.dbones.json — a skeletal-rig sidecar set: vendor the <base>_{ske,tex}.json
  //                        + <base>_tex.png the runtime loads from public/ via `staticFile`.
  // The spec itself is also inlined in scene.json; this copies the on-disk source the bundle needs.
  const rigs = (sceneIR.defs?.rigs ?? {}) as Record<string, { provider?: string; uri?: string }>;
  for (const def of Object.values(rigs)) {
    if (!def.uri) continue;
    if (def.uri.startsWith('proc://')) {
      const id = def.uri.replace(/^proc:\/\//, '').split('/')[0] ?? '';
      for (const f of [`${id}.spec.json`, `${id}.preview.png`]) {
        copy(resolvePath(PROJECT_ROOT, 'library', 'characters', id, f), `characters/${id}/${f}`);
      }
    } else if (def.uri.includes('://')) {
      // A sidecar-set rig URI (`rig://<dir>/<base>.dbones.json`): vendor the runtime's three source
      // files from public/ (parallel to the inlined-spec branch above).
      const noScheme = def.uri.slice(def.uri.indexOf('://') + 3);
      const slash = noScheme.lastIndexOf('/');
      const dir = slash >= 0 ? noScheme.slice(0, slash + 1) : '';
      const fileName = slash >= 0 ? noScheme.slice(slash + 1) : noScheme;
      const base = fileName.replace(/\.(dbones|ske)?\.?json$/i, '').replace(/\.[^.]+$/, '');
      for (const f of [`${base}_ske.json`, `${base}_tex.json`, `${base}_tex.png`]) {
        copy(resolvePath(PROJECT_ROOT, 'public', `${dir}${f}`), `${dir}${f}`);
      }
    }
  }
  return vendored;
}

// Render TIER (ADR-003 / DECISIONS): CPU raster (default) is byte-deterministic + disk-safe and is
// the canonical/shareable record. GPU ('angle', the iGPU) is faster but only PERCEPTUALLY identical
// (blur/alpha-heavy SVG composites in slightly different order/precision run-to-run, ~47-50dB PSNR =
// visually lossless). Opt into GPU with --gpu for speed/previews; verify those perceptually (SSIM/
// PSNR via tools/perceptual-diff.mjs), not byte-exact. NEVER software GL (swiftshader → disk balloon).
const chromiumOpts = (gpu: boolean) => (gpu ? { gl: 'angle' as const } : {});
const CONCURRENCY = Math.max(1, cpus().length - 2);

/** Bundle the project + select the composition for a Scene IR. Shared by video + stills. */
async function prepare(sceneIR: SceneIR, publicDir: string) {
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir,
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
  return { serveUrl, composition, inputProps };
}

/** Render the full Scene IR to an mp4. `gpu` opts into the fast (perceptual) iGPU tier. */
async function renderScene(sceneIR: SceneIR, videoOut: string, publicDir: string, gpu: boolean): Promise<{ frames: number }> {
  const { serveUrl, composition, inputProps } = await prepare(sceneIR, publicDir);
  try {
    console.log(`[render] video ${composition.width}x${composition.height}@${composition.fps} (${composition.durationInFrames}f) [${gpu ? 'GPU/perceptual' : 'CPU/byte-exact'}] → ${videoOut}`);
    await renderMedia({
      composition,
      serveUrl,
      codec: 'h264',
      outputLocation: videoOut,
      inputProps,
      imageFormat: 'png',
      concurrency: CONCURRENCY,
      chromiumOptions: chromiumOpts(gpu),
      // CPU tier pins single-pass encode for byte-identical mp4; GPU tier is perceptual anyway, so let
      // the encoder parallelize for more speed.
      disallowParallelEncoding: !gpu,
      x264Preset: 'faster',
      crf: 18,
      colorSpace: 'bt709',
    });
    return { frames: composition.durationInFrames };
  } finally {
    rmSync(serveUrl, { recursive: true, force: true }); // free the per-render bundle (disk safety)
  }
}

/**
 * FAST verification path: render a handful of STILL frames (PNG, no encode) instead of the full
 * video. Verify correctness + determinism on frames in seconds; render the video only for final
 * validation. Frames are byte-identical to the corresponding video frames (same scene IR + CPU raster).
 */
async function renderStills(sceneIR: SceneIR, framesDir: string, frameList: number[], publicDir: string, gpu: boolean): Promise<string[]> {
  const { serveUrl, composition, inputProps } = await prepare(sceneIR, publicDir);
  mkdirSync(framesDir, { recursive: true });
  const out: string[] = [];
  try {
    for (const frame of frameList) {
      const f = Math.min(Math.max(0, frame), composition.durationInFrames - 1);
      const output = resolvePath(framesDir, `frame-${String(f).padStart(4, '0')}.png`);
      await renderStill({ composition, serveUrl, output, frame: f, inputProps, imageFormat: 'png', chromiumOptions: chromiumOpts(gpu) });
      out.push(output);
    }
    console.log(`[render] ${out.length} still(s) → ${framesDir}`);
    return out;
  } finally {
    rmSync(serveUrl, { recursive: true, force: true }); // free the per-render bundle (disk safety)
  }
}

/** Parse a --frames spec into frame numbers. "auto" = 5 evenly-spaced; else a comma list (a,b,c). */
function parseFrames(spec: string, total: number): number[] {
  if (spec === 'auto' || spec === '') {
    const last = Math.max(0, total - 1);
    return [0, Math.round(last * 0.25), Math.round(last * 0.5), Math.round(last * 0.75), last];
  }
  return spec.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
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
  const { target, id: idFlag, name, frames, gpu, format } = parseArgs(process.argv.slice(2));

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
    sceneIR = runPipeline(storyPath, { rootDir: PROJECT_ROOT, frontend: libraryFrontend(library, format), cacheKeyExtra: format });

    const refs = lockRefsForScene(sceneIR);
    writeSource(paths, readFileSync(storyPath, 'utf8'));
    writeSceneIR(paths, sceneIR);
    writeFileSync(paths.lock, JSON.stringify(library.buildLock(refs), null, 2) + '\n', 'utf8');
    const assets = vendorAssets(sceneIR, paths); // make the bundle self-contained
    console.log(`[render] vendored ${assets.length} source artifact(s) → projects/${id}/assets/`);

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
      assets,
      outputs: { video: 'media/out.mp4', thumbnail: 'media/thumbnail.png' },
    };
    writeManifest(paths, manifest);
    console.log(`[render] project written → projects/${id}/`);
  }

  const publicDir = resolvePath(paths.dir, 'assets');

  // FAST PATH: --frames renders stills only (verification), skipping the slow video encode.
  if (frames !== undefined) {
    const list = parseFrames(frames, sceneIR.config.duration_frames);
    const out = await renderStills(sceneIR, resolvePath(paths.mediaDir, 'frames'), list, publicDir, gpu);
    console.log(`[render] frames done → ${out.length} PNG(s) at ${list.join(',')}`);
    return;
  }

  const meta = await renderScene(sceneIR, paths.video, publicDir, gpu);
  makeThumbnail(paths, Math.min(30, Math.max(0, meta.frames - 1)));
  console.log(`[render] done → ${paths.video}`);
}

main().catch((err: unknown) => {
  console.error('[render] failed:', err);
  process.exit(1);
});
