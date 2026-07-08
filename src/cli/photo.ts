// factory:photo — OFFLINE still-image sourcing for documentaries: real archival subjects (Wikimedia
// Commons) + generic mood b-roll (Pexels Photos), behind ONE CLI with two providers.
//
// Golden rule 1/2 (like footage/imagegen): fetch ONCE OFFLINE into a content-addressed cache, register an
// `asset` catalog entry (kind=asset, format=image), and the render replays the FIXED file via the existing
// AssetLayer (<Img>) → byte-deterministic even though the search isn't. Attribution is packed into the
// provenance `source` string (the strict ProvenanceSchema has no dedicated field) — for Wikimedia that's
// the REQUIRED CC/PD credit; it doubles as the on-screen/description attribution the journalism use needs.
//
// USAGE:
//   factory:photo "<query>" --id <asset-id> [--source wikimedia|pexels] [--orientation landscape|portrait]
//   browse:  --list [N]                     list candidates (title, dims, license, page URL) — DON'T take #0 blindly
//   pick:    --index <n>                     fetch a SPECIFIC candidate (default 0)
// Then in a story:  { asset: <id>, as: still, args: { z: 1, kenburns: "in" } }
//
// `searchPhoto`/`pickPhoto` are the reusable core (also wrapped by the MCP tool layer — see
// mcp-server/tools/photo.ts). They are deliberately SILENT (no console I/O) so they are safe to call
// from any host, including an MCP stdio server where stray stdout writes would corrupt the protocol
// framing; all CLI-facing console output stays in `main()`.

import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';
import objectHash from 'object-hash';

const UA = 'AnimationFactory/1.0 (news-documentary tool; contact via project) generic-http';

/** The two supported photo providers. */
export const PHOTO_SOURCE_IDS = ['wikimedia', 'pexels'] as const;
export type PhotoSourceId = (typeof PHOTO_SOURCE_IDS)[number];

export interface PhotoRequest {
  query: string;
  source: PhotoSourceId;
  orientation: 'landscape' | 'portrait' | 'any';
}

/** One selectable image with everything needed to download + attribute it. */
export interface PhotoCandidate {
  key: string; // stable per-image id (for cache addressing + logging)
  downloadUrl: string; // a reasonably-sized variant (≤~1600px)
  width: number;
  height: number;
  title: string;
  license: string; // short name, e.g. "CC BY-SA 4.0" / "Pexels License"
  attribution: string; // full credit string (author + license + link) → provenance.source
  pageUrl: string;
  ext: string; // jpg/png
}

interface PhotoSource {
  readonly id: string;
  search(req: PhotoRequest): Promise<PhotoCandidate[]>;
}

/** Wikimedia Commons — real archival subjects, CC/PD with required attribution. */
const wikimedia: PhotoSource = {
  id: 'wikimedia',
  async search(req) {
    const api =
      'https://commons.wikimedia.org/w/api.php?' +
      new URLSearchParams({
        action: 'query',
        format: 'json',
        generator: 'search',
        gsrsearch: req.query,
        gsrnamespace: '6', // File:
        gsrlimit: '24',
        prop: 'imageinfo',
        iiprop: 'url|size|extmetadata|mime',
        iiurlwidth: '1600', // a scaled thumb URL (light)
      }).toString();
    const resp = await fetch(api, { headers: { 'User-Agent': UA } });
    if (!resp.ok) throw new Error(`Wikimedia API ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const data = (await resp.json()) as { query?: { pages?: Record<string, WikiPage> } };
    const pages = Object.values(data.query?.pages ?? {});
    const out: PhotoCandidate[] = [];
    for (const p of pages) {
      const ii = p.imageinfo?.[0];
      if (!ii) continue;
      const mime = ii.mime ?? '';
      if (!/image\/(jpeg|png)/.test(mime)) continue; // skip svg/gif/tiff (photos only)
      const meta = ii.extmetadata ?? {};
      const strip = (h?: string): string => (h ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      const licenseShort = strip(meta.LicenseShortName?.value) || 'see Wikimedia';
      const artist = strip(meta.Artist?.value) || strip(meta.Credit?.value) || 'unknown author';
      const ext = mime.includes('png') ? 'png' : 'jpg';
      out.push({
        key: String(p.pageid),
        downloadUrl: ii.thumburl ?? ii.url,
        width: ii.thumbwidth ?? ii.width ?? 0,
        height: ii.thumbheight ?? ii.height ?? 0,
        title: p.title.replace(/^File:/, ''),
        license: licenseShort,
        attribution: `Wikimedia Commons — "${p.title.replace(/^File:/, '')}" by ${artist} (${licenseShort}), ${ii.descriptionurl ?? ''}`.trim(),
        pageUrl: ii.descriptionurl ?? `https://commons.wikimedia.org/?curid=${p.pageid}`,
        ext,
      });
    }
    return out.filter((c) => matchOrientation(c, req.orientation));
  },
};

