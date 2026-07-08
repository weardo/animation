// factory:footage — OFFLINE free-stock-footage fetch from the Pexels API (like factory:imagegen).
//
// Golden rule 2: external media NEVER touches frames or the runtime — it is fetched ONCE OFFLINE at
// build into a CONTENT-ADDRESSED cache, and the render replays the FIXED file via the existing footage
// layer (<OffthreadVideo>, frame-seeked → deterministic). Golden rule 1: even though the Pexels search
// is stochastic (results change over time, the pick may vary), the DOWNLOADED clip is the deterministic
// record — skip-if-exists means a re-run reuses the identical file → byte-identical renders.
//
// PIPELINE (mirrors imagegen):
//   content-address {query, orientation, size, min_duration} → if a cached mp4 exists for this hash,
//   reuse it (skip Pexels) → else query Pexels, pick the best-matching video file, download to
//   public/video/<id>.mp4 → register/update an `asset` catalog entry (kind='asset', format='video',
//   uri='asset://video/<id>.mp4') with provenance (Pexels URL + photographer + license).
//
// LICENSE: Pexels content is free for commercial use with NO attribution required on the media; the API
// guidelines ask for a "Pexels" credit somewhere (a video-description line covers it). Provenance records
// the source URL + author so you can credit them.
//
// USAGE:  PEXELS_API_KEY=… npx tsx src/cli/footage.ts "oil tanker at sea" --id tanker \
//           [--orientation portrait] [--size medium] [--min-duration 4]
// Then author it in a story:  { footage: tanker, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, rmSync, renameSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';
import objectHash from 'object-hash';

const PEXELS_SEARCH = 'https://api.pexels.com/videos/search';

interface FootageRequest {
  query: string;
  orientation: 'portrait' | 'landscape' | 'square';
  /** Pexels `size` bucket: large(4K) / medium(FullHD) / small(HD). */
  size: 'large' | 'medium' | 'small';
  minDuration: number;
}

/** Content-address a request (stable → skip-if-exists → deterministic replay). */
function footageHash(req: FootageRequest): string {
  return objectHash({ q: req.query.toLowerCase().trim(), o: req.orientation, s: req.size, d: req.minDuration }).slice(0, 12);
}

interface PexelsVideoFile {
  id: number;
  quality: string;
  width: number;
  height: number;
  link: string;
  file_type?: string;
}
interface PexelsVideo {
  id: number;
  url: string;
  duration: number;
  width: number;
  height: number;
  user: { name: string; url: string };
  video_files: PexelsVideoFile[];
}

