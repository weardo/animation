// NewsData.io source adapter — the /latest endpoint (free tier). OPTIONAL: no key ⇒ this source is a
// silent no-op (returns []), so the daemon runs fine on GDELT + RSS alone. Pure I/O, no store, no AI.
// The free tier is call-metered, so we self-limit to cfg.dailyBudget calls per calendar day.
import type { RawItem, SourceAdapter, SourceConfigSlice } from '../types.js';

const ENDPOINT = 'https://newsdata.io/api/1/latest';

/** One NewsData result row (only the fields we map; the API returns more). */
interface NewsDataArticle {
  link?: string;
  title?: string;
  description?: string;
  pubDate?: string;
  language?: string;
  country?: string[];
  image_url?: string;
}
interface NewsDataResponse {
  status?: string;
  results?: NewsDataArticle[];
}

// Per-day call counter, keyed by the UTC date STRING (e.g. "2026-07-09"). A module-level map is fine for
// phase 1 — a single long-lived daemon process. Old days are never read again (memory is negligible).
const callsByDay = new Map<string, number>();
const todayKey = (): string => new Date().toISOString().slice(0, 10);

/** NewsData's pubDate is UTC "YYYY-MM-DD HH:mm:ss" → epoch ms; unparseable ⇒ undefined. */
function pubDateToEpoch(pubDate?: string): number | undefined {
  if (!pubDate) return undefined;
  // Normalize the space-separated UTC stamp into an ISO one so parsing is stable across engines.
  const iso = pubDate.includes('T') ? pubDate : pubDate.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

/** Map one API row to a RawItem, or null if it has no usable link. */
function toRawItem(a: NewsDataArticle, seenAt: number): RawItem | null {
  if (!a.link || !a.title) return null;
  const item: RawItem = { url: a.link, title: a.title, source: 'newsdata', seenAt };
  // Only ATTACH optional fields when present — `exactOptionalPropertyTypes` forbids an explicit undefined.
  const publishedAt = pubDateToEpoch(a.pubDate);
  if (publishedAt !== undefined) item.publishedAt = publishedAt;
  if (a.language) item.lang = a.language;
  const country = a.country?.[0]?.toUpperCase();
  if (country) item.sourceCountry = country;
  if (a.image_url) item.image = a.image_url;
  if (a.description) item.summary = a.description;
  return item;
}

export const newsdataSource: SourceAdapter = {
  id: 'newsdata',

  async fetchItems(cfg: SourceConfigSlice): Promise<RawItem[]> {
    // Optional source: no key ⇒ nothing to do (do NOT throw — the daemon treats this source as absent).
    const apikey = process.env['NEWSDATA_API_KEY'];
    if (!apikey) return [];

    // Budget guard: stop once we've spent today's allowance (free tier is call-metered). Default budget
    // guards against a misconfigured slice with no dailyBudget set.
    const budget = cfg.dailyBudget ?? 0;
    const day = todayKey();
    const used = callsByDay.get(day) ?? 0;
    if (budget > 0 && used >= budget) {
      console.warn(`[newsdata] daily budget reached (${used}/${budget} calls on ${day}) — skipping`);
      return [];
    }

    // Build the query: apikey + whatever the config slice passes verbatim (country, language, …).
    const params = new URLSearchParams({ apikey, ...(cfg.params ?? {}) });
    callsByDay.set(day, used + 1); // count the call BEFORE awaiting so a mid-flight retry can't overspend

    const res = await fetch(`${ENDPOINT}?${params.toString()}`);
    // A real HTTP error IS an error — throw so the daemon logs it per-source (it won't crash the loop).
    if (!res.ok) throw new Error(`[newsdata] HTTP ${res.status} ${res.statusText}`);

    const body = (await res.json()) as NewsDataResponse;
    const seenAt = Date.now();
    return (body.results ?? [])
      .map((a) => toRawItem(a, seenAt))
      .filter((it): it is RawItem => it !== null);
  },
};
