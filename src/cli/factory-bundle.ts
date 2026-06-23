// factory:bundle — produce a SELF-CONTAINED, shareable bundle of a compiled project.
//
// A project under `projects/<id>/` already vendors its source assets into `assets/` and pins its
// library deps in `project.lock` (src/project/manifest.ts), so it is *almost* self-contained. This
// CLI packages that bundle into a portable artifact someone can hand off and re-render or inspect
// without the shared library — exactly the role of OpenTimelineIO's `.otiod` (working DIRECTORY of
// timeline + media) / `.otioz` (the zipped form), and dotLottie's `.lottie` (a zip of animation +
// assets). We mirror that: a directory form (`<id>.afbundle/`) plus an optional zip (`--zip`).
//
// SHAPE of an `.afbundle/` (everything relative, no absolute paths → portable + deterministic):
//   bundle.json        ← the bundle manifest (this file's schema): what's inside + a content hash
//   project.json       ← the project manifest (copied verbatim)
//   scene.json         ← the deterministic compiled timeline (the engine's render input)
//   project.lock       ← the pinned library deps (byte-identical re-render)
//   story.yaml         ← the authored source (provenance; optional)
//   assets/…           ← every vendored source artifact (fonts, svgs, specs, audio wavs, video)
//   media/out.mp4      ← the rendered video + thumbnail (optional; --no-media to omit)
//
// DETERMINISM: bundle.json lists files sorted by path, each with its sha1 (object-hash over bytes),
// and a single `content_hash` over that sorted manifest. The same project ⇒ the same bundle hash.
// Timestamps are metadata only (mirrors manifest.ts: never a render input).
//
// No network, no library re-resolution: we copy what the project already vendored. If the project is
// NOT self-contained (a dep's asset is missing from assets/), we WARN per file but still bundle what
// exists, so a partial hand-off is possible (the warning tells the author what to re-vendor).

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  cpSync,
  statSync,
  readdirSync,
} from 'node:fs';
import { resolve as resolvePath, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { projectPaths, readManifest, type ProjectManifest } from '../project/index.js';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE_FORMAT_VERSION = '1.0';

interface Args {
  id: string;
  zip: boolean;
  media: boolean;
  outDir: string;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const id = positional[0];
  if (!id) {
    throw new Error('usage: factory:bundle <project-id> [--zip] [--no-media] [--out <dir>]');
  }
  return {
    id,
    zip: argv.includes('--zip'),
    media: !argv.includes('--no-media'),
    outDir: flag('--out') ?? resolvePath(PROJECT_ROOT, 'dist', 'bundles'),
  };
}

/** sha1 over a file's raw bytes (integrity, not the object-hash content address of catalog entries). */
function sha1File(absPath: string): string {
  return createHash('sha1').update(readFileSync(absPath)).digest('hex');
}

/** Recursively collect every file under `dir`, returned as paths relative to `base`, sorted. */
function walkFiles(dir: string, base: string): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const name of readdirSorted(cur)) {
      const full = join(cur, name);
      if (statSync(full).isDirectory()) stack.push(full);
      else out.push(relative(base, full));
    }
  }
  return out.sort();
}

function readdirSorted(dir: string): string[] {
  return readdirSync(dir).sort();
}

interface BundleFileEntry {
  path: string;
  bytes: number;
  sha1: string;
}

interface BundleManifest {
  bundle_format_version: string;
  /** The project this bundle was made from (mirrors project.json). */
  id: string;
  name: string;
  /** Frame config copied from the project manifest for at-a-glance inspection. */
  config: ProjectManifest['config'];
  engine: string;
  /** Pinned library deps (name@version) the bundle reproduces. */
  deps: string[];
  /** ISO timestamp the bundle was produced (metadata only; excluded from content_hash). */
  packed: string;
  /** Whether media outputs are included. */
  includes_media: boolean;
  /** Every file in the bundle (except bundle.json itself), sorted, with size + sha1. */
  files: BundleFileEntry[];
  /** sha1 over the sorted `files` list (path+sha1) → one address for the whole bundle. */
  content_hash: string;
}

