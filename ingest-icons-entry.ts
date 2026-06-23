// factory:ingest-icons — the COMPOSITION ROOT for the icon-ingest CLI (M7b). Like factory-gen-entry.ts
// and render-entry.tsx, this file lives OUTSIDE src/ because it NAMES a provider plugin: it imports the
// core-objects `ObjectSpecSchema` and INJECTS it into the engine-side `ingestIcons()` (src/cli). So the
// engine core (src/) imports no plugin — the plugin→core arrow holds and `grep "from .*plugins/" src/`
// stays empty (the delete-the-plugin gate, verify-render §8).
//
//   npm run factory:ingest-icons                  # ingest the default lucide subset (~8 icons)
//   npm run factory:ingest-icons -- heart leaf     # ingest a chosen subset
//   npm run factory:ingest-icons -- --offline      # use the built-in bundled fallback (no network)

import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ingestIcons } from './src/cli/ingest-icons.js';
import { ObjectSpecSchema } from './plugins/core-objects/index.js';

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)));

ingestIcons({ args: process.argv.slice(2), rootDir: ROOT, validateSpec: ObjectSpecSchema }).catch(
  (err) => {
    console.error(`[ingest] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
