// Minimal .env loader (no dependency). Reads KEY=VALUE lines from <root>/.env into process.env so the
// self-hoster can drop secrets (SARVAM_API_KEY, PEXELS_API_KEY, …) in one gitignored file; the render
// subprocess inherits them. Existing env vars win (so an explicit export overrides the file).
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROJECT_ROOT } from '../agents/claude.js';

export function loadDotenv(): void {
  const file = resolve(PROJECT_ROOT, '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || !m[1]) continue;
    let val = (m[2] ?? '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
