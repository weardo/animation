// factory:ingest-icons — ingest an OPEN-LICENSE icon set as `object`-provider library entries (M7b).
//
// "Reuse over invent" (CLAUDE.md r.3): an icon set is the cheapest possible reusable-asset library, and
// it costs ZERO authoring — we fetch a handful of permissively-licensed SVGs (lucide-static, ISC) ONCE
// OFFLINE, normalize each into the core-objects PROVIDER's ObjectSpec (`kind: "icon"`), content-address
// it, and catalog it under the `icons` namespace with full provenance + license. The render then
// replays the FIXED cached spec → byte-deterministic (golden rule 1: the offline asset is the record,
// not the fetch). The icon renders as a form-shadeable colored BADGE + the glyph outline, so the active
// stylekit shades it for FREE — like any prop fill (no per-icon styling).
//
//   npm run factory:ingest-icons                 # ingest the default lucide subset (~8 icons)
//   npm run factory:ingest-icons -- heart leaf    # ingest a chosen subset
//   npm run factory:ingest-icons -- --offline     # use the built-in bundled fallback (no network)
//
// Pipeline (all deterministic over the fetched-then-fixed SVG bytes):
//   fetch SVG → parse out the path `d` strings + viewBox (geometry ONLY — never raw markup) →
//   build an ObjectSpec (`kind:"icon"`, glyph = {paths, viewBox, strokeWidth, …}) → write the canonical
//   sidecar `library/icons/<id>/<id>.spec.json` → content-hash the spec → register/update the `icons`
//   namespace catalog entry (kind='rig', provider='object', uri='proc://<id>') with provenance+license.
//
// ADR-007 code-location: validating the icon spec needs the core-objects PROVIDER's `ObjectSpecSchema`,
// and naming a provider plugin is a COMPOSITION-ROOT concern — so the plugin schema is INJECTED by the
// repo-root entry `ingest-icons-entry.ts` (alongside render-entry.tsx / factory-gen-entry.ts), exactly
// like factory:gen. This module (in src/) imports NO plugin — it takes the validator as a parameter —
// so the engine core stays plugin-free (`grep "from .*plugins/" src/` empty; the delete-the-plugin
// gate holds). It is otherwise a pure library + offline-fetch operation (no provider dispatch).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { ZodType } from 'zod';
import objectHash from 'object-hash';
import { SemverSchema } from '../library/index.js';

/** The provider's ObjectSpec validator, injected by the composition root (keeps src/ plugin-free). */
export type SpecValidator = Pick<ZodType<Record<string, unknown>>, 'parse'>;

// ── The open-license SOURCE: lucide-static (ISC). Stroked 24×24 glyphs on a `currentColor` outline.
//    We pin a version so the bytes are reproducible; the fetched SVG is normalized + cached, so even
//    though the network fetch is non-deterministic the COMMITTED spec is the deterministic record. ──
const SOURCE = {
  name: 'lucide',
  version: '0.469.0',
  license: 'ISC',
  homepage: 'https://lucide.dev',
  // unpkg serves the raw per-icon SVGs of the lucide-static package, pinned by version.
  urlFor: (icon: string): string =>
    `https://unpkg.com/lucide-static@0.469.0/icons/${icon}.svg`,
  strokeWidth: 2,
  filled: false,
  viewBox: [0, 0, 24, 24] as [number, number, number, number],
} as const;

/** The default handful to ingest when none are named (a generic, demo-friendly set). */
const DEFAULT_ICONS = [
  'heart',
  'star',
  'leaf',
  'cloud',
  'sun',
  'rocket',
  'lightbulb',
  'globe',
] as const;

// A tiny built-in fallback so `--offline` works with no network (path data copied from lucide @0.469.0,
// ISC — the same bytes the fetch would yield). Keeps the CLI runnable + the demo reproducible offline.
const OFFLINE_PATHS: Record<string, string[]> = {
  heart: [
    'M2 9.5a5.5 5.5 0 0 1 9.591-3.676.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5',
  ],
  leaf: [
    'M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z',
    'M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12',
  ],
  star: [
    'M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z',
  ],
};

// ── SVG normalization (geometry ONLY) ──────────────────────────────────────────────────────────────
// Pull the `viewBox` and every `<path d="…">` out of the source SVG. We extract ONLY the path command
// string (a strict charset: SVG path commands + numbers/decimals/signs/spaces/commas) — never any raw
// markup — so what lands in the spec is pure DATA the provider can render safely (no script/attr inject).

/** Strict SVG-path-data charset: drawing commands + numeric tokens. Anything else is rejected. */
const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\-+eE\s]+$/;

function extractViewBox(svg: string): [number, number, number, number] | undefined {
  const m = svg.match(/viewBox\s*=\s*"([^"]+)"/);
  if (!m) return undefined;
  const parts = m[1].trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return undefined;
  return [parts[0], parts[1], parts[2], parts[3]];
}

function extractPaths(svg: string): string[] {
  const out: string[] = [];
  const re = /<path\b[^>]*\bd\s*=\s*"([^"]+)"[^>]*>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(svg)) !== null) {
    const d = m[1].trim();
    // SANITIZE: keep only valid path-data; drop anything with stray characters (defensive — the
    // provider draws this string, so it must be geometry, not arbitrary text).
    if (d.length > 0 && PATH_DATA.test(d)) out.push(d);
  }
  return out;
}

