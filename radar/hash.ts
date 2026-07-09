// Content hashing + URL/title normalization for dedupe. Shared by the store (item id + dedupe key) and
// the funnel (event clustering). Pure + deterministic.
import { createHash } from 'node:crypto';

import type { RawItem } from './types.js';

/** Canonicalize a URL for dedupe: lowercase host, strip tracking params + trailing slash + fragment. */
export function canonicalUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    u.hash = '';
    const drop = [/^utm_/i, /^fbclid$/i, /^gclid$/i, /^ref$/i, /^cmpid$/i, /^igshid$/i];
    for (const key of [...u.searchParams.keys()]) {
      if (drop.some((re) => re.test(key))) u.searchParams.delete(key);
    }
    u.host = u.host.toLowerCase().replace(/^www\./, '');
    let s = u.toString();
    s = s.replace(/\/$/, '');
    return s;
  } catch {
    return raw.trim();
  }
}

/** Normalize a headline for fuzzy dedupe: lowercase, strip punctuation, collapse whitespace. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Item id / dedupe key: hash of the canonical url, falling back to the normalized title. */
export function hashItem(item: Pick<RawItem, 'url' | 'title'>): string {
  const url = item.url ? canonicalUrl(item.url) : '';
  const key = url || normalizeTitle(item.title);
  return createHash('sha256').update(key).digest('hex').slice(0, 16);
}

/** A coarse event key for clustering (normalized title's first ~8 significant tokens). */
export function eventKey(title: string): string {
  const toks = normalizeTitle(title)
    .split(' ')
    .filter((t) => t.length > 3)
    .slice(0, 8);
  return createHash('sha256').update(toks.join(' ')).digest('hex').slice(0, 12);
}
