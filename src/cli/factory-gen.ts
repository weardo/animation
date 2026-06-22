// factory-gen — the ASSET GENERATION FACTORY CLI (ADR-001/002). Turns a data-driven CharacterSpec
// into a registered, reusable, content-addressed library asset — no manual art, no Remotion.
//
//   npm run factory:gen <spec.json>
//
// Pipeline (all deterministic): read spec → validate (Zod) → write the canonical spec into the
// library → render a PREVIEW (characterMarkup → SVG → rsvg-convert → PNG) → content-hash the spec →
// register/update the catalog entry (kind=rig, format=procedural, manifest, provenance). The asset
// is then usable in any scene via a `rig` layer (the loader embeds the spec into the Scene IR).
//
// Files+JSON store behind the LibraryResolver (the chosen v1 backing); a DB/registry can replace it
// later without touching this CLI's contract.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import objectHash from 'object-hash';

import { parseSpec, type CharacterSpec } from '../factory/spec.js';
import { characterMarkup } from '../factory/character.js';
import type { RigClip } from '../ir/index.js';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREVIEW_FRAME = 18; // mid-idle (eyes open, gentle breathe) — deterministic
const FPS = 30;
const IDLE: RigClip[] = [{ anim: 'idle', loop: true }];

/** A 480×480 preview SVG: the character on the Kurzgesagt night-blue gradient. */
function previewSvg(spec: CharacterSpec): string {
  const inner = characterMarkup(spec, PREVIEW_FRAME, FPS, IDLE);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="480" viewBox="0 0 480 480">` +
    `<defs><radialGradient id="bg" cx="50%" cy="34%" r="80%">` +
    `<stop offset="0%" stop-color="#243056"/><stop offset="100%" stop-color="#0f1730"/></radialGradient></defs>` +
    `<rect width="480" height="480" fill="url(#bg)"/>` +
    `<g transform="translate(240 250)">${inner}</g></svg>`
  );
}

function main(): void {
  const specArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!specArg) {
    console.error('usage: npm run factory:gen <spec.json>');
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(resolvePath(ROOT, specArg), 'utf8'));
  const spec = parseSpec(raw); // validate → CharacterSpec (throws on invalid)
  const id = spec.id;

  // 1. canonical spec → library/characters/<id>/<id>.spec.json (the source of truth the loader reads)
  const dir = resolvePath(ROOT, 'library', 'characters', id);
  mkdirSync(dir, { recursive: true });
  const specPath = resolvePath(dir, `${id}.spec.json`);
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');

  // 2. preview PNG (deterministic; no Remotion — rsvg-convert rasterises the SVG)
  const svgPath = resolvePath(dir, `${id}.preview.svg`);
  const pngPath = resolvePath(dir, `${id}.preview.png`);
  writeFileSync(svgPath, previewSvg(spec), 'utf8');
  execFileSync('rsvg-convert', [svgPath, '-o', pngPath]);

  // 3. content hash of the spec (the addressable identity of this asset version)
  const hash = objectHash(spec);

  // 4. register/update the catalog entry
  const idxPath = resolvePath(ROOT, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.characters ??= {};
  const prev = idx.entries.characters[id] ?? {};
  idx.entries.characters[id] = {
    id,
    version: prev.version ?? '1.0.0',
    kind: 'rig',
    format: 'procedural',
    uri: `proc://${id}`,
    tags: prev.tags ?? ['procedural', 'character', 'kurzgesagt', 'factory'],
    deps: [],
    manifest: {
      mounts: { head_top: { bone: 'head' }, handR: { bone: 'armR' }, handL: { bone: 'armL' } },
      variants: { palette: Object.keys(spec.palette) },
      clips: ['idle', 'blink', 'wave'],
      bounds: { w: Math.round(spec.body.rx * 2 + spec.arms.length), h: Math.round(spec.head.r * 2 + spec.legs.footCy) },
    },
    provenance: { source: 'factory', generator: 'factory-gen', spec_hash: hash, license: 'CC0' },
    preview: `characters/${id}/${id}.preview.png`,
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');

  console.log(`[factory] generated "${spec.name}" (${id})`);
  console.log(`[factory]   spec    → ${specPath}`);
  console.log(`[factory]   preview → ${pngPath}`);
  console.log(`[factory]   hash    → ${hash}`);
  console.log(`[factory]   catalog → library/index.json  (proc://${id})`);
}

main();
