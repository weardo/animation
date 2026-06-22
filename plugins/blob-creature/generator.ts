// blob-creature SOURCE-MATERIAL generator (ADR-006). Was core `src/cli/factory-gen.ts`; moved INTO
// the plugin because turning a CharacterSpec → a registered, content-addressed library entry + preview
// is how THIS provider generates its source material — not a core concern. Generalizes the pattern:
// any provider plugin MAY ship a `generate(...)` like this (a chart plugin would ship a ChartSpec one).
//
// Pipeline (all deterministic): read spec → validate (Zod) → write the canonical spec into the
// library → render a PREVIEW (characterMarkup → SVG → rsvg-convert → PNG) → content-hash the spec →
// register/update the catalog entry (kind=rig, format=procedural, provider=blob-creature). The asset
// is then usable in any scene via a `rig` layer (the library loader embeds the spec into the Scene IR).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { execFileSync } from 'node:child_process';

import objectHash from 'object-hash';

import type { RigClip } from '../../src/ir/index.js';
import { parseSpec, type CharacterSpec } from './spec.js';
import { characterMarkup } from './character.js';

const PREVIEW_FRAME = 18; // mid-idle (eyes open, gentle breathe) — deterministic
const FPS = 30;
const IDLE: RigClip[] = [{ anim: 'idle', loop: true }];

/** A 480×480 preview SVG: the creature on the Kurzgesagt night-blue gradient. */
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

export interface GenerateResult {
  id: string;
  name: string;
  specPath: string;
  previewPath: string;
  hash: string;
  uri: string;
}

/**
 * Generate the blob-creature source material for a spec file under `rootDir`'s library. Returns the
 * paths + content hash written. Pure file I/O over a validated spec; deterministic preview render.
 */
export function generate(specFile: string, rootDir: string): GenerateResult {
  const raw = JSON.parse(readFileSync(resolvePath(rootDir, specFile), 'utf8'));
  const spec = parseSpec(raw); // validate → CharacterSpec (throws on invalid)
  const id = spec.id;

  // 1. canonical spec → library/characters/<id>/<id>.spec.json (the source of truth the loader reads)
  const dir = resolvePath(rootDir, 'library', 'characters', id);
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
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.characters ??= {};
  const prev = idx.entries.characters[id] ?? {};
  const uri = `proc://${id}`;
  idx.entries.characters[id] = {
    id,
    version: prev.version ?? '1.0.0',
    kind: 'rig',
    format: 'procedural',
    /** The provider that renders this entry (ADR-006). The loader copies it into the rig def. */
    provider: 'blob-creature',
    uri,
    tags: prev.tags ?? ['procedural', 'character', 'kurzgesagt', 'factory'],
    deps: [],
    manifest: {
      mounts: { head_top: { bone: 'head' }, handR: { bone: 'armR' }, handL: { bone: 'armL' } },
      variants: { palette: Object.keys(spec.palette) },
      clips: ['idle', 'blink', 'wave'],
      bounds: { w: Math.round(spec.body.rx * 2 + spec.arms.length), h: Math.round(spec.head.r * 2 + spec.legs.footCy) },
    },
    provenance: { source: 'factory', generator: 'blob-creature', spec_hash: hash, license: 'CC0' },
    preview: `characters/${id}/${id}.preview.png`,
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');

  return { id, name: spec.name, specPath, previewPath: pngPath, hash, uri };
}
