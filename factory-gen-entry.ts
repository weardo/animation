// factory:gen — a THIN source-material CLI (ADR-006/007). The engine specializes in NOTHING, so the
// character-specific factory (CharacterSpec → library entry + preview) no longer lives in core; it is
// OWNED by the `blob-creature` provider plugin. This CLI just dispatches to that provider's
// `generate(...)` — the generic shape any provider plugin can ship (a chart plugin would expose its
// own ChartSpec generator the same way).
//
// ADR-007 code-location: as a composition root that NAMES a specific provider plugin, this CLI lives
// OUTSIDE src/ (alongside render-entry.tsx) so the engine core (src/) imports no plugin — the
// plugin→core arrow holds and `grep "from .*plugins/" src/` stays empty.
//
//   npm run factory:gen <spec.json>
//
// Pipeline (all deterministic, in the plugin): read spec → validate (Zod) → write canonical spec into
// the library → render a preview (rsvg-convert) → content-hash → register the catalog entry
// (kind=rig, format=procedural, provider=blob-creature). Usable in any scene via a `rig` layer.

import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate } from './plugins/blob-creature/generator.js';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)));

function main(): void {
  const specArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!specArg) {
    console.error('usage: npm run factory:gen <spec.json>');
    process.exit(1);
  }

  // Dispatch to the active provider plugin's source-material generator (blob-creature today).
  const res = generate(specArg, ROOT);

  console.log(`[factory] generated "${res.name}" (${res.id})  [provider: blob-creature]`);
  console.log(`[factory]   spec    → ${res.specPath}`);
  console.log(`[factory]   preview → ${res.previewPath}`);
  console.log(`[factory]   hash    → ${res.hash}`);
  console.log(`[factory]   catalog → library/index.json  (${res.uri})`);
}

main();
