// News Radar — Stage-2 AI judge. The funnel hands us a shortlist of FINALISTS (cheap heuristic winners);
// the judge is the EDITOR that scores each for reel-worthiness via keyless `claude -p`. One BATCHED call
// per run (all uncached finalists in a single prompt → one model round-trip), and every judgment is
// CACHED by item id so a finalist is judged at most ONCE — re-runs replay the fixed file (the run-once /
// replay-fixed determinism pattern the whole factory uses). Never throws out of judgeFinalists: on any
// parse/call failure we return whatever was already cached + nothing for the rest, so the daemon loop
// keeps turning.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { extractJson, PROJECT_ROOT, runClaudeText } from '../agents/claude.js';
import type { CandidateJudgment, RadarConfig, StoredItem } from './types.js';

/** Per-item judgment cache: .cache/radar/judge/<id>.json (skip-if-exists → judged at most once). */
export const JUDGE_CACHE_DIR = resolve(PROJECT_ROOT, '.cache', 'radar', 'judge');

const cachePath = (id: string): string => resolve(JUDGE_CACHE_DIR, `${id}.json`);

/** Clamp + round a model-supplied number into a 0-100 score (tolerates strings / junk → 0). */
function score100(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** Coerce one raw model object into a valid CandidateJudgment, or null if it has no usable id. */
function coerceJudgment(raw: unknown, allowedIds: Set<string>): CandidateJudgment | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o['id'] === 'string' ? o['id'] : '';
  if (!id || !allowedIds.has(id)) return null; // ignore hallucinated / out-of-batch ids
  const j: CandidateJudgment = {
    id,
    aiScore: score100(o['aiScore']),
    indiaFit: score100(o['indiaFit']),
    virality: score100(o['virality']),
    producible: Boolean(o['producible']),
    whyIndia: typeof o['whyIndia'] === 'string' ? o['whyIndia'].trim() : '',
    angle: typeof o['angle'] === 'string' ? o['angle'].trim() : '',
  };
  if (typeof o['notes'] === 'string' && o['notes'].trim()) j.notes = o['notes'].trim();
  return j;
}

/** Read a cached judgment for an id, or null if absent / corrupt (a bad file is simply re-judged). */
function readCached(id: string): CandidateJudgment | null {
  const p = cachePath(id);
  if (!existsSync(p)) return null;
  try {
    return coerceJudgment(JSON.parse(readFileSync(p, 'utf8')), new Set([id]));
  } catch {
    return null;
  }
}

/** Persist a fresh judgment (best-effort; a write failure never breaks the run). */
function writeCache(j: CandidateJudgment): void {
  try {
    writeFileSync(cachePath(j.id), JSON.stringify(j, null, 2));
  } catch {
    /* non-fatal — the judgment is still returned this run, just not memoized */
  }
}

/** The EDITOR system instruction — framing that makes the model score for the Hinglish-reel channel. */
const SYSTEM = [
  'You are the EDITOR of a Hinglish (Hindi + English) news-reel channel that publishes 30-50 second',
  'vertical shorts. Score each news item for: (a) INDIA relevance — a direct India angle, an Indian',
  'subject, or a neighbour (Pakistan/China/Bangladesh…) story that matters to an Indian audience;',
  '(b) VIRAL potential as a fast vertical short — a strong hook, drama, a face/number/place the viewer',
  'feels; (c) PRODUCIBILITY — is there likely real footage, a map, or a clear visual story we can build?',
  'TWO lanes are valid: an item can win by being India-relevant OR by being globally viral (it need not',
  'be both). Penalize generic, hook-less, evergreen, or purely-abstract items (low aiScore).',
  'The "angle" must be a CONCRETE build brief for the reel (the visual/story approach), NOT a restatement',
  'of the headline.',
].join(' ');

/**
 * Judge the finalists: return one CandidateJudgment per item we could score (cached + freshly judged).
 * Cached finalists are served from disk; only UNCACHED ones are sent to claude -p, in a single batched
 * prompt. Any failure (call error, unparseable reply) degrades to "cached-only" — we NEVER throw.
 */
export async function judgeFinalists(
  finalists: StoredItem[],
  cfg: RadarConfig,
): Promise<CandidateJudgment[]> {
  void cfg; // reserved: future per-run editorial tuning (thresholds/lexicons) — kept in the signature.
  mkdirSync(JUDGE_CACHE_DIR, { recursive: true });

  // 1) Split into already-judged (cache hit) vs the batch we must ask the model about.
  const cached: CandidateJudgment[] = [];
  const todo: StoredItem[] = [];
  for (const item of finalists) {
    const hit = readCached(item.id);
    if (hit) cached.push(hit);
    else todo.push(item);
  }
  if (todo.length === 0) return cached;

  // 2) Build ONE compact numbered list (id/title/source/summary/lane) — small tokens, one round-trip.
  const list = todo.map((it, i) => ({
    n: i + 1,
    id: it.id,
    title: it.title,
    source: it.source,
    summary: (it.summary ?? '').slice(0, 400),
    lane: it.lane ?? 'unscored',
  }));

  const prompt = [
    SYSTEM,
    '',
    `Here are ${list.length} finalist news items as a JSON array:`,
    JSON.stringify(list, null, 2),
    '',
    'Return a STRICT JSON array (no prose, no markdown fences) with EXACTLY one object per item, each:',
    '{',
    '  "id": string,           // copy the item id verbatim',
    '  "aiScore": 0-100,       // overall reel opportunity — the ranking score',
    '  "indiaFit": 0-100,      // India relevance / India-angle strength',
    '  "virality": 0-100,      // hook + share potential as a 30-50s vertical short',
    '  "producible": boolean,  // can we realistically build a good reel (footage/map/clear story)?',
    '  "whyIndia": string,     // <= 12 words: why it matters to an India audience',
    '  "angle": string,        // one-line Hinglish-reel build brief (approach, NOT the headline)',
    '  "notes": string         // optional: caveats, missing footage, sensitivity',
    '}',
    'Output ONLY the JSON array.',
  ].join('\n');

  // 3) One batched call → parse defensively → cache each fresh judgment. Failure = cached-only.
  let fresh: CandidateJudgment[] = [];
  try {
    const reply = await runClaudeText(prompt);
    const parsed = extractJson(reply);
    if (Array.isArray(parsed)) {
      const allowed = new Set(todo.map((it) => it.id));
      const byId = new Map<string, CandidateJudgment>();
      for (const raw of parsed) {
        const j = coerceJudgment(raw, allowed);
        if (j && !byId.has(j.id)) byId.set(j.id, j); // first wins; ignore dupes
      }
      fresh = [...byId.values()];
      for (const j of fresh) writeCache(j);
    }
  } catch {
    return cached; // call/parse blew up → hand back only what was already on disk, never throw
  }

  return [...cached, ...fresh];
}
