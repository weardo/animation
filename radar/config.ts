// News Radar — config loader. The radar's behaviour is DATA (radar.config.json at the repo root), not
// code: intervals, thresholds, the source slices, the lexicons + weights. This unit reads that file,
// JSON.parses it, and back-fills any missing top-level field from a sane default so a partial (or absent)
// config still yields a fully-formed RadarConfig the daemon can run on. Pure-ish: one file read, no I/O
// beyond it. (This is a live service, not a render — no determinism constraint here.)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROJECT_ROOT } from '../agents/claude.js';
import type { RadarConfig } from './types.js';

/** The safe fallback — every field the daemon touches, tuned to run on the keyless GDELT+RSS lanes alone. */
const DEFAULTS: RadarConfig = {
  ingestIntervalSec: 240,
  scoreIntervalSec: 420,
  finalistCount: 25,
  notifyThreshold: 78,
  scoreFloor: 12,
  pruneOlderThanHours: 48,
  clusterWindowMin: 90,
  sources: {
    gdelt: { enabled: true },
    rss: { enabled: true },
    newsdata: { enabled: true },
    osint: { enabled: false },
  },
  lexicons: { india: [], viral: [], crisis: [] },
  weights: { recency: 1.0, source: 0.8, india: 1.3, viral: 0.9, crisisSpike: 1.2 },
  sourceWeights: {},
  // Default to silence: an unconfigured box shouldn't try to push (the studio can still poll the shortlist).
  notify: { channel: 'none' },
};

/**
 * Load the radar config from `path` (default: <repoRoot>/radar.config.json). A missing/unreadable file or
 * an absent section degrades to DEFAULTS rather than throwing, so the daemon always comes up. The nested
 * objects (sources/lexicons/weights/…) are merged shallowly — the file's section, when present, wins
 * wholesale over the default of the same name.
 */
export function loadConfig(path?: string): RadarConfig {
  const p = path ?? resolve(PROJECT_ROOT, 'radar.config.json');
  let parsed: Partial<RadarConfig> = {};
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8')) as Partial<RadarConfig>;
  } catch (e) {
    console.warn(`[config] could not read ${p}: ${(e as Error).message} — using defaults`);
  }
  return {
    ...DEFAULTS,
    ...parsed,
    sources: { ...DEFAULTS.sources, ...parsed.sources },
    lexicons: { ...DEFAULTS.lexicons, ...parsed.lexicons },
    weights: { ...DEFAULTS.weights, ...parsed.weights },
    sourceWeights: { ...DEFAULTS.sourceWeights, ...parsed.sourceWeights },
    notify: { ...DEFAULTS.notify, ...parsed.notify },
  };
}