/** Query Pexels + pick the best video FILE for the request (orientation + a sane resolution). */
async function pickPexelsClip(
  req: FootageRequest,
  apiKey: string,
): Promise<{ video: PexelsVideo; file: PexelsVideoFile } | null> {
  const url = `${PEXELS_SEARCH}?query=${encodeURIComponent(req.query)}&orientation=${req.orientation}&size=${req.size}&per_page=15`;
  const resp = await fetch(url, { headers: { Authorization: apiKey } });
  if (!resp.ok) throw new Error(`Pexels API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { videos?: PexelsVideo[] };
  const videos = (data.videos ?? []).filter((v) => v.duration >= req.minDuration);
  if (videos.length === 0) return null;

  // Prefer the FIRST result (Pexels ranks by relevance) whose orientation matches; within it pick an
  // .mp4 file at a reasonable height (≤1920, highest under that) to keep the download light + reel-fit.
  const wantPortrait = req.orientation === 'portrait';
  for (const video of videos) {
    const isPortrait = video.height >= video.width;
    if (wantPortrait !== isPortrait && req.orientation !== 'square') continue;
    const mp4s = video.video_files
      .filter((f) => (f.file_type ?? '').includes('mp4') || f.link.includes('.mp4'))
      .filter((f) => f.height <= 1920)
      .sort((a, b) => b.height - a.height);
    const file = mp4s[0] ?? video.video_files.sort((a, b) => b.height - a.height)[0];
    if (file) return { video, file };
  }
  // Fallback: the top video regardless of orientation.
  const video = videos[0]!;
  const file = video.video_files.sort((a, b) => b.height - a.height)[0];
  return file ? { video, file } : null;
}

/**
 * Downscale a downloaded clip in place to a LIGHT proxy so <OffthreadVideo> never RAM-balloons.
 * Caps the bounding box at 1920px (keeps aspect; a 9:16 reel needs ≤1080x1920), re-encodes h264 at a
 * modest CRF, forces yuv420p (broad decoder support), 30 fps, and strips audio (reel footage is muted).
 * Deterministic single-shot ffmpeg on a fixed input → the cached proxy replays byte-identically. If the
 * proxy would be LARGER than the source (already-light clip), keep the original. ffmpeg missing → skip.
 */
function transcodeToProxy(mp4Path: string, originalBytes: number): void {
  const tmp = mp4Path.replace(/\.mp4$/, '.proxy.mp4');
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', mp4Path,
      // bounding-box cap 1920 (both orientations), even dims for yuv420p, no upscaling.
      '-vf', "scale='min(iw,1920)':'min(ih,1920)':force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-maxrate', '2500k', '-bufsize', '5000k', // cap peak bitrate so motion-heavy clips stay light
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', tmp,
    ]);
  } catch {
    rmSync(tmp, { force: true });
    console.warn('[footage]   proxy skipped (ffmpeg unavailable) — the raw clip may be heavy and can stall <OffthreadVideo> on a low-RAM box; install ffmpeg to auto-downscale.');
    return;
  }
  const proxyBytes = statSync(tmp).size;
  if (proxyBytes >= originalBytes) {
    rmSync(tmp, { force: true }); // already light — the source is the better keep
    console.log(`[footage]   proxy skipped — source already light (${(originalBytes / 1e6).toFixed(1)} MB)`);
    return;
  }
  renameSync(tmp, mp4Path); // the proxy IS the served, content-addressed file now
  console.log(`[footage]   → light proxy ${(originalBytes / 1e6).toFixed(1)} MB → ${(proxyBytes / 1e6).toFixed(1)} MB (OffthreadVideo-safe)`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const query = argv.find((a) => !a.startsWith('-'));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!query) {
    console.error('usage: PEXELS_API_KEY=… npx tsx src/cli/footage.ts "<search query>" --id <asset-id> [--orientation portrait|landscape|square] [--size large|medium|small] [--min-duration 4]');
    process.exit(1);
  }
  const rootDir = flag('--root') ?? process.cwd();
  const id = (flag('--id') ?? `pexels-${footageHash({ query, orientation: 'portrait', size: 'medium', minDuration: 3 })}`).replace(/[^a-z0-9_-]/gi, '-');
  const req: FootageRequest = {
    query,
    orientation: (flag('--orientation') as FootageRequest['orientation']) ?? 'portrait',
    size: (flag('--size') as FootageRequest['size']) ?? 'medium',
    minDuration: Number(flag('--min-duration') ?? '3'),
  };

  const hash = footageHash(req);
  const videoDir = resolvePath(rootDir, 'public', 'video');
  mkdirSync(videoDir, { recursive: true });
  const mp4Path = resolvePath(videoDir, `${id}.mp4`);
  const uri = `asset://video/${id}.mp4`;

  // 1. content-addressed cache (skip-if-exists → deterministic replay).
  if (existsSync(mp4Path)) {
    console.log(`[footage] cached "${id}" (hash ${hash}) — reusing ${mp4Path}`);
    registerCatalog(rootDir, id, uri, req, hash, undefined);
    printUse(id);
    return;
  }

  const apiKey = process.env['PEXELS_API_KEY'];
  if (!apiKey) {
    console.error('[footage] PEXELS_API_KEY not set (get a free key at pexels.com/api).');
    process.exit(1);
  }

  // 2. query Pexels + pick a clip.
  const pick = await pickPexelsClip(req, apiKey);
  if (!pick) {
    console.error(`[footage] no Pexels video found for "${query}" (${req.orientation}, ≥${req.minDuration}s).`);
    process.exit(1);
  }

  // 3. download the clip ONCE into the content-addressed cache.
  const resp = await fetch(pick.file.link);
  if (!resp.ok) throw new Error(`download failed ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(mp4Path, buf);
  console.log(`[footage] downloaded "${id}" ${pick.file.width}x${pick.file.height} (${(buf.length / 1e6).toFixed(1)} MB) ← Pexels #${pick.video.id}`);

  // 3b. TRANSCODE to a LIGHT PROXY (ROOT-CAUSE FIX for the render hang). Remotion's <OffthreadVideo>
  // decodes footage frames on demand; a heavy source (a 39 MB high-bitrate clip) balloons the Rust
  // compositor's RAM and, on a swap-pressured box, the decode BLOCKS at 0% CPU → the whole render hangs.
  // A downscaled, modest-bitrate h264/yuv420p proxy (≈1-2 MB) decodes cheaply and renders reliably. The
  // proxy REPLACES the served file in the content-addressed cache, so it's the deterministic record that
  // the render replays. ffmpeg-absent → keep the original (never fail), just warn it may be heavy.
  transcodeToProxy(mp4Path, buf.length);

  // 4. register the catalog entry.
  registerCatalog(rootDir, id, uri, req, hash, pick.video);
  printUse(id);
}

/** Register/update the `asset` catalog entry (kind='asset', format='video') — mirrors imagegen. */
function registerCatalog(
  rootDir: string,
  id: string,
  uri: string,
  req: FootageRequest,
  hash: string,
  video: PexelsVideo | undefined,
): void {
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.footage ??= {};
  const prev = idx.entries.footage[id] ?? {};
  idx.entries.footage[id] = {
    id,
    version: (prev.version as string | undefined) ?? '1.0.0',
    kind: 'asset',
    format: 'video',
    uri,
    tags: ['footage', 'video', 'pexels', 'stock'],
    deps: [],
    provenance: {
      // Only the strict Provenance keys (catalog.ts): source/license/prompt/size/cache_hash.
      source: video
        ? `Pexels ${video.url} by ${video.user.name} (${video.user.url}) [${req.orientation}]`
        : (prev.provenance?.source ?? 'Pexels (cached)'),
      prompt: req.query,
      size: req.size,
      cache_hash: hash,
      // Pexels License: free for commercial use, no attribution required on media; credit "Pexels" per API guidelines.
      license: 'Pexels License (free commercial, no-attribution; credit Pexels + author appreciated)',
    },
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  console.log(`[footage]   catalog → library/index.json  (${uri})`);
}

function printUse(id: string): void {
  console.log(`[footage]   use  → a story show item: { footage: ${id}, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }`);
  console.log('[footage]   tip  → grade it to the dark palette with args.effects (blur/color_grade/vignette) so it matches the cinematic look.');
}

main().catch((err) => {
  console.error(`[footage] failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
