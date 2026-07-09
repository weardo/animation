// News Radar — smoke test. A fast, NETWORK-FREE + AI-FREE end-to-end check of the two things that decide
// whether the pipeline is worth anything: does the store round-trip real items, and does the pure funnel
// actually DISCRIMINATE — pushing a clear India story and a global-viral one above mundane noise? We feed a
// handful of fixture RawItems through the real store + the real scoreItem/selectFinalists (NO claude -p, NO
// fetch), then assert the ranking. Run it with `npm run radar:smoke` (tsx radar/radar.smoke.test.ts).
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_ROOT } from '../agents/claude.js';
import { loadConfig } from './config.js';
import { scoreItem, selectFinalists } from './funnel.js';
import { openStore } from './store.js';
import type { RawItem, StoredItem } from './types.js';

// --- tiny assert harness ------------------------------------------------------------------------
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// --- fixtures: a clear India story, a global-viral one, and two pieces of pure noise -------------
const now = Date.now();
const raw: RawItem[] = [
  {
    // INDIA lane: neighbour-conflict, India-source, crisis words + geography → should score high.
    url: 'https://example.com/india-china-lac-clash',
    title: 'India and China troops clash at LAC in Ladakh, several soldiers killed in border escalation',
    source: 'reuters',
    seenAt: now,
    publishedAt: now,
    sourceCountry: 'IN',
    summary: 'A fresh standoff along the Line of Actual Control leaves soldiers dead on both sides.',
  },
  {
    // VIRAL lane: dramatic global animal/disaster clip, no India angle → wins on the viral lexicon alone.
    url: 'https://example.com/flood-animals-viral',
    title: 'Shocking viral video: massive flood sweeps elephants and tigers, dramatic rescue caught on camera goes viral, millions watch',
    source: 'ani',
    seenAt: now,
    publishedAt: now,
    summary: 'Onlookers film a herd being pulled to safety as waters rise.',
  },
  {
    // NOISE 1: mundane local civics, zero lexicon hits → should fall below the floor.
    url: 'https://example.com/parking-policy',
    title: 'City council approves updated parking regulations for the downtown district',
    source: 'toi',
    seenAt: now,
    publishedAt: now,
    summary: 'The measure adjusts meter hours after months of public consultation.',
  },
  {
    // NOISE 2: mundane retail, unknown source (default weight), zero lexicon hits.
    url: 'https://example.com/bakery-menu',
    title: 'Regional bakery introduces a new seasonal pastry menu this autumn',
    source: 'someblog',
    seenAt: now,
    publishedAt: now,
    summary: 'The chain adds four items and retires two from last year.',
  },
];

function main(): void {
  console.log('News Radar smoke test\n');

  // Fresh DB every run: nuke the file (+ WAL/SHM sidecars) so stale rows never leak across runs.
  const dbPath = join(PROJECT_ROOT, '.data', 'radar-smoke.db');
  for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true });

  const cfg = loadConfig();
  // Lower the floor for the fixture set (real config's 12 is tuned for a live firehose, not 4 items): the
  // discrimination we're testing is india/viral ABOVE noise, not the production cutoff.
  const testCfg = { ...cfg, scoreFloor: 5, finalistCount: 10 };

  const store = openStore(dbPath);
  try {
    const inserted = store.upsertItems(raw);
    check('store round-trips all fixtures', inserted === raw.length, `inserted ${inserted}/${raw.length}`);

    // Pull them back as StoredItems and score each through the REAL funnel (cluster size from the store).
    const stored = store.unscoredItems(100);
    const scored = stored.map((item: StoredItem) => {
      const cluster = store.clusterSize(item, testCfg.clusterWindowMin * 60_000);
      return { id: item.id, item, result: scoreItem(item, testCfg, cluster) };
    });

    const { finalistIds } = selectFinalists(scored, testCfg);
    const byUrl = (u: string): (typeof scored)[number] | undefined =>
      scored.find((s) => s.item.url === u);
    const scoreOf = (u: string): number => byUrl(u)?.result.score ?? -Infinity;
    const idOf = (u: string): string => byUrl(u)?.id ?? '';

    const indiaS = scoreOf(raw[0]!.url);
    const viralS = scoreOf(raw[1]!.url);
    const noise1S = scoreOf(raw[2]!.url);
    const noise2S = scoreOf(raw[3]!.url);
    const worstNoise = Math.max(noise1S, noise2S);

    console.log(
      `\n  scores → india ${indiaS.toFixed(2)} · viral ${viralS.toFixed(2)} · ` +
        `noise ${noise1S.toFixed(2)}/${noise2S.toFixed(2)}\n`,
    );

    check('finalists are non-empty', finalistIds.length > 0, `${finalistIds.length} finalist(s)`);
    check('india lane matched', byUrl(raw[0]!.url)?.result.lane === 'india');
    check('viral lane matched', byUrl(raw[1]!.url)?.result.lane === 'viral');
    check('india outranks all noise', indiaS > worstNoise, `${indiaS.toFixed(2)} > ${worstNoise.toFixed(2)}`);
    check('viral outranks all noise', viralS > worstNoise, `${viralS.toFixed(2)} > ${worstNoise.toFixed(2)}`);
    check('india is a finalist', finalistIds.includes(idOf(raw[0]!.url)));
    check('viral is a finalist', finalistIds.includes(idOf(raw[1]!.url)));
    check('noise is dropped', !finalistIds.includes(idOf(raw[2]!.url)) && !finalistIds.includes(idOf(raw[3]!.url)));
  } finally {
    store.close();
  }

  console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures} failing check(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
