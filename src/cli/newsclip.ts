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
//
// fetchNewsclip(...) is the reusable core (also called by the MCP `newsclip_fetch` tool); main() is a thin
// CLI wrapper around it.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';
import objectHash from 'object-hash';

interface ClipRequest {
  url: string;
  section?: string; // "start-end" seconds, e.g. "12-20"
  maxSeconds: number;
}

export interface NewsclipOptions {
  url: string;
  id?: string;
  /** Clip start, in seconds. Combine with `duration` to pull a `--download-sections` slice. */
  start?: number;
  /** Clip length, in seconds. With `start` set, bounds the downloaded section; alone, caps the transcode. */
  duration?: number;
  date?: string;
  rootDir?: string;
}

export interface NewsclipProvenance {
  source: string;
  license: string;
  cache_hash: string;
}

export interface NewsclipResult {
  clipPath: string;
  uri: string;
  id: string;
  publisher: string;
  cached: boolean;
  provenance: NewsclipProvenance;
}

function clipHash(req: ClipRequest): string {
  return objectHash({ u: req.url, s: req.section ?? '', m: req.maxSeconds }).slice(0, 12);
}

/**
 * Search public video (yt-dlp `ytsearch`) for the best match to a query → its watch URL + title (no download).
 * This is what lets the pipeline FIND the REAL video of a public statement / event / viral moment instead of
 * being handed a URL. Returns null on no match / yt-dlp missing / error (caller falls back to stock footage).
 */
export function searchClipUrl(query: string): { url: string; title: string } | null {
  try {
    // Search the top 6 but only keep SHORT clips (< 6 min) — a viral moment is short, and a long video
    // is slow/flaky to download. Take the first short match.
    const out = execFileSync(
      'yt-dlp',
      [
        `ytsearch6:${query}`,
        '--match-filter', 'duration < 360 & duration > 3',
        '--print', '%(webpage_url)s\t%(title)s',
        '--skip-download', '--no-warnings', '--no-playlist',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 },
    );
    const line = out.split('\n').map((l) => l.trim()).find((l) => l.startsWith('http'));
    if (!line) return null;
    const [url, title] = line.split('\t');
    return url ? { url, title: title ?? '' } : null;
  } catch {
    return null;
  }
}

const WHISPER_PYTHON = '.venv-whisper/bin/python';
const ALIGN_SCRIPT = 'scripts/tts/align_whisper.py';
const HF_HOME = process.env['HF_HOME'] ?? '/mnt/data/astra/.cache/hf';

/**
 * Find WHEN a phrase is spoken in a clip → the start seconds (with a ~1s lead-in), so the reel plays FROM
 * the actual moment (a gaffe / quote) instead of the clip's first seconds. Extracts the clip audio, whisper-
 * transcribes it (the existing align script + .venv-whisper), and searches the transcript for `phrase`.
 * Returns null on any failure (no whisper venv / phrase not found) → the caller plays from the start.
 */
export function locateClipMoment(clipPath: string, phrase: string, rootDir: string): number | null {
  const py = resolvePath(rootDir, WHISPER_PYTHON);
  const script = resolvePath(rootDir, ALIGN_SCRIPT);
  if (!existsSync(py) || !existsSync(script) || !existsSync(clipPath) || !phrase.trim()) return null;
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const target = norm(phrase);
  if (!target) return null;
  const tmp = resolvePath(rootDir, 'library', 'video', '.locate', objectHash({ clipPath, phrase }).slice(0, 12));
  const wav = resolvePath(tmp, 'a.wav');
  const alignJson = resolvePath(tmp, 'a.json');
  try {
    mkdirSync(tmp, { recursive: true });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', clipPath, '-ac', '1', '-ar', '16000', wav], { stdio: ['ignore', 'ignore', 'ignore'] });
    execFileSync(py, [script, '--wav', wav, '--out', alignJson, '--model', 'small'], { stdio: ['ignore', 'ignore', 'ignore'], env: { ...process.env, HF_HOME } });
    const words = JSON.parse(readFileSync(alignJson, 'utf8')) as Array<{ word: string; start: number }>;
    // Build a normalized transcript + track each word's char offset → its start time.
    let transcript = '';
    const offsets: Array<{ char: number; t: number }> = [];
    for (const x of words) {
      const nw = norm(x.word);
      if (!nw) continue;
      offsets.push({ char: transcript.length, t: x.start });
      transcript += nw + ' ';
    }
    const idx = transcript.indexOf(target);
    if (idx >= 0) {
      let t = 0;
      for (const o of offsets) { if (o.char <= idx) t = o.t; else break; }
      return Math.max(0, t - 1);
    }
    // Phrase not found verbatim → seek the LAST distinctive content word of the phrase.
    const tw = target.split(' ').filter((w) => w.length > 3);
    const key = tw[tw.length - 1];
    const hit = key ? offsets.find((_, i) => norm(words[i]?.word ?? '') === key) : undefined;
    return hit ? Math.max(0, hit.t - 1) : null;
  } catch {
    return null;
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
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
  // IGNORE yt-dlp's stdout (its "[youtube] Extracting URL…" progress) — when this runs inside the
  // orchestrate subprocess, stdout must stay PURE JSON (the OrchestrateResult); real errors go to stderr.
  execFileSync('yt-dlp', args, { stdio: ['ignore', 'ignore', 'inherit'] });
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
    // KEEP the news clip's OWN audio (light aac) — a raw viral clip's sound is often the point. It's
    // silent at render UNLESS the story sets `muted: false` (footage defaults to muted; add `volume` to duck).
    '-c:a', 'aac', '-b:a', '128k',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ]);
}