function main(): void {
  const { id, zip, media, outDir } = parseArgs(process.argv.slice(2));
  const p = projectPaths(PROJECT_ROOT, id);
  if (!existsSync(p.manifest)) {
    throw new Error(`project not found or not compiled: ${id} (no ${relative(PROJECT_ROOT, p.manifest)})`);
  }
  const manifest = readManifest(p);

  const stageDir = resolvePath(outDir, `${id}.afbundle`);
  rmSync(stageDir, { recursive: true, force: true });
  mkdirSync(stageDir, { recursive: true });

  // 1) Core docs (scene.json is REQUIRED; story.yaml is optional provenance).
  copyInto(p.scene, stageDir, 'scene.json', true);
  copyInto(p.manifest, stageDir, 'project.json', true);
  copyInto(p.lock, stageDir, 'project.lock', false);
  copyInto(p.source, stageDir, 'story.yaml', false);

  // 2) Vendored source assets the project declared (manifest.assets[]). Warn (don't fail) on any
  //    missing file so a partial hand-off still works and the author knows what to re-vendor.
  for (const rel of manifest.assets) {
    const src = resolvePath(p.dir, rel);
    if (!existsSync(src)) {
      console.warn(`[bundle] declared asset missing (skipped): ${rel}`);
      continue;
    }
    cpSync(src, resolvePath(stageDir, rel), { recursive: true });
  }
  // Also sweep the whole assets/ dir (TTS wavs land there at build time and may not be enumerated in
  // manifest.assets[]); this is what makes the bundle truly self-contained for AUDIO too.
  const assetsDir = resolvePath(p.dir, 'assets');
  if (existsSync(assetsDir)) {
    cpSync(assetsDir, resolvePath(stageDir, 'assets'), { recursive: true });
  }

  // 3) Media outputs (the rendered video + thumbnail), unless --no-media.
  if (media) {
    for (const out of [p.video, p.thumbnail]) {
      if (existsSync(out)) {
        cpSync(out, resolvePath(stageDir, 'media', relative(p.mediaDir, out)), { recursive: true });
      }
    }
  }

  // 4) Build bundle.json: a content-addressed inventory of everything we staged.
  const files = walkFiles(stageDir, stageDir).filter((f) => f !== 'bundle.json');
  const fileEntries: BundleFileEntry[] = files.map((rel) => {
    const abs = resolvePath(stageDir, rel);
    return { path: rel, bytes: statSync(abs).size, sha1: sha1File(abs) };
  });
  const contentHash = createHash('sha1')
    .update(fileEntries.map((f) => `${f.path}:${f.sha1}`).join('\n'))
    .digest('hex');

  const bundleManifest: BundleManifest = {
    bundle_format_version: BUNDLE_FORMAT_VERSION,
    id: manifest.id,
    name: manifest.name,
    config: manifest.config,
    engine: manifest.engine,
    deps: manifest.deps,
    packed: new Date().toISOString(),
    includes_media: media,
    files: fileEntries,
    content_hash: contentHash,
  };
  writeFileSync(resolvePath(stageDir, 'bundle.json'), JSON.stringify(bundleManifest, null, 2) + '\n', 'utf8');

  // 5) Optional zip (cf. .otioz / .lottie). `zip -r -X` with sorted input keeps it reproducible-ish;
  //    the directory form is the canonical deterministic artifact (content_hash lives in bundle.json).
  let zipPath: string | undefined;
  if (zip) {
    zipPath = `${stageDir}.zip`;
    rmSync(zipPath, { force: true });
    execFileSync('zip', ['-r', '-q', '-X', zipPath, '.'], { cwd: stageDir });
  }

  const totalBytes = fileEntries.reduce((a, f) => a + f.bytes, 0);
  console.log(
    JSON.stringify(
      {
        ok: true,
        id,
        bundle_dir: stageDir,
        zip: zipPath ?? null,
        files: fileEntries.length,
        total_bytes: totalBytes,
        content_hash: contentHash,
        includes_media: media,
      },
      null,
      2,
    ),
  );
}

/** Copy one file into the stage; `required` throws if missing, else silently skips. */
function copyInto(src: string, stageDir: string, destRel: string, required: boolean): void {
  if (!existsSync(src)) {
    if (required) throw new Error(`bundle is missing a required file: ${destRel} (${src})`);
    return;
  }
  cpSync(src, resolvePath(stageDir, destRel));
}

main();
