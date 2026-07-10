// Joke-preservation critic — the STRUCTURAL guard against AI's explain-everything reflex (the architect
// prompt reduces it but AI drifts back to lecturing). After the architect + humour, this reviews the story:
// for a SERIOUS reel it changes nothing; for a LIGHT / VIRAL / MEME / GAFFE reel it CUTS a joke-killing beat
// (a "here's why it's technically wrong / actually X is Y" correction, a dissection, an over-explanation) or
// REWRITES its narration to be punchy & in-on-the-joke — riding the shared/meme context instead of spelling
// it out. Never fabricates facts (rewrites are tighter versions of what's there). Cached content-addressed
// (run-once → deterministic replay); any failure → the story unchanged (never worse, never fails the build).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT, runClaudeText, extractJson } from './claude.js';

/** Bump when the prompt changes → invalidates the cache. */
const PROMPT_VERSION = 'joke-critic@1';
const MAX_CUTS = 2; // never gut a reel — cut at most 2 beats

interface Edit {
  beatId: string;
  action: 'keep' | 'cut' | 'rewrite';
  say?: string;
}

export interface JokeCriticResult {
  register: string;
  cut: number;
  rewritten: number;
}

function digest(story: StoryIR): Array<{ id: string; say: string; text: string }> {
  return story.beats.map((b, i) => {
    const t = (b.show ?? []).find((s) => typeof (s as { text?: unknown }).text === 'string') as { text?: string } | undefined;
    return { id: b.id ?? `beat-${i}`, say: b.say ?? '', text: t?.text ?? '' };
  });
}

function prompt(beats: ReturnType<typeof digest>): string {
  return `You are the FINAL EDITOR of a punchy news-reel channel, protecting the reel from over-explanation.
Read the beats. FIRST decide the register:
- SERIOUS (an attack, a policy, a crisis, a tragedy) → return every beat "keep". Change NOTHING.
- LIGHT / VIRAL / MEME / GAFFE (a slip, an absurd viral clip, an internet-meme moment) → protect the joke:
  • A beat that OVER-EXPLAINS, DISSECTS why it's funny/wrong, or is a "here's why it's technically wrong /
    actually X is Y / the difference is…" CORRECTION or fact-check → CUT it (that single beat kills the reel;
    the audience is already in on it). Prefer to CUT a pure correction/dissection beat.
  • A beat that is fine but wordy/lecture-y → REWRITE its narration ("say") to be punchy, deadpan, in-on-the-
    joke, riding the shared/meme context (keep it in the SAME language as the original say; keep any real
    numbers/names; just cut the explaining). Do NOT invent facts.
  • A beat that already lands → keep.
Cut AT MOST ${MAX_CUTS} beats. Never cut the hook or the final beat. Output ONLY JSON.

BEATS:
${beats.map((b) => `- ${b.id}: say="${b.say}" | headline="${b.text}"`).join('\n')}

Return {"register":"serious|light","edits":[{"beatId":"","action":"keep|cut|rewrite","say":"<only when rewrite>"}]}`;
}

/** Tighten a LIGHT reel in place (cut/rewrite joke-killing beats). Best-effort; never throws. */
export async function protectJoke(story: StoryIR, opts: { rootDir?: string } = {}): Promise<JokeCriticResult> {
  const rootDir = opts.rootDir ?? PROJECT_ROOT;
  const beats = digest(story);
  const cacheDir = resolve(rootDir, '.cache/agents/joke-critic');
  const key = createHash('sha256').update(PROMPT_VERSION + '\n' + JSON.stringify(beats)).digest('hex').slice(0, 16);
  const cacheFile = resolve(cacheDir, `${key}.json`);

  let plan: { register: string; edits: Edit[] };
  if (existsSync(cacheFile)) {
    plan = JSON.parse(readFileSync(cacheFile, 'utf8')) as { register: string; edits: Edit[] };
  } else {
    try {
      const raw = extractJson(await runClaudeText(prompt(beats))) as { register?: string; edits?: Edit[] };
      plan = { register: raw.register ?? 'serious', edits: Array.isArray(raw.edits) ? raw.edits : [] };
    } catch {
      plan = { register: 'serious', edits: [] };
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(plan, null, 2) + '\n', 'utf8');
  }

  if (plan.register !== 'light') return { register: plan.register, cut: 0, rewritten: 0 };

  const firstId = beats[0]?.id;
  const lastId = beats[beats.length - 1]?.id;
  const cutIds = new Set(
    plan.edits
      .filter((e) => e.action === 'cut' && e.beatId !== firstId && e.beatId !== lastId)
      .slice(0, MAX_CUTS)
      .map((e) => e.beatId),
  );
  let rewritten = 0;
  for (const e of plan.edits) {
    if (e.action === 'rewrite' && typeof e.say === 'string' && e.say.trim()) {
      const beat = story.beats.find((b) => (b.id ?? '') === e.beatId);
      if (beat && beat.say && !cutIds.has(e.beatId)) {
        beat.say = e.say.trim();
        rewritten += 1;
      }
    }
  }
  if (cutIds.size > 0) story.beats = story.beats.filter((b) => !cutIds.has(b.id ?? ''));
  return { register: plan.register, cut: cutIds.size, rewritten };
}
