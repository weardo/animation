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

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, createWriteStream } from 'node:fs';
import type { WriteStream } from 'node:fs';
import { resolve as resolvePath, dirname, basename } from 'node:path';
import { cpus, freemem } from 'node:os';
import { inspect } from 'node:util';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill } from '@remotion/renderer';
import webpack from 'webpack';
import objectHash from 'object-hash';

import { runPipeline, lowerStory } from '../pipeline/index.js';
import type { Frontend } from '../pipeline/index.js';
import { parseStory } from '../pipeline/parse.js';
import { PublishSchema } from '../ir/story.js';
import { withLocalClips, isLocalClip } from '../pipeline/project-clips.js';
import { Library } from '../library/index.js';
import type { SceneIR, Format } from '../ir/index.js';
import { applyNarration } from './narrate-pass.js';
import { applySfx } from './sfx-pass.js';
import { applyMusic } from './music-pass.js';
import { applyAudioTracks } from './audio-pass.js';
import type { NarrateEngine } from './narrate.js';
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
function lockRefsForScene(sceneIR: SceneIR, projectDir?: string): string[] {
  const refs = new Set<string>();
  const add = (name: string): void => {
    refs.add(name.includes('@') ? name : `${name}@1.0.0`);
  };
  for (const name of Object.keys(sceneIR.defs?.assets ?? {})) add(name);
  for (const name of Object.keys(sceneIR.defs?.rigs ?? {})) add(name);
  // Clip defs from the shared library are pinned; PROJECT-LOCAL rigs (a `<projectDir>/rigs/<name>.clip.*`
  // file) are NOT library deps — they travel inside the project bundle, so they are excluded from the lock.
  for (const name of Object.keys(sceneIR.defs?.clips ?? {})) {
    if (projectDir && isLocalClip(projectDir, name)) continue;
    add(name);
  }
  return [...refs].sort();
}

function libraryFrontend(library: Library, format?: Format, projectDir?: string): Frontend {
  // PROJECT-LOCAL rigs (golden rule 6): clip refs resolve from the portable project's own `<dir>/rigs/`
  // first, then fall back to the shared library. `projectDir` is the story's own directory.
  const lib = projectDir ? withLocalClips(library, projectDir) : library;
  return { parse: parseStory, lower: (story) => lowerStory(story, { library: lib, format }) };
}

// P3: output container/codec selection. The DEFAULT stays h264 mp4 (byte-deterministic on the CPU
// tier — the canonical record). `--format` picks the container; `--codec` overrides the codec within
// it; `--alpha` switches to a transparency-capable codec + yuva420p (vp8/vp9 webm) or prores4444
// (.mov) + a png-sequence escape hatch. We name the codec to Remotion's vocabulary verbatim and let
// Remotion own the encode (NEVER reimplement a Remotion primitive — ADR-003).
type OutFormat = 'mp4' | 'webm' | 'gif' | 'mov' | 'png-sequence';
type VideoCodec = 'h264' | 'h265' | 'vp8' | 'vp9' | 'prores' | 'gif';
/** Container → its default video codec (mirrors Remotion's defaultCodecsForFileExtension). */
const FORMAT_DEFAULT_CODEC: Record<Exclude<OutFormat, 'png-sequence'>, VideoCodec> = {
  mp4: 'h264',
  webm: 'vp8',
  gif: 'gif',
  mov: 'prores',
};
/** Container → output file extension. */
const FORMAT_EXT: Record<Exclude<OutFormat, 'png-sequence'>, string> = {
  mp4: 'mp4',
  webm: 'webm',
  gif: 'gif',
  mov: 'mov',
};
/** Codecs that can carry an alpha channel, and the matching alpha container. */
const ALPHA_CODEC: Record<'vp8' | 'vp9' | 'prores', { ext: string; pixelFormat: 'yuva420p' | undefined }> = {
  vp8: { ext: 'webm', pixelFormat: 'yuva420p' },
  vp9: { ext: 'webm', pixelFormat: 'yuva420p' },
  // ProRes 4444 carries alpha in the codec itself (no yuva pixel-format flag needed).
  prores: { ext: 'mov', pixelFormat: undefined },
};