/**
 * Pull (or reuse the cached) a publicly-available news video clip and register it in the library
 * catalog as a light footage proxy. Content-addressed by {url, section, maxSeconds} — skip-if-exists.
 */
export async function fetchNewsclip(opts: NewsclipOptions): Promise<NewsclipResult> {
  try {
    execFileSync('yt-dlp', ['--version'], { stdio: 'ignore' });
  } catch {
    throw new Error('yt-dlp not on PATH — install it (pipx install yt-dlp) to pull news video.');
  }

  const rootDir = opts.rootDir ?? process.cwd();
  const section = opts.start !== undefined && opts.duration !== undefined
    ? `${opts.start}-${opts.start + opts.duration}`
    : undefined;
  const req: ClipRequest = {
    url: opts.url,
    ...(section ? { section } : {}),
    maxSeconds: section ? 0 : (opts.duration ?? 20),
  };
  const id = (opts.id ?? `newsclip-${clipHash(req)}`).replace(/[^a-z0-9_-]/gi, '-');
  const date = opts.date ?? '';

  const videoDir = resolvePath(rootDir, 'public', 'video');
  mkdirSync(videoDir, { recursive: true });
  const outPath = resolvePath(videoDir, `${id}.mp4`);
  const uri = `asset://video/${id}.mp4`;
  const hash = clipHash(req);

  const { publisher, title } = probeMeta(opts.url);
  let cached = false;
  if (existsSync(outPath)) {
    cached = true;
    console.log(`[newsclip] cached "${id}" (hash ${hash}) — reusing ${outPath}`);
  } else {
    const tmpDir = resolvePath(videoDir, `.tmp-${id}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      console.log(`[newsclip] pulling ${opts.url}${req.section ? ` [section ${req.section}]` : ''} …`);
      const raw = download(req, tmpDir);
      toProxy(raw, outPath, req.maxSeconds);
      console.log(`[newsclip] → ${uri}  (publisher: ${publisher}${title ? `, "${title.slice(0, 60)}"` : ''})`);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  const provenance = registerCatalog(rootDir, id, uri, opts.url, publisher, title, date, hash);
  console.log(`[newsclip]   use  → { footage: ${id}, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }`);
  console.log(`[newsclip]   ⚖  editorial/fair-use — keep it BRIEF + attribute "${publisher}" on-screen + in the description.`);

  return { clipPath: outPath, uri, id, publisher, cached, provenance };
}

function registerCatalog(
  rootDir: string,
  id: string,
  uri: string,
  url: string,
  publisher: string,
  title: string,
  date: string,
  hash: string,
): NewsclipProvenance {
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.newsclips ??= {};
  const prev = idx.entries.newsclips[id] ?? {};
  const provenance: NewsclipProvenance = {
    source: `${publisher}${title ? ` — "${title}"` : ''} — ${url}${date ? ` (captured ${date})` : ''}`,
    license: 'editorial / fair-use — brief attributed commentary; publicly-accessible source',
    cache_hash: hash,
  };
  idx.entries.newsclips[id] = {
    id,
    version: (prev.version as string | undefined) ?? '1.0.0',
    kind: 'asset',
    format: 'video',
    uri,
    tags: ['newsclip', 'evidence', 'footage'],
    deps: [],
    provenance,
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  console.log(`[newsclip]   catalog → library/index.json  (${uri})`);
  return provenance;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const url = argv.find((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  if (!url || !/^https?:\/\//.test(url)) {
    console.error('usage: factory:newsclip "<https url>" --id <asset-id> [--section 12-20] [--max-seconds 20] [--date YYYY-MM-DD]');
    process.exit(1);
    return;
  }

  const rootDir = flag('--root') ?? process.cwd();
  const section = flag('--section');
  let start: number | undefined;
  let duration: number | undefined;
  if (section) {
    const [a, b] = section.split('-');
    start = Number(a);
    duration = Number(b) - Number(a);
  } else {
    const maxSeconds = flag('--max-seconds');
    if (maxSeconds !== undefined) duration = Number(maxSeconds);
  }
  const id = flag('--id');
  const date = flag('--date');

  await fetchNewsclip({
    url,
    rootDir,
    ...(start !== undefined ? { start } : {}),
    ...(duration !== undefined ? { duration } : {}),
    ...(id ? { id } : {}),
    ...(date ? { date } : {}),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    console.error(`[newsclip] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
