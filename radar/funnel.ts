// News Radar — Stage-1 funnel. A cheap, PURE heuristic scorer that runs on every fresh item before we
// ever spend a `claude -p` judging call (Stage-2). No I/O, no store, no AI — a deterministic function of
// the item + config (+ the store-computed clusterSize passed in), so it's trivially unit-testable and the
// daemon can score thousands of items per tick. It answers one question: is this item worth judging?
import type { FunnelResult, Lane, RadarConfig, RawItem, StoredItem } from './types.js';

/** Default weight for a source the config doesn't list (mid-trust: neither promoted nor penalized). */
const DEFAULT_SOURCE_WEIGHT = 0.6;
/** Recency half-life: an item this old (ms) scores 0.5 on the recency signal, then decays exponentially. */
const RECENCY_HALF_LIFE_MS = 6 * 60 * 60 * 1000; // 6h — a news cycle; older items fade fast.

/** Count how many lexicon terms appear in `text` (substring match, so multi-word phrases work). Pure. */
export function matchLexicon(text: string, terms: string[]): number {
  let n = 0;
  for (const term of terms) if (text.includes(term)) n += 1;
  return n;
}

/** Exponential recency decay in [0,1]: 1 at age 0, 0.5 at one half-life, →0 as it ages. Clamped ≥0. */
export function recencyScore(ageMs: number, halfLifeMs: number = RECENCY_HALF_LIFE_MS): number {
  if (ageMs <= 0) return 1; // future/just-seen → freshest
  return Math.exp(-Math.LN2 * (ageMs / halfLifeMs));
}

/** The searchable haystack for lexicon lanes: title + summary, lowercased once. Pure. */
export function itemText(item: Pick<RawItem, 'title' | 'summary'>): string {
  return `${item.title} ${item.summary ?? ''}`.toLowerCase();
}

/**
 * Score one item. Combines five signals via cfg.weights into a single number + human `reasons[]`:
 *   score = w.recency·recency + w.source·sourceWeight + w.india·indiaSignal
 *         + w.viral·viralSignal + w.crisisSpike·crisisSignal
 * where indiaSignal = india-lexicon hits (+1 if sourceCountry==='IN'), viralSignal = viral-lexicon hits,
 * and crisisSignal = crisis-lexicon hits · (1 + log2(1+clusterSize))  + negative-GDELT-tone bonus.
 * `clusterSize` (how many distinct sources hit the same event) is computed by the store and passed in —
 * the funnel stays pure. Lane = india if the india signal dominates, else viral if any, else null.
 */
export function scoreItem(item: StoredItem | RawItem, cfg: RadarConfig, clusterSize: number): FunnelResult {
  const w = cfg.weights;
  const reasons: string[] = [];

  // --- recency: exponential decay on age since publish (fall back to when we first saw it) ---
  const ts = item.publishedAt ?? item.seenAt;
  const ageMs = Date.now() - ts;
  const recency = recencyScore(ageMs);
  const ageHrs = Math.max(0, ageMs) / 3_600_000;
  reasons.push(`recency ${recency.toFixed(2)} (${ageHrs.toFixed(1)}h old)`);

  // --- source weight: trust prior from the config table (unknown source → DEFAULT_SOURCE_WEIGHT) ---
  const sourceWeight = cfg.sourceWeights[item.source] ?? DEFAULT_SOURCE_WEIGHT;
  reasons.push(`source ${item.source} w=${sourceWeight.toFixed(2)}`);

  const text = itemText(item);

  // --- india lane: lexicon hits, plus a bonus if GDELT already tagged the source country as India ---
  const indiaHits = matchLexicon(text, cfg.lexicons.india);
  const isIndiaSource = item.sourceCountry === 'IN';
  const indiaSignal = indiaHits + (isIndiaSource ? 1 : 0);
  if (indiaSignal > 0) {
    reasons.push(`india x${indiaHits}${isIndiaSource ? ' +IN-source' : ''}`);
  }

  // --- viral lane: "goes viral / caught on camera / rescue / record …" lexicon hits ---
  const viralSignal = matchLexicon(text, cfg.lexicons.viral);
  if (viralSignal > 0) reasons.push(`viral x${viralSignal}`);

  // --- crisis spike: crisis-word hits amplified by how many sources cluster on the same event ---
  const crisisHits = matchLexicon(text, cfg.lexicons.crisis);
  const spikeFactor = 1 + Math.log2(1 + Math.max(0, clusterSize)); // 1 source → 1×, more → grows sub-linearly
  let crisisSignal = crisisHits * spikeFactor;
  if (crisisHits > 0) reasons.push(`crisis x${crisisHits} ×${spikeFactor.toFixed(2)} (cluster ${clusterSize})`);
  // Negative GDELT tone (conflict/disaster) reinforces the crisis signal even if few words matched.
  if (typeof item.tone === 'number' && item.tone < 0) {
    const toneBonus = Math.min(3, -item.tone / 5); // tone ~ -10..0 → up to +2 (capped)
    crisisSignal += toneBonus;
    reasons.push(`neg-tone ${item.tone.toFixed(1)} (+${toneBonus.toFixed(2)})`);
  }

  // --- lane: india wins when its signal dominates, else viral if present, else nothing matched ---
  let lane: Lane = null;
  if (indiaSignal > 0 && indiaSignal >= viralSignal) lane = 'india';
  else if (viralSignal > 0) lane = 'viral';

  const score =
    w.recency * recency +
    w.source * sourceWeight +
    w.india * indiaSignal +
    w.viral * viralSignal +
    w.crisisSpike * crisisSignal;

  return { score, reasons, lane };
}

/**
 * Pick the finalists to hand to Stage-2 judging: drop everything below cfg.scoreFloor (returning the
 * dropped count so the daemon can log it), then take the top cfg.finalistCount by score. Pure + stable:
 * ties break by id so the selection is deterministic across ticks.
 */
export function selectFinalists(
  scored: Array<{ id: string; item: StoredItem | RawItem; result: FunnelResult }>,
  cfg: RadarConfig,
): { finalistIds: string[]; dropped: number } {
  const kept = scored.filter((s) => s.result.score >= cfg.scoreFloor);
  const dropped = scored.length - kept.length;
  const finalistIds = kept
    .slice() // don't mutate the caller's array
    .sort((a, b) => b.result.score - a.result.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, cfg.finalistCount)
    .map((s) => s.id);
  return { finalistIds, dropped };
}