interface OutSpec {
  /** png-sequence renders a frame folder (transparent PNGs); else a single muxed file. */
  kind: 'video' | 'png-sequence';
  codec: VideoCodec;
  ext: string;
  pixelFormat?: 'yuva420p' | undefined;
  /** ProRes profile — '4444' for alpha, else undefined (Remotion default). */
  proResProfile?: '4444' | undefined;
  alpha: boolean;
}

interface Args {
  target: string;
  id?: string | undefined;
  name?: string | undefined;
  frames?: string | undefined;
  gpu: boolean;
  /** I1: CLI override of the story's output format (aspect/size/fps). */
  format?: Format | undefined;
  /** P3: output container/codec/alpha selection. */
  out: OutSpec;
  /** M3 narration: synthesize TTS from beats' `say` into audio[] cues. `--no-audio` skips it. */
  audio: boolean;
  engine?: NarrateEngine | undefined;
  voice?: string | undefined;
  wpm?: number | undefined;
  /** A1 captions: emit narration-synced on-screen subtitles (default on). `--no-captions` skips it. */
  captions: boolean;
  /** Caption cadence: `line` (default) or `words` (cumulative reveal; whisper-timed when available). */
  captionMode?: 'line' | 'words' | undefined;
  /** M4 word-align: force-align captions with whisper for precise word timing (default on, `words` mode). */
  wordAlign: boolean;
  /** M4b lip-sync: derive a mouth track from narration to drive the speaker rig (default on). `--no-lip-sync` skips it. */
  lipSync: boolean;
  /** A3 music bed: play+duck the story's `music` track (default on). `--no-music` skips it. */
  music: boolean;
}

/**
 * P3: resolve --format / --codec / --alpha into a concrete codec + container + pixel format.
 * Defaults to h264 mp4 (opaque, byte-deterministic). --alpha forces a transparency-capable target:
 *   • --alpha (webm/default)  → vp9 + yuva420p webm   (vp8/vp9 carry alpha via the pixel format)
 *   • --alpha --format mov    → prores 4444 .mov       (alpha in-codec, full quality, big files)
 *   • --alpha --format png-sequence → a folder of transparent PNGs (lossless, no encode)
 * An explicit --codec wins over the container default. We validate alpha-capability so a nonsense
 * combo (e.g. --alpha --codec h264) fails loudly instead of silently flattening transparency.
 */