/** Fetch a source SVG (or fall back to the bundled offline path data) → normalized glyph geometry. */
async function loadGlyph(
  icon: string,
  offline: boolean,
): Promise<{ paths: string[]; viewBox: [number, number, number, number] }> {
  if (offline) {
    const paths = OFFLINE_PATHS[icon];
    if (!paths) {
      throw new Error(
        `--offline has no bundled path data for "${icon}" (offline set: ${Object.keys(OFFLINE_PATHS).join(', ')})`,
      );
    }
    return { paths, viewBox: SOURCE.viewBox };
  }
  const url = SOURCE.urlFor(icon);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} → HTTP ${res.status}`);
  const svg = await res.text();
  const paths = extractPaths(svg);
  if (paths.length === 0) throw new Error(`no usable <path d> found in ${url}`);
  const viewBox = extractViewBox(svg) ?? SOURCE.viewBox;
  return { paths, viewBox };
}

/** The catalog metadata we attach to each ingested entry (icons namespace). */
const TAGS = ['icon', 'object', 'ingested', SOURCE.name];

export interface IngestOptions {
  /** CLI argv (without node/script), e.g. ["heart","leaf","--offline"]. */
  args: string[];
  /** Repo root (where library/index.json lives). */
  rootDir: string;
  /** The core-objects provider's ObjectSpec validator, injected by the composition root. */
  validateSpec: SpecValidator;
}

/**
 * Ingest the named (or default) icon subset → content-addressed `object`-provider library entries.
 * Pure aside from the offline fetch + filesystem writes; the validator is injected so src/ names no
 * plugin. Returns the ingested ids (for the entry's summary).
 */
export async function ingestIcons(opts: IngestOptions): Promise<string[]> {
  const { args, rootDir, validateSpec } = opts;
  const offline = args.includes('--offline');
  const named = args.filter((a) => !a.startsWith('-'));
  const icons = named.length > 0 ? named : [...DEFAULT_ICONS];

  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.icons ??= {};

  const ingested: string[] = [];
  for (const icon of icons) {
    // a library id must be a stable, file-safe token; lucide names are already kebab-case.
    const id = `icon_${icon.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;
    const { paths, viewBox } = await loadGlyph(icon, offline);

    // Build + VALIDATE the ObjectSpec with the provider's OWN schema (so what we write is exactly what
    // resolves at render time). A neutral palette default; the active stylekit form-shades it for free.
    const spec = validateSpec.parse({
      id,
      kind: 'icon',
      // A generic warm fill + dark ink — Kurzgesagt-friendly, but the kit's paint owns the final look.
      palette: { fill: '#4d9be6', fillDark: '#2f6fb0', ink: '#16243f', accent: '#ffce4a' },
      size: 60,
      stroke: 4,
      glyph: {
        paths,
        viewBox,
        strokeWidth: SOURCE.strokeWidth,
        filled: SOURCE.filled,
        badge: true,
        badgeShape: 'rounded',
      },
      motion: { amp: 1 },
    });

    // 1. canonical sidecar → library/icons/<id>/<id>.spec.json (the DATA the loader inlines).
    const dir = resolvePath(rootDir, 'library', 'icons', id);
    mkdirSync(dir, { recursive: true });
    const sidecarPath = resolvePath(dir, `${id}.spec.json`);
    writeFileSync(sidecarPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');

    // 2. content hash of the spec (the addressable identity of this icon version).
    const hash = objectHash(spec, { algorithm: 'sha1', encoding: 'hex' });

    // 3. register/update the catalog entry under the `icons` namespace. Same rig-entry shape as a prop
    //    (kind='rig', provider='object', proc:// uri) so the existing loader/resolver path handles it.
    const prev = idx.entries.icons[id] ?? {};
    const version = (prev.version as string | undefined) ?? '1.0.0';
    idx.entries.icons[id] = {
      id,
      version: SemverSchema.parse(version),
      kind: 'rig',
      format: 'procedural',
      provider: 'object',
      uri: `proc://${id}`,
      tags: TAGS,
      deps: [],
      manifest: { mounts: {}, variants: { variant: [] } },
      provenance: {
        source: `${SOURCE.name}@${SOURCE.version} (${SOURCE.homepage}) — icon "${icon}"${offline ? ' [offline bundled]' : ''}`,
        spec_hash: hash,
        license: SOURCE.license,
      },
    };
    ingested.push(`${id} (${hash.slice(0, 8)})`);
    console.log(`[ingest] ${id}  ← ${icon}  paths:${paths.length}  hash:${hash.slice(0, 8)}  ${SOURCE.license}`);
  }

  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');
  console.log(`\n[ingest] ${ingested.length} icon(s) → library/icons/  (catalog: library/index.json, ns 'icons')`);
  console.log(`[ingest] source: ${SOURCE.name}@${SOURCE.version} (${SOURCE.license}) — provenance + license recorded per entry`);
  console.log(`[ingest] use     → a story cast ref { ref: <id> } + a show item { actor: <id> } (object layer)`);
  return ingested;
}
