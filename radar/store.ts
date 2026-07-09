// News Radar — the ONE stateful unit. SQLite (better-sqlite3, synchronous → no await races) is the whole
// truth: every item's lifecycle (new → finalist → candidate → built/dismissed), all dedupe, and the
// per-source cursors / loop heartbeats live here. Sources/funnel/judge/notify are all stateless around it.
// Implements RadarStore from ./types.ts EXACTLY. Date.now() is fine — this is a live service, not a render.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// better-sqlite3 ships no bundled .d.ts and @types/better-sqlite3 isn't a dep here (and Bundler resolution
// treats the module as untyped, so it can't be augmented). We suppress the import and cast the ctor to a
// tiny locally-declared surface covering exactly the calls we make — types only, zero runtime effect.
// @ts-expect-error — untyped module (no @types/better-sqlite3); shimmed by SqliteCtor below.
import DatabaseCtor from 'better-sqlite3';

import { PROJECT_ROOT } from '../agents/claude.js';
import { eventKey, hashItem, normalizeTitle } from './hash.js';
import type {
  Candidate,
  CandidateJudgment,
  FunnelResult,
  RadarStore,
  RawItem,
  StoredItem,
} from './types.js';

// Every column lives on one wide `items` table (a stored item IS a raw item + funnel + judge + tracking
// fields); `state` is a trivial key/value for cursors + heartbeats. Indexed on the three columns the hot
// paths filter by: stage (funnel/judge/shortlist scans), seenAt (unscored ordering + prune), eventKey
// (crisis-spike clustering).
const DDL = `
CREATE TABLE IF NOT EXISTS items (
  id            TEXT PRIMARY KEY,
  url           TEXT,
  title         TEXT,
  source        TEXT,
  seenAt        INTEGER,
  publishedAt   INTEGER,
  lang          TEXT,
  sourceCountry TEXT,
  tone          REAL,
  image         TEXT,
  summary       TEXT,
  stage         TEXT NOT NULL DEFAULT 'new',
  heuristicScore REAL NOT NULL DEFAULT 0,
  reasons       TEXT NOT NULL DEFAULT '[]',
  lane          TEXT,
  eventKey      TEXT,
  aiScore       REAL,
  indiaFit      REAL,
  virality      REAL,
  producible    INTEGER,
  whyIndia      TEXT,
  angle         TEXT,
  notes         TEXT,
  judgedAt      INTEGER,
  notifiedAt    INTEGER,
  jobId         TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_stage    ON items(stage);
CREATE INDEX IF NOT EXISTS idx_items_seenAt   ON items(seenAt);
CREATE INDEX IF NOT EXISTS idx_items_eventKey ON items(eventKey);
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

// The slice of the better-sqlite3 API we touch (see the shim note on the import above).
interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}
interface Stmt {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface Db {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
  pragma(source: string): unknown;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): void;
}
type SqliteCtor = new (filename: string) => Db;

// The raw shape better-sqlite3 hands back (all columns nullable at the driver level). We narrow at the
// mapping boundary so callers only ever see the typed StoredItem/Candidate.
interface ItemRow {
  id: string;
  url: string;
  title: string;
  source: string;
  seenAt: number;
  publishedAt: number | null;
  lang: string | null;
  sourceCountry: string | null;
  tone: number | null;
  image: string | null;
  summary: string | null;
  stage: string;
  heuristicScore: number | null;
  reasons: string | null;
  lane: string | null;
  eventKey: string | null;
  aiScore: number | null;
  indiaFit: number | null;
  virality: number | null;
  producible: number | null;
  whyIndia: string | null;
  angle: string | null;
  notes: string | null;
  judgedAt: number | null;
  notifiedAt: number | null;
  jobId: string | null;
}

function parseReasons(json: string | null): string[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return [];
  }
}

// exactOptionalPropertyTypes: an optional field must be ABSENT, not explicitly `undefined` — so we only
// attach the nullable columns when the DB actually held a value.
function rowToStored(r: ItemRow): StoredItem {
  const s: StoredItem = {
    id: r.id,
    url: r.url,
    title: r.title,
    source: r.source,
    seenAt: r.seenAt,
    stage: r.stage as StoredItem['stage'],
    heuristicScore: r.heuristicScore ?? 0,
    reasons: parseReasons(r.reasons),
    lane: (r.lane as StoredItem['lane']) ?? null,
  };
  if (r.publishedAt !== null) s.publishedAt = r.publishedAt;
  if (r.lang !== null) s.lang = r.lang;
  if (r.sourceCountry !== null) s.sourceCountry = r.sourceCountry;
  if (r.tone !== null) s.tone = r.tone;
  if (r.image !== null) s.image = r.image;
  if (r.summary !== null) s.summary = r.summary;
  return s;
}

function rowToCandidate(r: ItemRow): Candidate {
  const c: Candidate = {
    ...rowToStored(r),
    aiScore: r.aiScore ?? 0,
    indiaFit: r.indiaFit ?? 0,
    virality: r.virality ?? 0,
    producible: !!r.producible,
    whyIndia: r.whyIndia ?? '',
    angle: r.angle ?? '',
    judgedAt: r.judgedAt ?? 0,
  };
  if (r.notes !== null) c.notes = r.notes;
  if (r.notifiedAt !== null) c.notifiedAt = r.notifiedAt;
  if (r.jobId !== null) c.jobId = r.jobId;
  return c;
}

class SqliteRadarStore implements RadarStore {
  private readonly db: Db;

  constructor(dbPath: string) {
    this.db = new (DatabaseCtor as SqliteCtor)(dbPath);
    // WAL + a busy timeout: the daemon writes (ingest/score loops) while the studio/notifier reads, and
    // better-sqlite3 is synchronous per-connection but multiple processes share the file.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(DDL);
  }

  // --- ingest ----------------------------------------------------------------------------------

  upsertItems(items: RawItem[]): number {
    // id = hashItem (canonical-url hash, else normalized-title hash) → INSERT OR IGNORE keeps the FIRST
    // (= earliest-seen) row for a given id. Within the batch we ALSO drop later items whose normalized
    // title we've already taken, so two different URLs reporting the same headline collapse to one.
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO items
        (id, url, title, source, seenAt, publishedAt, lang, sourceCountry, tone, image, summary,
         stage, heuristicScore, reasons, lane, eventKey)
      VALUES
        (@id, @url, @title, @source, @seenAt, @publishedAt, @lang, @sourceCountry, @tone, @image,
         @summary, 'new', 0, '[]', NULL, @eventKey)
    `);
    const run = this.db.transaction((batch: RawItem[]) => {
      const seenIds = new Set<string>();
      const seenTitles = new Set<string>();
      let inserted = 0;
      for (const it of batch) {
        const id = hashItem(it);
        const tkey = normalizeTitle(it.title);
        if (seenIds.has(id) || (tkey && seenTitles.has(tkey))) continue; // in-batch dedupe
        seenIds.add(id);
        if (tkey) seenTitles.add(tkey);
        const info = insert.run({
          id,
          url: it.url,
          title: it.title,
          source: it.source,
          seenAt: it.seenAt,
          publishedAt: it.publishedAt ?? null,
          lang: it.lang ?? null,
          sourceCountry: it.sourceCountry ?? null,
          tone: it.tone ?? null,
          image: it.image ?? null,
          summary: it.summary ?? null,
          eventKey: eventKey(it.title),
        });
        inserted += info.changes; // 0 when an existing id was ignored (keeps earliest seenAt)
      }
      return inserted;
    });
    return run(items);
  }

  // --- funnel (stage 1) ------------------------------------------------------------------------

  unscoredItems(limit: number): StoredItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE stage = 'new' ORDER BY seenAt DESC LIMIT ?`)
      .all(limit) as ItemRow[];
    return rows.map(rowToStored);
  }

  applyFunnel(scored: Array<{ id: string; result: FunnelResult }>, finalistIds: string[]): void {
    // Persist the funnel verdict for every scored item, then promote the caller-chosen finalists. The
    // floor decision is the caller's: whatever it did NOT list as a finalist is dropped here (stage
    // 'dismissed') so it leaves the 'new' pool and isn't re-scored forever. Only 'new' rows transition,
    // so re-running a score pass never clobbers already-judged items.
    const finalists = new Set(finalistIds);
    const score = this.db.prepare(
      `UPDATE items SET heuristicScore = @score, reasons = @reasons, lane = @lane WHERE id = @id AND stage = 'new'`,
    );
    const promote = this.db.prepare(`UPDATE items SET stage = 'finalist' WHERE id = ? AND stage = 'new'`);
    const drop = this.db.prepare(`UPDATE items SET stage = 'dismissed' WHERE id = ? AND stage = 'new'`);
    const run = this.db.transaction((rows: typeof scored) => {
      for (const { id, result } of rows) {
        score.run({ id, score: result.score, reasons: JSON.stringify(result.reasons), lane: result.lane });
        if (finalists.has(id)) promote.run(id);
        else drop.run(id);
      }
    });
    run(scored);
  }

  finalists(limit: number): StoredItem[] {
    const rows = this.db
      .prepare(`SELECT * FROM items WHERE stage = 'finalist' ORDER BY heuristicScore DESC LIMIT ?`)
      .all(limit) as ItemRow[];
    return rows.map(rowToStored);
  }

  // --- judge (stage 2) -------------------------------------------------------------------------

  writeCandidates(judgments: CandidateJudgment[]): void {
    const now = Date.now();
    const upd = this.db.prepare(`
      UPDATE items SET
        aiScore = @aiScore, indiaFit = @indiaFit, virality = @virality, producible = @producible,
        whyIndia = @whyIndia, angle = @angle, notes = @notes, judgedAt = @judgedAt, stage = 'candidate'
      WHERE id = @id
    `);
    const run = this.db.transaction((js: CandidateJudgment[]) => {
      for (const j of js) {
        upd.run({
          id: j.id,
          aiScore: j.aiScore,
          indiaFit: j.indiaFit,
          virality: j.virality,
          producible: j.producible ? 1 : 0,
          whyIndia: j.whyIndia,
          angle: j.angle,
          notes: j.notes ?? null,
          judgedAt: now,
        });
      }
    });
    run(judgments);
  }

  // --- shortlist / studio inbox ----------------------------------------------------------------

  shortlist(opts?: { limit?: number; minScore?: number; unnotifiedOnly?: boolean }): Candidate[] {
    const where = [`stage IN ('candidate', 'built')`];
    const params: unknown[] = [];
    if (opts?.minScore !== undefined) {
      where.push(`aiScore >= ?`);
      params.push(opts.minScore);
    }
    if (opts?.unnotifiedOnly) where.push(`notifiedAt IS NULL`);
    let sql = `SELECT * FROM items WHERE ${where.join(' AND ')} ORDER BY aiScore DESC`;
    if (opts?.limit !== undefined) {
      sql += ` LIMIT ?`;
      params.push(opts.limit);
    }
    const rows = this.db.prepare(sql).all(...params) as ItemRow[];
    return rows.map(rowToCandidate);
  }

  markNotified(ids: string[]): void {
    const now = Date.now();
    const upd = this.db.prepare(`UPDATE items SET notifiedAt = ? WHERE id = ?`);
    const run = this.db.transaction((xs: string[]) => {
      for (const id of xs) upd.run(now, id);
    });
    run(ids);
  }

  dismiss(id: string): void {
    this.db.prepare(`UPDATE items SET stage = 'dismissed' WHERE id = ?`).run(id);
  }

  attachJob(id: string, jobId: string): void {
    // Operator approved + a studio build started → pin the job id and move to the terminal 'built' stage.
    this.db.prepare(`UPDATE items SET jobId = ?, stage = 'built' WHERE id = ?`).run(jobId, id);
  }

  // --- clustering / crisis spike ---------------------------------------------------------------

  clusterSize(item: RawItem, windowMs: number): number {
    // How many stored items share this event (coarse title-token key) within ±windowMs of when we saw it.
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM items WHERE eventKey = ? AND ABS(seenAt - ?) <= ?`)
      .get(eventKey(item.title), item.seenAt, windowMs) as { n: number };
    return row.n;
  }

  // --- cursors + heartbeats --------------------------------------------------------------------

  getState(key: string): string | undefined {
    const row = this.db.prepare(`SELECT value FROM state WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  // --- housekeeping ----------------------------------------------------------------------------

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    return this.db.prepare(`DELETE FROM items WHERE seenAt < ?`).run(cutoff).changes;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Open (creating if needed) the radar store at `dbPath`, defaulting to <repoRoot>/.data/radar.db. The
 * parent dir is created on demand so a fresh checkout just works.
 */
export function openStore(dbPath?: string): RadarStore {
  const root = PROJECT_ROOT ?? process.cwd();
  const path = dbPath ?? join(root, '.data', 'radar.db');
  mkdirSync(join(path, '..'), { recursive: true });
  return new SqliteRadarStore(path);
}
