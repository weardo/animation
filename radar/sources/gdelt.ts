// GDELT DOC 2.0 source adapter — the free, keyless firehose (https://api.gdeltproject.org/api/v2/doc/doc).
// One SourceAdapter that runs every configured query against the ArtList mode, merges the results, and
// dedupes by canonical url. GDELT is generous but flaky: on rate-limit it returns an HTML/empty body with
// a 200, so we parse defensively PER QUERY and never let one bad response sink the whole adapter — a caller
// loop only ever sees the items we managed to parse (or a throw if the network itself is down, which the
// daemon catches + logs per-source). Pure I/O: no store, no AI, no shared state.
import { canonicalUrl } from '../hash.js';
import type { RawItem, SourceAdapter, SourceConfigSlice } from '../types.js';

const ENDPOINT = 'https://api.gdeltproject.org/api/v2/doc/doc';

// The exact ArtList knobs we rely on: ArtList mode + JSON, the freshest 45 minutes (the ingest loop runs
// far more often than that, so we oversample for safety), newest-first, capped at 75 rows per query.
const QUERY_PARAMS: Record<string, string> = {
  mode: 'ArtList',
  format: 'json',
  maxrecords: '75',
  sort: 'DateDesc',
  timespan: '45min',
};

// Small courtesy gap between queries so a burst of 4+ requests doesn't trip GDELT's rate limiter.
// GDELT hard-throttles to ONE request per 5 seconds (a 200 + HTML "please limit requests" body when
// exceeded). Space queries just over that so every query returns JSON instead of the throttle notice.
const INTER_QUERY_DELAY_MS = 6000;

/** One row of GDELT's ArtList JSON. Every field is best-effort — GDELT omits/renames them freely. */
interface GdeltArticle {
  url?: string;
  title?: string;
  domain?: string;
  seendate?: string;       // e.g. "20260709T143000Z" (also seen bare as "20260709143000")
  sourcecountry?: string;  // ISO country name/code → RawItem.sourceCountry (funnel's India lane)
  socialimage?: string;    // thumbnail → RawItem.image
  language?: string;       // → RawItem.lang
  // tone is NOT in ArtList by default (needs ToneChart/GKG) → we always leave RawItem.tone undefined.
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Parse a GDELT seendate ("YYYYMMDDHHMMSS", with or without the T…Z decoration) to epoch ms (UTC).
 * Returns undefined for anything we can't make 14 digits of, so a garbled stamp just drops publishedAt
 * rather than poisoning the item.
 */
export function parseSeenDate(raw?: string): number | undefined {
  if (!raw) return undefined;
  const d = raw.replace(/\D/g, ''); // strip the "T" and "Z" if present → bare digits
  if (d.length < 14) return undefined;
  const yyyy = d.slice(0, 4);
  const mm = d.slice(4, 6);
  const dd = d.slice(6, 8);
  const hh = d.slice(8, 10);
  const mi = d.slice(10, 12);
  const ss = d.slice(12, 14);
  const ms = Date.parse(`${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/** Map one GDELT row → RawItem. Returns null if there's no url to key/dedupe on (a useless row). */
function toRawItem(a: GdeltArticle, seenAt: number): RawItem | null {
  const url = (a.url ?? '').trim();
  if (!url) return null;
  const item: RawItem = {
    url,
    title: (a.title ?? '').trim(),
    source: 'gdelt',
    seenAt,
  };
  const publishedAt = parseSeenDate(a.seendate);
  if (publishedAt !== undefined) item.publishedAt = publishedAt;
  if (a.sourcecountry) item.sourceCountry = a.sourcecountry;
  if (a.socialimage) item.image = a.socialimage;
  if (a.language) item.lang = a.language;
  // a.tone intentionally not mapped — ArtList doesn't carry it (see GdeltArticle note).
  return item;
}

/**
 * Fetch + parse ONE query. Isolated so a rate-limited/HTML response (GDELT returns 200 + non-JSON when
 * throttled) degrades to `[]` for that query instead of throwing. Genuine network failures still reject —
 * but we swallow them here too, because losing one of several queries shouldn't blank the adapter; the
 * merge below still returns whatever the other queries produced.
 */
async function fetchQuery(query: string, seenAt: number): Promise<RawItem[]> {
  const params = new URLSearchParams({ ...QUERY_PARAMS, query });
  let res: Response;
  try {
    res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: { accept: 'application/json' },
    });
  } catch {
    return []; // network hiccup on a single query — let the others carry the batch.
  }
  if (!res.ok) return []; // 429/5xx → skip this query's slice.

  // GDELT signals a rate-limit with a text/HTML body (still 200), so we read as text and JSON.parse
  // ourselves rather than res.json() (which would throw on the HTML).
  let body: string;
  try {
    body = await res.text();
  } catch {
    return [];
  }
  const trimmed = body.trim();
  if (!trimmed || trimmed[0] !== '{') return []; // empty or "You have exceeded…" HTML → nothing usable.

  let parsed: { articles?: GdeltArticle[] };
  try {
    parsed = JSON.parse(trimmed) as { articles?: GdeltArticle[] };
  } catch {
    return []; // malformed JSON → drop this query only.
  }
  const articles = Array.isArray(parsed.articles) ? parsed.articles : [];
  const items: RawItem[] = [];
  for (const a of articles) {
    const item = toRawItem(a, seenAt);
    if (item) items.push(item);
  }
  return items;
}

/**
 * The GDELT adapter. Runs each configured query in sequence (with a small delay between them), merges the
 * rows, and dedupes by CANONICAL url (the same key the store uses) so the same article surfaced by two
 * queries collapses to one — keeping the first-seen copy.
 */
export const gdeltAdapter: SourceAdapter = {
  id: 'gdelt',

  async fetchItems(cfg: SourceConfigSlice): Promise<RawItem[]> {
    if (!cfg.enabled) return [];
    const queries = (cfg.queries ?? []).map((q) => q.trim()).filter(Boolean);
    if (queries.length === 0) return [];

    // One seenAt for the whole batch: every item in this ingest tick shares the moment we pulled it. The
    // store keeps the earliest across ticks, so a stable per-batch stamp is exactly what it wants.
    const seenAt = Date.now();

    const byUrl = new Map<string, RawItem>(); // canonical url → first-seen item (dedupe across queries).
    for (let i = 0; i < queries.length; i++) {
      const items = await fetchQuery(queries[i]!, seenAt);
      for (const item of items) {
        const key = canonicalUrl(item.url);
        if (!byUrl.has(key)) byUrl.set(key, item);
      }
      if (i < queries.length - 1) await delay(INTER_QUERY_DELAY_MS); // space the requests out.
    }
    return [...byUrl.values()];
  },
};
