// factory:publish — push a rendered reel to a distribution platform (YouTube today; extensible).
//
// Reads the project's manifest (project.json): the `publish` metadata block + the rendered `outputs`.
// Dispatches to the named platform publisher(s) through the registry — the CLI names no platform.
//
// SAFETY (outward-facing side effect): DRY-RUN BY DEFAULT — it validates creds + metadata + the file and
// prints what WOULD happen. Pass `--yes` to actually upload. Visibility defaults to `unlisted`; `public`
// is explicit (and, on an unverified OAuth app, YouTube may still force it to unlisted — see youtube.ts).
//
// USAGE:
//   factory:publish <project> --auth                       # one-time OAuth consent (per platform)
//   factory:publish <project>                              # DRY-RUN preview (default, no upload)
//   factory:publish <project> --yes                        # upload as unlisted
//   factory:publish <project> --yes --visibility public    # upload public (see verification caveat)
//   factory:publish <project> --platform youtube[,tiktok]  # choose platform(s); default youtube

import '../publish/ipv4.js'; // side-effect: force IPv4 (see module) — MUST precede any fetch
import { existsSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectExists, projectPaths, readManifest } from '../project/index.js';
import { loadPublishers, getPublisher, listPublishers } from '../publish/index.js';
import type { PublishContext, PublishMeta, Visibility } from '../publish/index.js';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Resolve the platform-agnostic PublishMeta from the manifest's publish block (+ sane fallbacks). */
function metaFromManifest(manifest: ReturnType<typeof readManifest>): PublishMeta {
  const p = manifest.publish;
  return {
    title: p?.title ?? manifest.name,
    description: p?.description ?? '',
    tags: p?.tags ?? [],
    hashtags: p?.hashtags ?? [],
    category: p?.category ?? 'News & Politics',
    ...(p?.language ? { language: p.language } : {}),
    madeForKids: p?.made_for_kids ?? false,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const target = argv.find((a) => !a.startsWith('-'));
  const doAuth = argv.includes('--auth');
  const doUpload = argv.includes('--yes'); // default false → dry-run (safe)
  const platforms = (flag(argv, '--platform') ?? 'youtube').split(',').map((s) => s.trim()).filter(Boolean);
  const visibility = (flag(argv, '--visibility') ?? 'unlisted') as Visibility;

  loadPublishers();

  if (!target) {
    console.error('usage: factory:publish <project> [--auth] [--yes] [--visibility unlisted|private|public] [--platform youtube]');
    console.error(`available platforms: ${listPublishers().map((p) => p.platform).join(', ')}`);
    process.exit(1);
  }
  if (!(['private', 'unlisted', 'public'] as const).includes(visibility)) {
    console.error(`bad --visibility "${visibility}" (private|unlisted|public)`);
    process.exit(1);
  }

  // --auth: run each platform's one-time consent flow and exit (no project needed for auth).
  if (doAuth) {
    for (const name of platforms) {
      const pub = getPublisher(name);
      if (!pub) { console.error(`[publish] unknown platform "${name}"`); continue; }
      if (!pub.authenticate) { console.log(`[publish] ${name}: no auth step needed`); continue; }
      console.log(`[publish] ${name}: starting one-time authorization…`);
      await pub.authenticate(PROJECT_ROOT);
    }
    return;
  }

  if (!projectExists(PROJECT_ROOT, target)) {
    console.error(`[publish] no such project "${target}" (expected projects/${target}/project.json)`);
    process.exit(1);
  }
  const paths = projectPaths(PROJECT_ROOT, target);
  const manifest = readManifest(paths);
  const videoPath = resolvePath(paths.dir, manifest.outputs?.video ?? 'media/out.mp4');
  if (!existsSync(videoPath)) {
    console.error(`[publish] rendered video not found at ${videoPath} — render the project first.`);
    process.exit(1);
  }
  const thumbRel = manifest.outputs?.thumbnail;
  const thumbnailPath = thumbRel ? resolvePath(paths.dir, thumbRel) : undefined;
  const meta = metaFromManifest(manifest);

  console.log(`[publish] project "${target}" → ${platforms.join(', ')}  (visibility=${visibility}, ${doUpload ? 'LIVE UPLOAD' : 'DRY-RUN — pass --yes to upload'})`);
  console.log(`[publish]   title: ${meta.title}`);

  let anyFailed = false;
  for (const name of platforms) {
    const pub = getPublisher(name);
    if (!pub) { console.error(`[publish] ✗ unknown platform "${name}" (have: ${listPublishers().map((p) => p.platform).join(', ')})`); anyFailed = true; continue; }
    const ctx: PublishContext = {
      videoPath,
      ...(thumbnailPath && existsSync(thumbnailPath) ? { thumbnailPath } : {}),
      meta,
      visibility,
      dryRun: !doUpload,
      rootDir: PROJECT_ROOT,
      projectDir: paths.dir,
      projectId: target,
    };
    const r = await pub.publish(ctx);
    const icon = r.status === 'uploaded' ? '✅' : r.status === 'dry-run' ? '🧪' : r.status === 'failed' ? '✗' : '•';
    console.log(`[publish] ${icon} ${name}: ${r.status}${r.url ? ` → ${r.url}` : ''}${r.message ? `\n            ${r.message}` : ''}`);
    if (r.status === 'failed') anyFailed = true;
  }
  if (anyFailed) process.exit(1);
}

main().catch((err: unknown) => {
  console.error('[publish] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
