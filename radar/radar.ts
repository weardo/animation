// News Radar — the background DAEMON. This is the only unit that wires the stateless pieces together and
// keeps them turning: two independent timers over the ONE stateful store. Nothing here is pure — it's all
// orchestration + I/O + logging — but every loop body is wrapped so a single bad tick (a dead feed, a
// claude -p hiccup) NEVER kills its timer. (A live service, not a render — Date.now() heartbeats are fine.)
//
//   INGEST loop (every cfg.ingestIntervalSec): each enabled source adapter → fetchItems → upsert → prune.
//   SCORE  loop (every cfg.scoreIntervalSec): funnel-score the 'new' pool → promote finalists → judge them
//                with claude -p → write candidates → notify the ones over the threshold.
//
// The store is the whole truth between ticks; the two loops are decoupled (ingest can run 2-3× per score
// pass), so a slow judge call never starves ingestion and vice-versa.
import { pathToFileURL } from 'node:url';

import { openStore } from './store.js';
import { loadConfig } from './config.js';
import { scoreItem, selectFinalists } from './funnel.js';
import { judgeFinalists } from './judge.js';
import { makeNotifier } from './notify.js';
import { gdeltAdapter } from './sources/gdelt.js';
import { rssAdapter } from './sources/rss.js';
import { newsdataSource } from './sources/newsdata.js';
import type { RadarConfig, RadarStore, SourceAdapter, SourceConfigSlice } from './types.js';

const HOUR_MS = 3_600_000;
const MIN_MS = 60_000;

/** Options for starting the daemon — everything defaults, so `startRadar()` just works. */
export interface StartRadarOpts {
  /** Override the config path (else <repoRoot>/radar.config.json). */
  configPath?: string;
  /** Override the sqlite path (else <repoRoot>/.data/radar.db). */
  dbPath?: string;
  /** Inject a pre-loaded config (skips the file read — used by tests). */
  config?: RadarConfig;
  /** Inject a pre-opened store (used by tests). */
  store?: RadarStore;
}

/** The daemon handle. `stop()` halts BOTH timers and closes the store (idempotent — safe to call twice). */
export interface RadarHandle {
  stop(): void;
  store: RadarStore;
}

/** The three adapters we ship. osint is config-only (disabled) — no adapter, so it never appears here. */
const ALL_ADAPTERS: SourceAdapter[] = [gdeltAdapter, rssAdapter, newsdataSource];

/** The config slice for an adapter id (the four known keys), or undefined if the config omits it. */
function sliceFor(cfg: RadarConfig, id: string): SourceConfigSlice | undefined {
  return cfg.sources[id as keyof RadarConfig['sources']];
}

/**
 * Start the radar daemon. Loads config, opens the store, builds the enabled adapters + the notifier, kicks
 * an ingest immediately, and arms the two timers. Returns a handle whose `stop()` tears everything down.
 */
