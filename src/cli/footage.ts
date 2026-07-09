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

export interface FootageRequest {
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
  /** Poster frame (one representative jpg). */
  image?: string;
  /** ~15 preview thumbnails sampled ACROSS the clip — catches a subject that only appears later. */
  video_pictures?: { picture: string; nr: number }[];
  user: { name: string; url: string };
  video_files: PexelsVideoFile[];
}

/** Choose the best downloadable .mp4 FILE within one video (≤1920 tall, highest under that). */
function bestFile(video: PexelsVideo): PexelsVideoFile | undefined {
  const mp4s = video.video_files
    .filter((f) => (f.file_type ?? '').includes('mp4') || f.link.includes('.mp4'))
    .filter((f) => f.height <= 1920)
    .sort((a, b) => b.height - a.height);
  return mp4s[0] ?? video.video_files.sort((a, b) => b.height - a.height)[0];
}

/**
 * Query Pexels → the RANKED list of orientation-matching candidates (each with its best file). The
 * FIRST result is Pexels's top relevance pick, but it is NOT always the best clip (a subject may be
 * off-frame, or only revealed late) — so we expose the whole list for `--list` browsing + `--index`/
 * `--video-id` selection, not just index 0.
 */
async function rankedCandidates(
  req: FootageRequest,
  apiKey: string,
  perPage = 20,
): Promise<{ video: PexelsVideo; file: PexelsVideoFile }[]> {
  const url = `${PEXELS_SEARCH}?query=${encodeURIComponent(req.query)}&orientation=${req.orientation}&size=${req.size}&per_page=${perPage}`;
  const resp = await fetch(url, { headers: { Authorization: apiKey } });
  if (!resp.ok) throw new Error(`Pexels API ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = (await resp.json()) as { videos?: PexelsVideo[] };
  const wantPortrait = req.orientation === 'portrait';
  const out: { video: PexelsVideo; file: PexelsVideoFile }[] = [];
  for (const video of data.videos ?? []) {
    if (video.duration < req.minDuration) continue;
    const isPortrait = video.height >= video.width;
    if (req.orientation !== 'square' && wantPortrait !== isPortrait) continue;
    const file = bestFile(video);
    if (file) out.push({ video, file });
  }
  return out;
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
      // KEEP the audio (light aac) — a fetched clip's OWN sound is sometimes the point (a viral raw clip).
      // It's silent at render UNLESS the story opts in with `muted: false` (footage defaults to muted).
      '-c:a', 'aac', '-b:a', '128k',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-maxrate', '2500k', '-bufsize', '5000k', // cap peak bitrate so motion-heavy clips stay light
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart', tmp,
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

/** One browsable candidate summary (id, dims, duration, poster/preview thumbs, page URL). */
export interface FootageCandidate {
  /** The Pexels video id (pass as `videoId` to `pickFootage` to fetch this exact clip). */
  id: number;
  width: number;
  height: number;
  duration: number;
  author: string;
  authorUrl: string;
  /** The Pexels video page (for a human to eyeball). */
  page: string;
  /** A single representative poster frame, if Pexels supplied one. */
  poster?: string;
  /** A preview thumbnail sampled from the MIDDLE of the clip (catches a late-reveal subject). */
  preview?: string;
}

export interface SearchFootageOptions {
  query: string;
  orientation?: FootageRequest['orientation'];
  size?: FootageRequest['size'];
  minDuration?: number;
  /** Pexels page size (how many candidates to fetch/rank). Defaults to 20. */
  perPage?: number;
}

export interface SearchFootageResult {
  query: string;
  orientation: FootageRequest['orientation'];
  size: FootageRequest['size'];
  minDuration: number;
  /** RANKED as Pexels returns them (index 0 = top relevance) — not always the best clip; browse the list. */
  candidates: FootageCandidate[];
}

/**
 * Query Pexels for footage candidates matching a request — the same ranking `--list` browses, exposed
 * as a pure (network-only, no filesystem writes) callable. Requires `PEXELS_API_KEY`.
 */
export async function searchFootage(opts: SearchFootageOptions): Promise<SearchFootageResult> {
  const apiKey = process.env['PEXELS_API_KEY'];
  if (!apiKey) throw new Error('PEXELS_API_KEY not set (get a free key at pexels.com/api).');
  const req: FootageRequest = {
    query: opts.query,
    orientation: opts.orientation ?? 'portrait',
    size: opts.size ?? 'medium',
    minDuration: opts.minDuration ?? 3,
  };
  const candidates = await rankedCandidates(req, apiKey, opts.perPage ?? 20);
  return {
    query: req.query,
    orientation: req.orientation,
    size: req.size,
    minDuration: req.minDuration,
    candidates: candidates.map(({ video }) => {
      const pics = video.video_pictures ?? [];
      const mid = pics[Math.floor(pics.length / 2)]?.picture;
      return {
        id: video.id,
        width: video.width,
        height: video.height,
        duration: video.duration,
        author: video.user.name,
        authorUrl: video.user.url,
        page: video.url,
        ...(video.image ? { poster: video.image } : {}),
        ...(mid ? { preview: mid } : {}),
      };
    }),
  };
}

/** The catalog `provenance` block written for a footage asset (the strict `Provenance` keys only). */
export interface FootageProvenance {
  source: string;
  prompt: string;
  size: string;
  cache_hash: string;
  license: string;
}

export interface PickFootageOptions {
  query: string;
  /** Asset id (catalog key + filename stem). Defaults to a content-hash-derived `pexels-<hash>`. */
  id?: string;
  orientation?: FootageRequest['orientation'];
  size?: FootageRequest['size'];
  minDuration?: number;
  /** Fetch this EXACT Pexels video id (from a prior `searchFootage`), not just the top pick. */
  videoId?: number;
  /** Fetch the candidate at this rank (0 = Pexels's top pick, the default). */
  index?: number;
  /** Where `public/video/` + `library/index.json` live. Defaults to `process.cwd()` (the CLI default). */
  rootDir?: string;
}

export interface PickFootageResult {
  /** The resolved, filesystem-safe asset id. */
  id: string;
  /** The registered `asset://` catalog uri. */
  assetRef: string;
  /** Absolute path to the downloaded (and proxy-transcoded) mp4. */
  localPath: string;
  /** True when an existing cached file was reused (no network fetch). */
  cached: boolean;
  /** The content-address of the search request (query+orientation+size+minDuration). */
  hash: string;
  /** The Pexels video id actually downloaded (absent when replaying a cache hit). */
  pexelsId?: number;
  width?: number;
  height?: number;
  /** Downloaded byte size BEFORE proxy transcoding (absent when replaying a cache hit). */
  bytes?: number;
  provenance: FootageProvenance;
}

/**
 * Fetch (or reuse the cached) footage clip, proxy-transcode it, and register/update its `asset`
 * catalog entry — the same pipeline `main()`'s pick path runs, wrapped as a pure callable. Mirrors the
 * CLI EXACTLY: a plain re-run (no `videoId`/`index`) short-circuits on an existing cached file; an
 * explicit `videoId`/`index` always re-queries Pexels and (re)downloads the chosen candidate.
 */
export async function pickFootage(opts: PickFootageOptions): Promise<PickFootageResult> {
  const rootDir = opts.rootDir ?? process.cwd();
  const req: FootageRequest = {
    query: opts.query,
    orientation: opts.orientation ?? 'portrait',
    size: opts.size ?? 'medium',
    minDuration: opts.minDuration ?? 3,
  };
  const hash = footageHash(req);
  const id = (opts.id ?? `pexels-${hash}`).replace(/[^a-z0-9_-]/gi, '-');
  const videoDir = resolvePath(rootDir, 'public', 'video');
  mkdirSync(videoDir, { recursive: true });
  const mp4Path = resolvePath(videoDir, `${id}.mp4`);
  const uri = `asset://video/${id}.mp4`;

  // Cache short-circuit ONLY for a plain fetch (no explicit re-pick) — mirrors main()'s CLI behavior:
  // an --index/--video-id request must always re-query Pexels so you can re-choose a different clip.
  if (existsSync(mp4Path) && opts.videoId === undefined && opts.index === undefined) {
    const provenance = registerCatalog(rootDir, id, uri, req, hash, undefined);
    return { id, assetRef: uri, localPath: mp4Path, cached: true, hash, provenance };
  }

  const apiKey = process.env['PEXELS_API_KEY'];
  if (!apiKey) throw new Error('PEXELS_API_KEY not set (get a free key at pexels.com/api).');

  const candidates = await rankedCandidates(req, apiKey);
  if (candidates.length === 0) {
    throw new Error(`no Pexels video found for "${req.query}" (${req.orientation}, ≥${req.minDuration}s).`);
  }

  // Selection: an explicit videoId, else index, else 0 (Pexels's top pick) — same order as the CLI.
  let pick: { video: PexelsVideo; file: PexelsVideoFile } | undefined;
  if (opts.videoId !== undefined) {
    pick = candidates.find((c) => c.video.id === opts.videoId);
    if (!pick) throw new Error(`video-id ${opts.videoId} not among candidates for "${req.query}" (try searchFootage/--list).`);
  } else {
    const idx = opts.index ?? 0;
    pick = candidates[idx];
    if (!pick) throw new Error(`index ${idx} out of range (0..${candidates.length - 1}); try searchFootage/--list.`);
  }
  // Re-fetching a chosen clip for an id that already has a file: replace it.
  if (existsSync(mp4Path)) rmSync(mp4Path, { force: true });

  // Download the clip ONCE into the content-addressed cache.
  const resp = await fetch(pick.file.link);
  if (!resp.ok) throw new Error(`download failed ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(mp4Path, buf);

  // TRANSCODE to a LIGHT PROXY — see transcodeToProxy() doc comment (the render-hang root-cause fix).
  transcodeToProxy(mp4Path, buf.length);

  const provenance = registerCatalog(rootDir, id, uri, req, hash, pick.video);
  return {
    id,
    assetRef: uri,
    localPath: mp4Path,
    cached: false,
    hash,
    pexelsId: pick.video.id,
    width: pick.file.width,
    height: pick.file.height,
    bytes: buf.length,
    provenance,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const query = argv.find((a) => !a.startsWith('-'));
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (!query) {
    console.error('usage: PEXELS_API_KEY=… npx tsx src/cli/footage.ts "<search query>" --id <asset-id>');
    console.error('  browse:  --list [N]                 list top candidates (id, dims, dur, poster + preview URLs)');
    console.error('  pick:    --index <n> | --video-id <id>   fetch a SPECIFIC candidate (not just the first)');
    console.error('  opts:    [--orientation portrait|landscape|square] [--size large|medium|small] [--min-duration 4]');
    process.exit(1);
  }
  const rootDir = flag('--root') ?? process.cwd();
  const id = flag('--id');
  const orientation = (flag('--orientation') as FootageRequest['orientation']) ?? 'portrait';
  const size = (flag('--size') as FootageRequest['size']) ?? 'medium';
  const minDuration = Number(flag('--min-duration') ?? '3');

  const wantList = argv.includes('--list');
  const listN = Number(flag('--list') ?? '10') || 10;
  const pickIndex = flag('--index') !== undefined ? Number(flag('--index')) : undefined;
  const pickVideoId = flag('--video-id') !== undefined ? Number(flag('--video-id')) : undefined;

  try {
    // --list: browse candidates (id, dims, duration, poster + mid preview URL) WITHOUT downloading, so
    // you can eyeball options and pick a specific one. Preview URLs across the clip catch late-reveal
    // subjects.
    if (wantList) {
      const result = await searchFootage({ query, orientation, size, minDuration });
      console.log(`[footage] ${result.candidates.length} candidates for "${query}" (${orientation}, ≥${minDuration}s) — pick with --index <n> or --video-id <id>:`);
      result.candidates.slice(0, listN).forEach((c, i) => {
        console.log(`  [${i}] id=${c.id}  ${c.width}x${c.height}  ${c.duration}s  by ${c.author}`);
        console.log(`        poster: ${c.poster ?? '(none)'}`);
        if (c.preview) console.log(`        mid:    ${c.preview}`);
        console.log(`        page:   ${c.page}`);
      });
      return;
    }

    const result = await pickFootage({
      query,
      ...(id ? { id } : {}),
      orientation,
      size,
      minDuration,
      ...(pickVideoId !== undefined ? { videoId: pickVideoId } : {}),
      ...(pickIndex !== undefined ? { index: pickIndex } : {}),
      rootDir,
    });

    if (result.cached) {
      console.log(`[footage] cached "${result.id}" (hash ${result.hash}) — reusing ${result.localPath}`);
    } else {
      const dims = result.width !== undefined && result.height !== undefined ? `${result.width}x${result.height} ` : '';
      const mb = result.bytes !== undefined ? `(${(result.bytes / 1e6).toFixed(1)} MB) ` : '';
      console.log(`[footage] downloaded "${result.id}" ${dims}${mb}← Pexels #${result.pexelsId ?? '?'}`);
    }
    console.log(`[footage]   catalog → library/index.json  (${result.assetRef})`);
    printUse(result.id);
  } catch (err) {
    console.error(`[footage] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** Register/update the `asset` catalog entry (kind='asset', format='video') — mirrors imagegen. */
function registerCatalog(
  rootDir: string,
  id: string,
  uri: string,
  req: FootageRequest,
  hash: string,
  video: PexelsVideo | undefined,
): FootageProvenance {
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.footage ??= {};
  const prev = idx.entries.footage[id] ?? {};
  // Only the strict Provenance keys (catalog.ts): source/license/prompt/size/cache_hash.
  const provenance: FootageProvenance = {
    source: video
      ? `Pexels ${video.url} by ${video.user.name} (${video.user.url}) [${req.orientation}]`
      : ((prev.provenance?.source as string | undefined) ?? 'Pexels (cached)'),
    prompt: req.query,
    size: req.size,
    cache_hash: hash,
    // Pexels License: free for commercial use, no attribution required on media; credit "Pexels" per API guidelines.
    license: 'Pexels License (free commercial, no-attribution; credit Pexels + author appreciated)',
  };
  idx.entries.footage[id] = {
    id,
    version: (prev.version as string | undefined) ?? '1.0.0',
    kind: 'asset',
    format: 'video',
    uri,
    tags: ['footage', 'video', 'pexels', 'stock'],
    deps: [],
    provenance,
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  return provenance;
}

function printUse(id: string): void {
  console.log(`[footage]   use  → a story show item: { footage: ${id}, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }`);
  console.log('[footage]   tip  → grade it to the dark palette with args.effects (blur/color_grade/vignette) so it matches the cinematic look.');
}

if (import.meta.url === `file://${process.argv[1]}`) { void main(); }
