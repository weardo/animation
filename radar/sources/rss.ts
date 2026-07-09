// RSS source adapter — polls cfg.feeds (RssFeed[]) and maps each feed item to a RawItem. Pure I/O:
// no AI, no store access, no shared state (SourceAdapter contract). We fetch the XML ourselves with the
// Node 23 built-in `fetch` (a real User-Agent + a hard timeout — many news feeds 403 or hang a bare
// client), then hand the body to rss-parser's parseString. Feeds are fetched CONCURRENTLY but capped so
// we never open 9+ sockets at once; a single feed that errors is SKIPPED (collected as a warning) and
// never sinks the whole batch — the adapter only throws if EVERY feed failed (a real, caller-visible error).
import Parser from 'rss-parser';

import { canonicalUrl } from '../hash.js';
import type { RawItem, RssFeed, SourceConfigSlice, SourceAdapter } from '../types.js';

/** Max feeds in flight at once — keeps us to a handful of sockets regardless of how long cfg.feeds grows. */
const CONCURRENCY = 5;
/** Per-feed fetch timeout (ms). A wedged feed must not stall the whole poll. */
const FETCH_TIMEOUT_MS = 15_000;
/** Some feeds return a UA-sniffing 403 to unknown clients; look like a normal reader. */
const USER_AGENT = 'Mozilla/5.0 (compatible; NewsRadar/1.0; +radar)';

// U = {[key:string]:any} (rss-parser default) so arbitrary namespaced fields (media:*) index cleanly.
const parser = new Parser();

/** ISO date / RFC-822 pubDate → epoch ms, or undefined if neither parses. */
function toEpochMs(isoDate?: string, pubDate?: string): number | undefined {
  const raw = isoDate ?? pubDate;
  if (!raw) return undefined;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

/** Best-effort thumbnail: RSS <enclosure> (image type), else a media:* namespaced field. */
function pickImage(item: Record<string, unknown> & Parser.Item): string | undefined {
  const enc = item.enclosure;
  if (enc?.url && (enc.type === undefined || enc.type.startsWith('image'))) return enc.url;
  // media:content / media:thumbnail land as loose keys on the item (U is an index type).
  for (const key of ['media:content', 'media:thumbnail', 'mediaContent', 'mediaThumbnail']) {
    const m = item[key] as { $?: { url?: string }; url?: string } | undefined;
    const url = m?.$?.url ?? m?.url;
    if (typeof url === 'string' && url) return url;
  }
  return undefined;
}

/** Map one parsed feed item → RawItem. Returns null if it has no usable link/title (can't dedupe it). */
function toRawItem(item: Parser.Item, feed: RssFeed, seenAt: number): RawItem | null {
  const url = item.link?.trim();
  const title = item.title?.trim();
  if (!url || !title) return null;
  const raw: RawItem = {
    url,
    title,
    source: feed.sourceWeightKey ?? feed.id,
    seenAt,
    publishedAt: toEpochMs(item.isoDate, item.pubDate),
    summary: item.contentSnippet,
    image: pickImage(item as Record<string, unknown> & Parser.Item),
  };
  return raw;
}

/** Fetch + parse one feed into RawItems. Throws on network / parse error (the pool records it as a warning). */
async function fetchFeed(feed: RssFeed): Promise<RawItem[]> {
  const seenAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const parsed = await parser.parseString(xml);
    const items: RawItem[] = [];
    for (const it of parsed.items) {
      const raw = toRawItem(it, feed, seenAt);
      if (raw) items.push(raw);
    }
    return items;
  } finally {
    clearTimeout(timer);
  }
}

/** Run `tasks` with at most `limit` in flight; settle all so one rejection never cancels the rest. */
async function pool<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<Array<PromiseSettledResult<T>>> {
  const results: Array<PromiseSettledResult<T>> = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]!().then(
        (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
        (reason): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
      );
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

export const rssAdapter: SourceAdapter = {
  id: 'rss',
  async fetchItems(cfg: SourceConfigSlice): Promise<RawItem[]> {
    const feeds = cfg.feeds ?? [];
    if (!cfg.enabled || feeds.length === 0) return [];

    const settled = await pool(
      feeds.map((feed) => () => fetchFeed(feed)),
      CONCURRENCY,
    );

    // Merge successes; url-dedupe (canonical) so the same story from two feeds collapses. Collect warnings.
    const byUrl = new Map<string, RawItem>();
    const warnings: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === 'rejected') {
        const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
        warnings.push(`${feeds[i]!.id}: ${msg}`);
        return;
      }
      for (const item of r.value) {
        const key = canonicalUrl(item.url);
        if (!byUrl.has(key)) byUrl.set(key, item);
      }
    });

    if (warnings.length > 0) {
      // Non-fatal per-feed failures: surface for the daemon's per-source log without failing the adapter.
      console.warn(`[rss] ${warnings.length}/${feeds.length} feed(s) failed: ${warnings.join('; ')}`);
    }
    // Only a TOTAL wipe-out is a real error worth throwing (nothing to ingest, likely a network outage).
    if (warnings.length === feeds.length) {
      throw new Error(`[rss] all ${feeds.length} feeds failed: ${warnings.join('; ')}`);
    }

    return [...byUrl.values()];
  },
};