function resolveOutSpec(formatFlag: string | undefined, codecFlag: string | undefined, alpha: boolean): OutSpec {
  // png-sequence is its own (codec-less) output target.
  if (formatFlag === 'png-sequence' || formatFlag === 'pngs' || formatFlag === 'png') {
    return { kind: 'png-sequence', codec: 'h264', ext: 'png', alpha, pixelFormat: alpha ? 'yuva420p' : undefined };
  }

  if (alpha) {
    // Alpha defaults to vp9 webm; --format mov upgrades to ProRes 4444; --codec narrows the webm codec.
    let codec: 'vp8' | 'vp9' | 'prores' =
      formatFlag === 'mov' ? 'prores' : (codecFlag === 'vp8' ? 'vp8' : 'vp9');
    if (codecFlag === 'prores') codec = 'prores';
    if (codecFlag === 'vp8') codec = 'vp8';
    if (codecFlag === 'vp9') codec = 'vp9';
    if (codecFlag && !(codecFlag in ALPHA_CODEC)) {
      throw new Error(`--alpha needs an alpha-capable --codec (vp8|vp9|prores); got '${codecFlag}'`);
    }
    const a = ALPHA_CODEC[codec];
    return {
      kind: 'video',
      codec,
      ext: a.ext,
      pixelFormat: a.pixelFormat,
      proResProfile: codec === 'prores' ? '4444' : undefined,
      alpha: true,
    };
  }

  const format = (formatFlag ?? 'mp4') as Exclude<OutFormat, 'png-sequence'>;
  if (!(format in FORMAT_DEFAULT_CODEC)) {
    throw new Error(`unknown --format '${formatFlag}' (mp4|webm|gif|mov|png-sequence)`);
  }
  const codec = (codecFlag as VideoCodec | undefined) ?? FORMAT_DEFAULT_CODEC[format];
  return { kind: 'video', codec, ext: FORMAT_EXT[format], alpha: false };
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
  // P3: --format (container/output) is distinct from the I1 --aspect/--fps size override above.
  const out = resolveOutSpec(flag('--format'), flag('--codec'), argv.includes('--alpha'));
  // M3 narration: on by default in the compile path; --no-audio skips TTS (existing silent demos /
  // CI). --engine (espeak-ng|coqui) + --voice + --wpm tune the OFFLINE synth; the cached wav is the
  // deterministic artifact regardless. ENGINE env override: NARRATE_ENGINE.
  const audio = !argv.includes('--no-audio');
  const engine = (flag('--engine') ?? process.env['NARRATE_ENGINE']) as NarrateEngine | undefined;
  const voice = flag('--voice') ?? process.env['NARRATE_VOICE'];
  const wpm = num('--wpm');
  // A1 captions: narration-synced subtitles, on by default with narration; --no-captions skips them.
  // --caption-mode line|words selects the on-screen cadence (default line).
  const captions = !argv.includes('--no-captions');
  const captionMode = (flag('--caption-mode') === 'words' ? 'words' : 'line') as 'line' | 'words';
  // M4 word-align: whisper forced-alignment for precise per-word caption timing (`words` mode). On by
  // default; --no-word-align skips the (slow first-run) whisper step and uses even-split directly.
  const wordAlign = !argv.includes('--no-word-align');
  // M4b lip-sync: derive a mouth/viseme track from narration to drive the speaker rig (on by default
  // under the --no-audio master switch); --no-lip-sync skips just the mouth derivation.
  const lipSync = !argv.includes('--no-lip-sync');
  // A3 music bed: on by default (under the same --no-audio master switch); --no-music skips just music.
  const music = !argv.includes('--no-music');
  // GPU (Iris Xe / gl:'angle') is now the DEFAULT — faster, and only PERCEPTUALLY identical, which is
  // fine because the factory verifies the GPU tier with VMAF, not byte-exact cmp (CLAUDE.md M6). Opt OUT
  // with `--no-gpu` (or RENDER_GPU=0) for the CPU byte-exact path the determinism/golden-fixture gate
  // uses (verify-render). `--gpu` is still accepted (redundant no-op now).
  const gpu = !argv.includes('--no-gpu') && process.env['RENDER_GPU'] !== '0';
  return { target: positional[0] ?? 'examples/character.yaml', id: flag('--project'), name: flag('--name'), frames: flag('--frames'), gpu, format, out, audio, engine, voice, wpm, captions, captionMode, wordAlign, lipSync, music };
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
  // 1b. RUNTIME fonts the compositor references in CODE, not in the scene data — CaptionTrack.tsx loads
  // the caption font stack ("Noto Sans Devanagari", "DejaVu Sans") directly, so it isn't caught by the
  // scene-URI scan above. Vendor them UNCONDITIONALLY (captions are on by default) so a fresh project
  // never 404s the caption font. Keep this list in sync with CaptionTrack's CAPTION_FONT stack.
  for (const rel of ['fonts/NotoSansDevanagari.ttf', 'fonts/DejaVuSans.ttf']) {
    copy(resolvePath(PROJECT_ROOT, 'public', rel), rel);
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
      // An inlined-spec rig: vendor its co-located sidecar. The spec lives under the entry's namespace
      // dir (characters/ for actors, props/ for props) — try the known namespaces (a data convention,
      // mirroring the loader); core names no provider→namespace mapping. The spec is also inlined in
      // scene.json, so a missing file is harmless (the provider falls back to its own default spec).
      const id = def.uri.replace(/^proc:\/\//, '').split('/')[0] ?? '';
      for (const ns of ['characters', 'props', 'objects']) {
        for (const f of [`${id}.spec.json`, `${id}.preview.png`]) {
          copy(resolvePath(PROJECT_ROOT, 'library', ns, id, f), `${ns}/${id}/${f}`);
        }
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
// RAM-AWARE concurrency. Each headless-Chrome render worker needs ~1.3 GB (more for blur/alpha-heavy
// SVG); `cpu-2` alone is RAM-blind, so on a memory-constrained box it spawns too many workers and Chrome
// OOM-crashes mid-render ("Target closed" / "browser crashed while rendering frame N, retrying"). Cap the
// default by BOTH cores (`cpu-2`) and free memory (~1.3 GB/worker, min 1) so renders stay stable here.
// `RENDER_CONCURRENCY` overrides explicitly (e.g. on a fat machine). See DECISIONS 2026-06-23.
// Conservative RAM model: each headless-Chrome worker (blur-heavy SVG + a footage/video decode) balloons
// well past the naive estimate, and freemem() at LAUNCH over-reads (workers haven't spawned yet) — so the
// old 1.3 GB/worker with no reserve spawned ~14 workers that then THRASHED swap (the ~7-min render). Now:
// reserve a base for the OS + node/Chrome parents, budget ~2 GB/worker, and hard-cap at 6 so a
// mostly-free box never over-provisions. `RENDER_CONCURRENCY` still overrides. See DECISIONS 2026-06-23.
const BASE_RESERVE_BYTES = 4 * 1024 * 1024 * 1024;
const PER_WORKER_BYTES = 2 * 1024 * 1024 * 1024;
const CONCURRENCY_HARD_CAP = 6;
const CONCURRENCY = process.env['RENDER_CONCURRENCY']
  ? Math.max(1, Number(process.env['RENDER_CONCURRENCY']))
  : Math.max(
      1,
      Math.min(
        cpus().length - 2,
        CONCURRENCY_HARD_CAP,
        Math.floor((freemem() - BASE_RESERVE_BYTES) / PER_WORKER_BYTES),
      ),
    );

/**
 * Bundle the project + select the composition for a Scene IR. Shared by video + stills.
 * P3 (alpha): when `alpha` is set we overlay a TRANSIENT `_alpha` flag onto the inputProps (NOT onto
 * scene.json — the canonical record stays a pure Scene IR). The compositor reads it to render on a
 * transparent canvas (omit the bg fill + drop backdrop layers) so the RGBA channel survives.
 */
async function prepare(sceneIR: SceneIR, publicDir: string, alpha = false, gpu = false) {
  const serveUrl = await bundle({
    entryPoint: REMOTION_ENTRY,
    publicDir,
    webpackOverride: (config) => ({
      ...config,
      resolve: {
        ...config.resolve,
        extensionAlias: { ...(config.resolve?.extensionAlias ?? {}), '.js': ['.ts', '.tsx', '.js'], '.jsx': ['.tsx', '.jsx'] },
      },
      // TIER GATE (M6): bake the GPU-tier flag into the bundle so render-entry registers the gpu-effects
      // plugin ONLY for a `--gpu` build. DefinePlugin replaces `process.env.GPU_TIER` with a literal, so
      // a CPU bundle (gpu=false) statically drops the GPU plugin branch (and tree-shakes its WebGL code)
      // → the CPU raster tier is byte-identical to before. A GPU bundle wires the perceptual tier in.
      plugins: [
        ...(config.plugins ?? []),
        new webpack.DefinePlugin({ 'process.env.GPU_TIER': JSON.stringify(gpu ? '1' : '') }),
      ],
    }),
  });
  const inputProps = (alpha
    ? { ...(sceneIR as unknown as Record<string, unknown>), _alpha: true }
    : (sceneIR as unknown as Record<string, unknown>));
  const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, inputProps });
  return { serveUrl, composition, inputProps };
}

/**
 * Render the full Scene IR to a muxed video. `gpu` opts into the fast (perceptual) iGPU tier; `out`
 * selects the codec/container/alpha (default h264 mp4). Remotion owns the encode (ADR-003: never
 * reimplement a primitive). x264-specific tuning (preset/crf) only applies to the h264 codecs.
 */
// ── PERSISTENT RENDER LOG ─────────────────────────────────────────────────────────────────────────
// Every render TEES its progress to `projects/<id>/media/render.log` (truncated per run), so a render
// is ALWAYS monitorable/predictable — `tail -f projects/<id>/media/render.log` from anywhere, whether
// the render runs in the foreground, background, or detached. All the CLI's stage lines (compile /
// narrate / sfx / music / vendor / done / errors) are captured via a console tee; per-frame video
// progress is written fine-grained (for live tailing + stall detection) directly to the stream. This
// log is a SIDECAR diagnostic — NOT part of the deterministic output (golden rule 1 governs frame
// content, a wall-clock-stamped text log alongside the mp4 is like console output, which already runs).
let renderLog: WriteStream | undefined;
const stamp = (): string => new Date().toISOString().slice(11, 19);

/** Open (truncate) media/render.log + tee console.{log,warn,error} into it. Returns a restore/close fn. */
function startRenderLog(mediaDir: string): () => void {
  mkdirSync(mediaDir, { recursive: true });
  renderLog = createWriteStream(resolvePath(mediaDir, 'render.log'), { flags: 'w' });
  const orig = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
  const fmt = (args: unknown[]): string => args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
  const tee = (level: string, base: (...a: unknown[]) => void) => (...a: unknown[]): void => {
    renderLog?.write(`${stamp()} ${level}${fmt(a)}\n`);
    base(...a);
  };
  console.log = tee('', orig.log);
  console.warn = tee('WARN ', orig.warn);
  console.error = tee('ERROR ', orig.error);
  renderLog.write(`${stamp()} [render] === render started ===\n`);
  return () => {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
    renderLog?.end();
    renderLog = undefined;
  };
}

async function renderScene(sceneIR: SceneIR, videoOut: string, publicDir: string, gpu: boolean, out: OutSpec): Promise<{ frames: number }> {
  const { serveUrl, composition, inputProps } = await prepare(sceneIR, publicDir, out.alpha, gpu);
  const isH264 = out.codec === 'h264' || out.codec === 'h265';
  let progressPct = -1; // throttle terminal progress to 5% steps (render.log stays fine-grained)
  try {
    console.log(`[render] video ${composition.width}x${composition.height}@${composition.fps} (${composition.durationInFrames}f) [${gpu ? 'GPU/perceptual' : 'CPU/byte-exact'}] codec=${out.codec}${out.alpha ? ' +alpha' : ''} → ${videoOut}`);
    await renderMedia({
      composition,
      serveUrl,
      codec: out.codec,
      outputLocation: videoOut,
      inputProps,
      // Alpha needs an RGBA-capable frame source: PNG carries the alpha channel into the encoder.
      imageFormat: 'png',
      ...(out.pixelFormat ? { pixelFormat: out.pixelFormat } : {}),
      ...(out.proResProfile ? { proResProfile: out.proResProfile } : {}),
      concurrency: CONCURRENCY,
      chromiumOptions: chromiumOpts(gpu),
      // PROGRESS: fine-grained → render.log (live tailing + stall detection), throttled → terminal.
      // A frame count that stops advancing while the process lives = a HANG at that exact frame → beat.
      onProgress: ({ renderedFrames, encodedFrames, stitchStage }) => {
        const total = composition.durationInFrames || 1;
        const pct = Math.floor((renderedFrames / total) * 100);
        renderLog?.write(`${stamp()}   ${pct}% frame ${renderedFrames}/${total} encoded=${encodedFrames} ${stitchStage}\n`);
        if (pct >= progressPct + 5) {
          progressPct = pct;
          process.stdout.write(`[render]   ${pct}%  (${renderedFrames}/${total} frames, ${encodedFrames} encoded, ${stitchStage})\n`);
        }
      },
      // CPU tier pins single-pass encode for byte-identical output; GPU tier is perceptual anyway, so
      // let the encoder parallelize for more speed. ALPHA MUST allow parallel encoding: Remotion's
      // pre-encode (disallowParallelEncoding) path drops the `-pix_fmt yuva420p`/`-auto-alt-ref 0`
      // flags (ffmpeg-args.js `firstEncodingStepOnly` early-returns when `hasPreencoded`), flattening
      // transparency. The deterministic/byte-exact canonical record is the default h264 mp4 anyway;
      // the alpha (webm/mov) tier is for delivery/compositing, so it opts out of the single-pass pin.
      disallowParallelEncoding: !gpu && !out.alpha,
      ...(isH264 ? { x264Preset: 'faster' as const, crf: 18, colorSpace: 'bt709' as const } : {}),
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
async function renderStills(sceneIR: SceneIR, framesDir: string, frameList: number[], publicDir: string, gpu: boolean, alpha = false): Promise<string[]> {
  const { serveUrl, composition, inputProps } = await prepare(sceneIR, publicDir, alpha, gpu);
  mkdirSync(framesDir, { recursive: true });
  const out: string[] = [];
  try {
    for (const frame of frameList) {
      const f = Math.min(Math.max(0, frame), composition.durationInFrames - 1);
      const output = resolvePath(framesDir, `frame-${String(f).padStart(4, '0')}.png`);
      // imageFormat:'png' + a transparent canvas (_alpha overlay) makes renderStill write RGBA PNGs.
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
  const { target, id: idFlag, name, frames, gpu, format, out, audio, engine, voice, wpm, captions, captionMode, wordAlign, lipSync, music } = parseArgs(process.argv.slice(2));

  // Start the persistent render log up front (before any stage runs) so EVERY line — compile through
  // done, or a crash — is captured to projects/<id>/media/render.log. The id is resolved the same way
  // the branches below do (existing project id, else --id, else the story basename).
  const projId = projectExists(PROJECT_ROOT, target) ? target : (idFlag ?? basename(target).replace(/\.[^.]+$/, ''));
  const closeRenderLog = startRenderLog(projectPaths(PROJECT_ROOT, projId).mediaDir);
  try {
    await runRender();
  } finally {
    closeRenderLog();
  }

  async function runRender(): Promise<void> {
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
    sceneIR = runPipeline(storyPath, { rootDir: PROJECT_ROOT, frontend: libraryFrontend(library, format, dirname(storyPath)), cacheKeyExtra: format });

    // Parse the story ONCE (pure) — reused by the audio passes below AND the manifest's publish block.
    const story = parseStory(readFileSync(storyPath, 'utf8'));

    // M3 NARRATION (OFFLINE asset-gen; golden rule 2). When beats carry `say` and audio isn't disabled,
    // synthesize TTS into the project's self-contained assets/audio/ (content-addressed, cached) and
    // emit `audio[]` cues onto the timeline at each beat's scene start. The cached wav is the
    // deterministic artifact (golden rule 1), so the muxed video re-renders byte-identically. The wavs
    // are generated DIRECTLY into the render publicDir (assets/), so no extra vendor step is needed.
    if (audio) {
      const assetsDir = resolvePath(paths.dir, 'assets');
      const hasSay = story.beats.some((b) => b.say?.trim());
      if (hasSay) {
        mkdirSync(assetsDir, { recursive: true });
        sceneIR = applyNarration(sceneIR, story, { engine, voice, wpm, assetsDir, rootDir: PROJECT_ROOT, captions, captionMode, align: wordAlign, lipSync });
      }
      // A2 SFX (OFFLINE asset-gen; golden rule 2). Beats may attach a sound effect to an event —
      // `show[].sfx` (an element entrance) or `beat.sfx[]` (a beat accent). The sfx pass synthesizes
      // each named effect with ffmpeg into the shared library/sfx/ cache, copies the wav into the
      // project's assets/audio/, and emits `kind:"sfx"` cues at the event frames. Deterministic (fixed
      // recipe → fixed wav). Runs under the same `--no-audio` master switch as narration.
      const hasSfx = story.beats.some(
        (b) => (b.sfx && b.sfx.length > 0) || (b.show ?? []).some((s) => s.sfx),
      );
      if (hasSfx) {
        mkdirSync(assetsDir, { recursive: true });
        sceneIR = applySfx(sceneIR, story, { assetsDir, rootDir: PROJECT_ROOT });
      }
      // A3 MUSIC BED + DUCKING (OFFLINE asset-gen; golden rule 2). A story-level `music` directive plays
      // a looping bed UNDER the whole video, auto-ducked while narration speaks. The music pass
      // synthesizes a built-in bed with ffmpeg into the shared library/music/ cache (or passes an
      // asset ref through), copies the wav into the project's assets/audio/, and emits ONE
      // `kind:"music"` cue spanning the timeline with the duck `mix` controls. Deterministic; runs under
      // the `--no-audio` master switch and skipped by `--no-music`.
      if (music && story.music) {
        mkdirSync(assetsDir, { recursive: true });
        sceneIR = applyMusic(sceneIR, story, { assetsDir, rootDir: PROJECT_ROOT });
      }
      // GENERAL LAYERED AUDIO (story.audio[]): mix/overlap/crop/speed/fade any track. Under the same
      // --no-audio master switch; additive with narration/sfx/music. Each track → a generic audio cue.
      if (story.audio && story.audio.length > 0) {
        mkdirSync(assetsDir, { recursive: true });
        sceneIR = applyAudioTracks(sceneIR, story, { assetsDir, rootDir: PROJECT_ROOT });
      }
    }

    const refs = lockRefsForScene(sceneIR, dirname(storyPath));
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
      outputs: { video: `media/out.${out.kind === 'png-sequence' ? 'png-sequence' : out.ext}`, thumbnail: 'media/thumbnail.png' },
      // UPLOAD-READY publish metadata: resolve the story's `publish` block (+ schema defaults) so
      // project.json always carries fillable title/description/tags/language/… (title ← story title).
      publish: PublishSchema.parse({ ...(story.publish ?? {}), title: story.publish?.title ?? story.title }),
    };
    writeManifest(paths, manifest);
    console.log(`[render] project written → projects/${id}/`);
  }

  const publicDir = resolvePath(paths.dir, 'assets');

  // FAST PATH: --frames renders stills only (verification), skipping the slow video encode.
  if (frames !== undefined) {
    const list = parseFrames(frames, sceneIR.config.duration_frames);
    // --alpha verifies transparency on the fast still path too (RGBA PNGs), before the full sequence.
    const stills = await renderStills(sceneIR, resolvePath(paths.mediaDir, 'frames'), list, publicDir, gpu, out.alpha);
    console.log(`[render] frames done → ${stills.length} ${out.alpha ? 'transparent ' : ''}PNG(s) at ${list.join(',')}`);
    return;
  }

  // P3: png-sequence output renders the full frame range as transparent PNGs (lossless, no encode),
  // reusing the deterministic still path. Otherwise mux a single video file with the chosen codec.
  if (out.kind === 'png-sequence') {
    const seqDir = resolvePath(paths.mediaDir, 'out.png-sequence');
    const total = sceneIR.config.duration_frames;
    const all = Array.from({ length: total }, (_v, i) => i);
    const pngs = await renderStills(sceneIR, seqDir, all, publicDir, gpu, out.alpha);
    console.log(`[render] done → ${pngs.length} ${out.alpha ? 'transparent ' : ''}PNG(s) at ${seqDir}`);
    return;
  }

  // The container extension comes from --format/--codec/--alpha; default mp4 keeps paths.video.
  const videoOut = out.ext === 'mp4' ? paths.video : resolvePath(paths.mediaDir, `out.${out.ext}`);
  const meta = await renderScene(sceneIR, videoOut, publicDir, gpu, out);
  // Thumbnail is extracted from the rendered file (ffmpeg reads any container).
  if (out.ext === 'mp4') makeThumbnail(paths, Math.min(30, Math.max(0, meta.frames - 1)));
  console.log(`[render] done → ${videoOut}`);
  }
}

main().catch((err: unknown) => {
  console.error('[render] failed:', err);
  process.exit(1);
});