export function startRadar(opts: StartRadarOpts = {}): RadarHandle {
  const cfg = opts.config ?? loadConfig(opts.configPath);
  const store = opts.store ?? openStore(opts.dbPath);
  const notifier = makeNotifier(cfg);

  // Only the adapters whose config slice is present AND enabled. (An adapter with no slice is treated as
  // off — the daemon never fetches a source the operator didn't wire.)
  const adapters = ALL_ADAPTERS.filter((a) => sliceFor(cfg, a.id)?.enabled);

  console.log(
    `[radar] starting — sources: ${adapters.map((a) => a.id).join(', ') || '(none enabled)'} · ` +
      `ingest ${cfg.ingestIntervalSec}s · score ${cfg.scoreIntervalSec}s · notify ${cfg.notify.channel}`,
  );

  // Re-entrancy guards: a tick that runs long (a stalled feed, a 40s judge call) must not overlap the next
  // fire of the SAME timer — we simply skip a fire while the previous one is still in flight.
  let ingesting = false;
  let scoring = false;
  let stopped = false;

  // --- INGEST tick ----------------------------------------------------------------------------
  async function runIngest(): Promise<void> {
    if (ingesting || stopped) return;
    ingesting = true;
    try {
      const merged = [];
      for (const adapter of adapters) {
        const slice = sliceFor(cfg, adapter.id);
        if (!slice) continue;
        try {
          const items = await adapter.fetchItems(slice); // a throw here is this source's alone…
          console.log(`[radar] ingest ${adapter.id}: ${items.length} item(s)`);
          merged.push(...items);
        } catch (e) {
          // …caught + logged per-source so one dead feed never blanks the whole tick.
          console.warn(`[radar] ingest ${adapter.id} FAILED: ${(e as Error).message}`);
        }
      }
      const inserted = merged.length ? store.upsertItems(merged) : 0;
      const pruned = store.prune(cfg.pruneOlderThanHours * HOUR_MS);
      store.setState('ingest.lastRun', String(Date.now()));
      store.setState('ingest.lastInserted', String(inserted));
      console.log(`[radar] ingest done: +${inserted} new (${merged.length} fetched), pruned ${pruned}`);
    } catch (e) {
      // The whole tick failing (e.g. store I/O) must still not kill the timer.
      console.error(`[radar] ingest tick error: ${(e as Error).message}`);
    } finally {
      ingesting = false;
    }
  }

  // --- SCORE tick -----------------------------------------------------------------------------
  async function runScore(): Promise<void> {
    if (scoring || stopped) return;
    scoring = true;
    try {
      // 1) Funnel: cheap pure scoring over the 'new' pool, then promote the top finalists (drop the rest).
      const fresh = store.unscoredItems(500);
      if (fresh.length) {
        const scored = fresh.map((item) => {
          const cluster = store.clusterSize(item, cfg.clusterWindowMin * MIN_MS);
          return { id: item.id, item, result: scoreItem(item, cfg, cluster) };
        });
        const { finalistIds, dropped } = selectFinalists(scored, cfg);
        store.applyFunnel(
          scored.map((s) => ({ id: s.id, result: s.result })),
          finalistIds,
        );
        console.log(`[radar] funnel: scored ${scored.length}, ${finalistIds.length} finalist(s), dropped ${dropped}`);
      }

      // 2) Judge: hand the current finalists to the AI editor (batched + cached → judged at most once).
      const finalists = store.finalists(cfg.finalistCount);
      if (finalists.length) {
        const judgments = await judgeFinalists(finalists, cfg);
        if (judgments.length) store.writeCandidates(judgments);
        console.log(`[radar] judge: ${finalists.length} finalist(s) → ${judgments.length} candidate(s)`);
      }

      // 3) Notify: everything over the threshold that hasn't been pinged yet. send() never throws.
      const ready = store.shortlist({ minScore: cfg.notifyThreshold, unnotifiedOnly: true });
      const sent: string[] = [];
      for (const c of ready) {
        await notifier.send(c);
        sent.push(c.id);
      }
      if (sent.length) {
        store.markNotified(sent);
        console.log(`[radar] notified ${sent.length} candidate(s) over ${cfg.notifyThreshold}`);
      }
      store.setState('score.lastRun', String(Date.now()));
    } catch (e) {
      console.error(`[radar] score tick error: ${(e as Error).message}`);
    } finally {
      scoring = false;
    }
  }

  // Kick an ingest immediately (don't wait a full interval for the first items), then arm both timers.
  void runIngest();
  const ingestTimer = setInterval(() => void runIngest(), cfg.ingestIntervalSec * 1000);
  const scoreTimer = setInterval(() => void runScore(), cfg.scoreIntervalSec * 1000);

  let closed = false;
  return {
    store,
    stop() {
      if (closed) return; // idempotent — SIGINT then SIGTERM, or a double call, is harmless.
      closed = true;
      stopped = true;
      clearInterval(ingestTimer);
      clearInterval(scoreTimer);
      try {
        store.close();
      } catch {
        /* already closed — nothing to do */
      }
      console.log('[radar] stopped.');
    },
  };
}

// --- CLI entry ----------------------------------------------------------------------------------
// Run directly (`npm run radar` / `tsx radar/radar.ts`) → boot the daemon and wire clean shutdown. The
// import.meta.url ↔ argv[1] check keeps this inert when the module is merely imported (e.g. by a test).
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const handle = startRadar();
  const shutdown = (sig: string): void => {
    console.log(`\n[radar] ${sig} → shutting down…`);
    handle.stop(); // stop() closes the store, so nothing further to do.
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
