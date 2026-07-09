// News Radar — shared contract. Every radar unit (sources, store, funnel, judge, notify, the daemon)
// depends ONLY on the interfaces here, so each can be built + tested in isolation. See the design at
// docs/superpowers/specs/2026-07-09-news-radar-design.md.

/** A normalized news item as returned by a source adapter (before any dedupe/scoring/storage). */
export interface RawItem {
  /** Canonical article link — primary dedupe key. */
  url: string;
  title: string;
  /** Adapter/source id, e.g. "gdelt" | "reuters" | "ani" | "newsdata". */
  source: string;
  /** Epoch ms we first saw it (the adapter stamps this; the store keeps the earliest). */
  seenAt: number;
  /** Epoch ms the feed says it was published, if available. */
  publishedAt?: number;
  lang?: string;
  /** ISO country code from GDELT (`sourcecountry`), used by the funnel's India lane. */
  sourceCountry?: string;
  /** GDELT tone (negative = conflict/crisis), if available. */
  tone?: number;
  /** A thumbnail / social image URL, if the feed provides one. */
  image?: string;
  summary?: string;
}

/** Pipeline stage a stored item is in. */
export type ItemStage = 'new' | 'finalist' | 'candidate' | 'dismissed' | 'built';

/** Which relevance lane the funnel matched (or null = below floor / dropped). */
export type Lane = 'india' | 'viral' | null;

/** A stored item = a RawItem + funnel/lifecycle fields. `id` is the content hash (see hashItem). */
export interface StoredItem extends RawItem {
  id: string;
  stage: ItemStage;
  heuristicScore: number;
  reasons: string[];
  lane: Lane;
  /** How many distinct sources referenced the same event in the recent window (crisis-spike signal). */
  clusterSize?: number;
}

/** Stage-1 funnel output for one item. Pure function of the item + config. */
export interface FunnelResult {
  score: number;
  reasons: string[];
  lane: Lane;
}

/** Stage-2 judge output for one finalist (from claude -p). */
export interface CandidateJudgment {
  id: string;
  /** Overall 0-100 opportunity score used for ranking + the notify threshold. */
  aiScore: number;
  indiaFit: number;     // 0-100
  virality: number;     // 0-100
  producible: boolean;  // can we realistically build a good reel from this?
  whyIndia: string;     // one line: why it matters to an India audience
  angle: string;        // one-line brief the pipeline can consume directly
  notes?: string;
}

/** A judged, shortlist-ready candidate = the stored item + its judgment + notify/job tracking. */
export interface Candidate extends StoredItem {
  aiScore: number;
  indiaFit: number;
  virality: number;
  producible: boolean;
  whyIndia: string;
  angle: string;
  notes?: string;
  judgedAt: number;
  notifiedAt?: number;
  /** Studio job id once the operator approves + a build starts. */
  jobId?: string;
}

/** The only stateful unit. SQLite-backed; all dedupe + idempotency live here. */
export interface RadarStore {
  /** Insert/merge items (dedupe by url, else title-hash); keeps the earliest seenAt. Returns # new. */
  upsertItems(items: RawItem[]): number;
  /** Items still at stage "new" (need funnel scoring), newest first, capped by `limit`. */
  unscoredItems(limit: number): StoredItem[];
  /** Persist funnel scores; items in `finalistIds` move to stage "finalist", the rest stay/drop per floor. */
  applyFunnel(scored: Array<{ id: string; result: FunnelResult }>, finalistIds: string[]): void;
  /** Current finalists awaiting judging (stage "finalist"). */
  finalists(limit: number): StoredItem[];
  /** Persist judgments → stage "candidate". */
  writeCandidates(judgments: CandidateJudgment[]): void;
  /** Ranked candidates for the studio inbox / notifier (by aiScore desc), optionally only un-notified. */
  shortlist(opts?: { limit?: number; minScore?: number; unnotifiedOnly?: boolean }): Candidate[];
  markNotified(ids: string[]): void;
  dismiss(id: string): void;
  attachJob(id: string, jobId: string): void;
  /** How many same-event items exist in the recent window (for the funnel's crisis spike). */
  clusterSize(item: RawItem, windowMs: number): number;
  /** Read/write per-source cursors + loop heartbeats. */
  getState(key: string): string | undefined;
  setState(key: string, value: string): void;
  /** Delete items older than `maxAgeMs` (housekeeping). Returns # pruned. */
  prune(maxAgeMs: number): number;
  close(): void;
}

/** A feed adapter: pure I/O, no AI, no store access, no shared state. A throw is caught by the caller. */
export interface SourceAdapter {
  /** Stable id, e.g. "gdelt". */
  readonly id: string;
  /** Fetch the latest items for this source given its config slice. */
  fetchItems(cfg: SourceConfigSlice): Promise<RawItem[]>;
}

/** A candidate notifier (Telegram / desktop / studio-badge). */
export interface Notifier {
  readonly id: string;
  send(candidate: Candidate): Promise<void>;
}

// --- configuration (radar.config.json — data, not code) -----------------------------------------

export interface RssFeed { id: string; url: string; sourceWeightKey?: string }

export interface SourceConfigSlice {
  enabled: boolean;
  // gdelt
  queries?: string[];
  // rss
  feeds?: RssFeed[];
  // newsdata
  dailyBudget?: number;
  params?: Record<string, string>;
}

export interface RadarConfig {
  ingestIntervalSec: number;
  scoreIntervalSec: number;
  finalistCount: number;
  notifyThreshold: number;
  /** Drop items whose heuristic score is below this floor (logged as a count). */
  scoreFloor: number;
  /** Housekeeping: prune items older than this many hours. */
  pruneOlderThanHours: number;
  /** Crisis-spike clustering window (minutes). */
  clusterWindowMin: number;
  sources: {
    gdelt: SourceConfigSlice;
    rss: SourceConfigSlice;
    newsdata: SourceConfigSlice;
    osint: SourceConfigSlice;
  };
  lexicons: { india: string[]; viral: string[]; crisis: string[] };
  weights: { recency: number; source: number; india: number; viral: number; crisisSpike: number };
  sourceWeights: Record<string, number>;
  notify: { channel: 'telegram' | 'desktop' | 'studioBadge' | 'none' };
}