/** Pexels Photos — generic mood b-roll, no attribution required (credit appreciated). */
const pexels: PhotoSource = {
  id: 'pexels',
  async search(req) {
    const key = process.env['PEXELS_API_KEY'];
    if (!key) throw new Error('PEXELS_API_KEY not set (needed for --source pexels).');
    const url =
      'https://api.pexels.com/v1/search?' +
      new URLSearchParams({
        query: req.query,
        per_page: '24',
        ...(req.orientation !== 'any' ? { orientation: req.orientation } : {}),
      }).toString();
    const resp = await fetch(url, { headers: { Authorization: key } });
    if (!resp.ok) throw new Error(`Pexels API ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const data = (await resp.json()) as { photos?: PexelsPhoto[] };
    return (data.photos ?? []).map((p) => ({
      key: String(p.id),
      downloadUrl: p.src.large2x ?? p.src.large ?? p.src.original,
      width: p.width,
      height: p.height,
      title: (p.alt || req.query).slice(0, 80),
      license: 'Pexels License (free commercial, no-attribution)',
      attribution: `Pexels — photo by ${p.photographer} (${p.url})`,
      pageUrl: p.url,
      ext: 'jpg',
    }));
  },
};

const SOURCES: Record<PhotoSourceId, PhotoSource> = { wikimedia, pexels };

function matchOrientation(c: PhotoCandidate, o: PhotoRequest['orientation']): boolean {
  if (o === 'any' || !c.width || !c.height) return true;
  return o === 'portrait' ? c.height >= c.width : c.width >= c.height;
}

/** Downscale/recompress a downloaded image to a light ≤1600px jpg (Ken Burns pans stay cheap). */
function toLight(srcPath: string, outPath: string): boolean {
  try {
    execFileSync('ffmpeg', [
      '-y', '-loglevel', 'error', '-i', srcPath,
      '-vf', "scale='min(iw,1600)':'min(ih,1600)':force_original_aspect_ratio=decrease",
      '-q:v', '3', outPath,
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Browse candidates for a query — no download, no side effects (safe to call repeatedly). */
export async function searchPhoto(req: {
  query: string;
  source?: PhotoSourceId;
  orientation?: PhotoRequest['orientation'];
}): Promise<PhotoCandidate[]> {
  const source = req.source ?? 'wikimedia';
  const orientation = req.orientation ?? 'any';
  const provider = SOURCES[source];
  if (!provider) throw new Error(`unknown source "${source}" (wikimedia|pexels)`);
  return provider.search({ query: req.query, source, orientation });
}

export interface PickPhotoParams {
  query: string;
  source?: PhotoSourceId;
  orientation?: PhotoRequest['orientation'];
  id?: string;
  /** Which search result to fetch (default 0 — but browse with searchPhoto first, don't take #0 blindly). */
  index?: number;
  /** Project root the `public/img` + `library/index.json` paths are resolved against (default cwd). */
  rootDir?: string;
  /** Pre-fetched candidates (avoids a duplicate search call when the caller already has them). */
  candidates?: PhotoCandidate[];
}

export interface PickPhotoResult {
  assetRef: string; // asset:// URI registered in the catalog
  localPath: string; // absolute path to the downloaded (downscaled if ffmpeg available) image
  downscaled: boolean; // false → ffmpeg was unavailable, raw bytes were kept
  title: string;
  width: number;
  height: number;
  provenance: {
    source: string; // full attribution (author + license + link) — the journalism credit
    license: string;
    size: string;
    cache_hash: string;
  };
}

/** Fetch + downscale one candidate, register its `asset` catalog entry, and return its ref + provenance. */
export async function pickPhoto(params: PickPhotoParams): Promise<PickPhotoResult> {
  const rootDir = params.rootDir ?? process.cwd();
  const source = params.source ?? 'wikimedia';
  const orientation = params.orientation ?? 'any';
  const provider = SOURCES[source];
  if (!provider) throw new Error(`unknown source "${source}" (wikimedia|pexels)`);
  const id = (params.id ?? `photo-${objectHash({ q: params.query, source }).slice(0, 10)}`).replace(/[^a-z0-9_-]/gi, '-');

  const imgDir = resolvePath(rootDir, 'public', 'img');
  mkdirSync(imgDir, { recursive: true });

  const candidates = params.candidates ?? (await searchPhoto({ query: params.query, source, orientation }));
  if (candidates.length === 0) {
    throw new Error(`no ${source} image for "${params.query}" (${orientation}).`);
  }
  const index = params.index ?? 0;
  const pick = candidates[index];
  if (!pick) {
    throw new Error(`index ${index} out of range (0..${candidates.length - 1}).`);
  }

  const hash = objectHash({ q: params.query, source, key: pick.key }).slice(0, 12);
  const finalExt = 'jpg';
  const outPath = resolvePath(imgDir, `${id}.${finalExt}`);
  const uri = `asset://img/${id}.${finalExt}`;

  // Download the chosen variant, then downscale to a light jpg (fallback: keep the raw download).
  const resp = await fetch(pick.downloadUrl, { headers: { 'User-Agent': UA } });
  if (!resp.ok) throw new Error(`download failed ${resp.status} for ${pick.downloadUrl}`);
  const raw = Buffer.from(await resp.arrayBuffer());
  const tmp = resolvePath(imgDir, `${id}.raw.${pick.ext}`);
  writeFileSync(tmp, raw);
  let downscaled = true;
  if (toLight(tmp, outPath)) {
    rmSync(tmp, { force: true });
  } else {
    // ffmpeg missing → keep the raw bytes under the final path (may be heavier).
    writeFileSync(outPath, raw);
    rmSync(tmp, { force: true });
    downscaled = false;
  }

  registerCatalog(rootDir, id, uri, source, pick, hash);

  return {
    assetRef: uri,
    localPath: outPath,
    downscaled,
    title: pick.title,
    width: pick.width,
    height: pick.height,
    provenance: {
      source: pick.attribution,
      license: pick.license,
      size: `${pick.width}x${pick.height}`,
      cache_hash: hash,
    },
  };
}

async function main(): Promise<void> {
  try {
    const argv = process.argv.slice(2);
    const query = argv.find((a) => !a.startsWith('-'));
    const flag = (n: string): string | undefined => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
    if (!query) {
      console.error('usage: factory:photo "<query>" --id <asset-id> [--source wikimedia|pexels] [--orientation landscape|portrait] [--list [N]] [--index <n>]');
      process.exit(1);
    }
    const rootDir = flag('--root') ?? process.cwd();
    const source = (flag('--source') as PhotoSourceId) ?? 'wikimedia';
    if (!SOURCES[source]) { console.error(`[photo] unknown --source "${source}" (wikimedia|pexels)`); process.exit(1); }
    const orientation = (flag('--orientation') as PhotoRequest['orientation']) ?? 'any';
    const id = (flag('--id') ?? `photo-${objectHash({ q: query, source }).slice(0, 10)}`).replace(/[^a-z0-9_-]/gi, '-');
    const wantList = argv.includes('--list');
    const listN = Number(flag('--list') ?? '10') || 10;
    const pickIndex = flag('--index') !== undefined ? Number(flag('--index')) : 0;

    const candidates = await searchPhoto({ query, source, orientation });
    if (candidates.length === 0) { console.error(`[photo] no ${source} image for "${query}" (${orientation}).`); process.exit(1); }

    if (wantList) {
      console.log(`[photo] ${candidates.length} ${source} candidates for "${query}" — pick with --index <n>:`);
      candidates.slice(0, listN).forEach((c, i) => {
        console.log(`  [${i}] ${c.width}x${c.height}  ${c.license}`);
        console.log(`        title: ${c.title}`);
        console.log(`        page:  ${c.pageUrl}`);
      });
      return;
    }

    if (!candidates[pickIndex]) {
      console.error(`[photo] --index ${pickIndex} out of range (0..${candidates.length - 1}); try --list.`);
      process.exit(1);
    }

    const result = await pickPhoto({ query, source, orientation, id, index: pickIndex, rootDir, candidates });

    if (!result.downscaled) {
      console.warn('[photo]   (ffmpeg unavailable — kept raw image; install ffmpeg to downscale)');
    }
    const kb = (statSync(result.localPath).size / 1024).toFixed(0);
    console.log(`[photo] ${source}: "${result.title}" ${result.width}x${result.height} → ${result.assetRef} (${kb} KB)`);
    console.log(`[photo]   license: ${result.provenance.license}`);
    console.log(`[photo]   catalog → library/index.json  (${result.assetRef})`);
    console.log(`[photo]   use  → a story show item: { asset: ${id}, as: still, args: { z: 1, kenburns: "in" } }`);
  } catch (err) {
    console.error(`[photo] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

/** Register/update the `asset` catalog entry (kind=asset, format=image) — mirrors imagegen/footage. */
function registerCatalog(rootDir: string, id: string, uri: string, source: string, pick: PhotoCandidate, hash: string): void {
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.photos ??= {};
  const prev = idx.entries.photos[id] ?? {};
  idx.entries.photos[id] = {
    id,
    version: (prev.version as string | undefined) ?? '1.0.0',
    kind: 'asset',
    format: 'image',
    uri,
    tags: ['photo', 'still', source],
    deps: [],
    provenance: {
      source: pick.attribution, // full attribution (author + license + link) — the journalism credit
      license: pick.license,
      size: `${pick.width}x${pick.height}`,
      cache_hash: hash,
    },
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
}

interface WikiPage {
  pageid: number;
  title: string;
  imageinfo?: {
    url: string;
    thumburl?: string;
    thumbwidth?: number;
    thumbheight?: number;
    width?: number;
    height?: number;
    mime?: string;
    descriptionurl?: string;
    extmetadata?: Record<string, { value?: string }>;
  }[];
}
interface PexelsPhoto {
  id: number;
  width: number;
  height: number;
  url: string;
  alt?: string;
  photographer: string;
  src: { original: string; large2x?: string; large?: string; medium?: string };
}

if (import.meta.url === `file://${process.argv[1]}`) { void main(); }
