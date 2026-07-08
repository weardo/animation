// factory:newsclip — OFFLINE pull of a PUBLICLY-AVAILABLE news video clip → a light footage proxy used as
// documentary EVIDENCE (real event footage).
//
// JOURNALISM / FAIR USE: brief, attributed, transformative commentary from publicly-accessible media only.
// Uses yt-dlp (the standard downloader; supports most news/social hosts). It downloads only what is served
// publicly — it does NOT bypass paywalls or DRM (gated media → clean error). Publisher + URL recorded in
// provenance for on-screen + description attribution. Prefer a SHORT --section so clips stay brief.
//
// Golden rule 1/2: download + transcode ONCE OFFLINE into the content-addressed video cache (skip-if-
// exists); the render replays the FIXED mp4 via the existing FootageLayer (<OffthreadVideo>). The light
// proxy (≤1920px, CRF 26, 2500k cap, muted) is the SAME step footage uses so <OffthreadVideo> never
// RAM-balloons.
//
// USAGE:
//   factory:newsclip "<url>" --id <asset-id> [--section 12-20] [--max-seconds 20] [--date 2026-07-08]
// Then in a story:  { footage: <id>, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';
import objectHash from 'object-hash';

interface ClipRequest {
  url: string;
  section?: string; // "start-end" seconds, e.g. "12-20"
  maxSeconds: number;
}

function clipHash(req: ClipRequest): string {
  return objectHash({ u: req.url, s: req.section ?? '', m: req.maxSeconds }).slice(0, 12);
}

/** yt-dlp metadata (publisher/title) without downloading. */
function probeMeta(url: string): { publisher: string; title: string } {
  try {
    const out = execFileSync('yt-dlp', ['-j', '--no-warnings', '--no-playlist', url], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const j = JSON.parse(out) as { uploader?: string; channel?: string; extractor_key?: string; title?: string };
    return { publisher: j.uploader || j.channel || j.extractor_key || new URL(url).hostname, title: j.title || '' };
  } catch {
    return { publisher: new URL(url).hostname.replace(/^www\./, ''), title: '' };
  }
}

/** Download (optionally just a section) to a temp dir; return the downloaded file path. */
function download(req: ClipRequest, tmpDir: string): string {
  const args = [
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/best',
    '--no-playlist', '--no-warnings',
    '-P', tmpDir, '-o', 'clip.%(ext)s',
  ];
  if (req.section) {
    const [a, b] = req.section.split('-');
    args.push('--download-sections', `*${a}-${b}`, '--force-keyframes-at-cuts');
  }
  args.push(req.url);
  execFileSync('yt-dlp', args, { stdio: ['ignore', 'inherit', 'inherit'] });
  const file = readdirSync(tmpDir).find((f) => f.startsWith('clip.'));
  if (!file) throw new Error('yt-dlp produced no file (gated/DRM media, or unsupported host?)');
  return resolvePath(tmpDir, file);
}

/** Transcode to the SAME light footage proxy (≤1920px, CRF 26, 2500k cap, muted), optional length cap. */
function toProxy(src: string, out: string, maxSeconds: number): void {
  execFileSync('ffmpeg', [
    '-y', '-loglevel', 'error', '-i', src,
    ...(maxSeconds > 0 ? ['-t', String(maxSeconds)] : []),
    '-vf', "scale='min(iw,1920)':'min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-maxrate', '2500k', '-bufsize', '5000k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', out,
  ]);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = argv.find((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('usage: factory:newsclip "<https url>" --id <asset-id> [--section 12-20] [--max-seconds 20] [--date YYYY-MM-DD]');
    process.exit(1);
  }
  try {
    execFileSync('yt-dlp', ['--version'], { stdio: 'ignore' });
  } catch {
    console.error('[newsclip] yt-dlp not on PATH — install it (pipx install yt-dlp) to pull news video.');
    process.exit(1);
  }

  const rootDir = flag('--root') ?? process.cwd();
  const section = flag('--section');
  const req: ClipRequest = {
    url,
    ...(section ? { section } : {}),
    maxSeconds: Number(flag('--max-seconds') ?? (section ? '0' : '20')),
  };
  const id = (flag('--id') ?? `newsclip-${clipHash(req)}`).replace(/[^a-z0-9_-]/gi, '-');
  const date = flag('--date') ?? '';

  const videoDir = resolvePath(rootDir, 'public', 'video');
  mkdirSync(videoDir, { recursive: true });
  const outPath = resolvePath(videoDir, `${id}.mp4`);
  const uri = `asset://video/${id}.mp4`;
  const hash = clipHash(req);

  const { publisher, title } = probeMeta(url);
  if (existsSync(outPath)) {
    console.log(`[newsclip] cached "${id}" (hash ${hash}) — reusing ${outPath}`);
  } else {
    const tmpDir = resolvePath(videoDir, `.tmp-${id}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      console.log(`[newsclip] pulling ${url}${req.section ? ` [section ${req.section}]` : ''} …`);
      const raw = download(req, tmpDir);
      toProxy(raw, outPath, req.maxSeconds);
      console.log(`[newsclip] → ${uri}  (publisher: ${publisher}${title ? `, "${title.slice(0, 60)}"` : ''})`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  registerCatalog(rootDir, id, uri, url, publisher, title, date, hash);
  console.log(`[newsclip]   use  → { footage: ${id}, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }`);
  console.log(`[newsclip]   ⚖  editorial/fair-use — keep it BRIEF + attribute "${publisher}" on-screen + in the description.`);
}

function registerCatalog(rootDir: string, id: string, uri: string, url: string, publisher: string, title: string, date: string, hash: string): void {
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.newsclips ??= {};
  const prev = idx.entries.newsclips[id] ?? {};
  idx.entries.newsclips[id] = {
    id,
    version: (prev.version as string | undefined) ?? '1.0.0',
    kind: 'asset',
    format: 'video',
    uri,
    tags: ['newsclip', 'evidence', 'footage'],
    deps: [],
    provenance: {
      source: `${publisher}${title ? ` — "${title}"` : ''} — ${url}${date ? ` (captured ${date})` : ''}`,
      license: 'editorial / fair-use — brief attributed commentary; publicly-accessible source',
      cache_hash: hash,
    },
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  console.log(`[newsclip]   catalog → library/index.json  (${uri})`);
}

main().catch((err) => {
  console.error(`[newsclip] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
