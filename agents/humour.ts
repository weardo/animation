// Humour engine — adds SPARSE, well-calibrated humour to a reel WITHOUT the AI writing jokes from scratch
// (LLMs are bad at that: formulaic, weak timing, weak cultural grounding). Instead, following the 2026
// research (HumorPlanSearch's plan→retrieve→judge loop; comedians use LLMs for SETUPS not punchlines), the
// funny lives in a CURATED KIT (library/comedy/*.json) + an automated JUDGE, and the AI only ARRANGES it:
//   1. TONE GATE   — grim/victim/tragedy beats are excluded before anything runs (hard rule).
//   2. HUMOR-CoT   — for eligible beats, `claude -p` reasons the incongruity, picks a kit DEVICE, drafts
//                    a few candidate touches (a wry Hinglish aside, or an ironic ENGLISH headline).
//   3. JUDGE       — a SEPARATE `claude -p` pass scores each (funny? on-tone? cringe? punches up not down?)
//                    and keeps at most 2, REJECT-BIASED — or rejects all. This is the taste filter that
//                    makes fully-automatic mode safe (no human approval).
// Fact-true always; humour rides framing, never invents. Cached content-addressed (run-once → deterministic
// replay). Any failure (no `claude`, bad output) → the reel is just straight; the build never fails.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT, runClaudeText, extractJson } from './claude.js';
import type { FactSheet } from './research.js';

/** Bump when a prompt / the kit contract changes → invalidates the cache. */
const PROMPT_VERSION = 'humour@1';
const MAX_TOUCHES = 2; // hard cap per reel (restraint)

interface ComedyKit {
  name: string;
  version: string;
  persona: string;
  devices: Array<{ id: string; how: string; examples?: string[] }>;
  references: { indian: string[]; universal: string[] };
  toneRules: string[];
  neverJokeAbout: string[];
}

/** One proposed comedic touch. `say` = a Hinglish narration aside (appended); `text` = an ENGLISH ironic headline. */
interface HumourTouch {
  beatId: string;
  surface: 'say' | 'text';
  content: string;
  device: string;
  rationale: string;
}

export interface HumourResult {
  applied: number;
  touches: HumourTouch[];
}

function loadKit(rootDir: string): ComedyKit | null {
  try {
    const p = resolve(rootDir, 'library/comedy/desi-newsroom.json');
    return JSON.parse(readFileSync(p, 'utf8')) as ComedyKit;
  } catch {
    return null;
  }
}

/** The story reduced to what the humour passes need (id + say + on-screen headline), to keep prompts tight. */
function beatDigest(story: StoryIR): Array<{ id: string; say: string; text: string }> {
  return story.beats.map((b, i) => {
    const t = (b.show ?? []).find((s) => typeof (s as { text?: unknown }).text === 'string') as { text?: string } | undefined;
    return { id: b.id ?? `beat-${i}`, say: b.say ?? '', text: t?.text ?? '' };
  });
}

function architectPrompt(kit: ComedyKit, digest: ReturnType<typeof beatDigest>, fact: FactSheet | undefined): string {
  return `You are the HUMOUR WRITER of a wry Indian news channel. Your job is NOT to force jokes — it is to find
where a reel can carry ONE or TWO genuinely funny, deadpan touches, and arrange them from the KIT below. If
nothing genuinely lands, propose FEWER (even zero). Output ONLY strict JSON.

PERSONA: ${kit.persona}

DEVICES (use these forms — the punchline PATTERN, not a fixed joke):
${kit.devices.map((d) => `- ${d.id}: ${d.how}${d.examples ? ` e.g. ${d.examples.join(' / ')}` : ''}`).join('\n')}

REFERENCES you may draw on — Indian: ${kit.references.indian.join(', ')}. Universal: ${kit.references.universal.join(', ')}.

TONE RULES (obey all):
${kit.toneRules.map((r) => `- ${r}`).join('\n')}

⛔ TONE GATE — NEVER add humour to a beat about, or that even touches: ${kit.neverJokeAbout.join('; ')}.
Skip such beats entirely. When in doubt, skip.

SURFACES:
- "say": a SHORT wry aside in HINGLISH, appended to that beat's narration (it also becomes the subtitle).
- "text": an ironic ENGLISH on-screen headline (2-5 words) that replaces that beat's headline.
Favour the HOOK (first beat), ONE ironic mid-setup, and the CLOSE (last beat).

FACTS (stay TRUE to these; humour rides the framing/irony, never invents):
${fact ? JSON.stringify({ headline: fact.headline, keyNumbers: fact.keyNumbers, incidents: fact.incidents }, null, 0) : '(none)'}

THE REEL (beat id → narration + current headline):
${digest.map((b) => `- ${b.id}: say="${b.say}" | headline="${b.text}"`).join('\n')}

Propose UP TO 3 candidate touches (the judge will keep the best 1-2). For each: which beat, which surface,
the exact content (Hinglish aside OR English headline), the device id, and a one-line rationale (what's the
incongruity/absurdity). Return: {"candidates":[{"beatId":"","surface":"say|text","content":"","device":"","rationale":""}]}`;
}

function judgePrompt(kit: ComedyKit, candidates: HumourTouch[]): string {
  return `You are the STRICT HUMOUR EDITOR of a news brand. For each candidate touch, decide keep or reject. Be
REJECT-BIASED: a news channel's credibility dies on ONE cringe or ill-timed joke. Keep a touch ONLY if it is
genuinely funny AND deadpan AND punches UP (power/hypocrisy/absurdity) NOT down (victims/ordinary people) AND
fits the beat AND breaks none of: ${kit.neverJokeAbout.join('; ')}. Reject anything try-hard, groan-worthy,
mean, off-tone, or that jokes near tragedy. Keep AT MOST ${MAX_TOUCHES} across the whole reel; if none clear
the bar, keep ZERO. Output ONLY JSON.

CANDIDATES:
${candidates.map((c, i) => `${i}. [${c.surface} on ${c.beatId}] "${c.content}" (device ${c.device}; ${c.rationale})`).join('\n')}

Return {"keep":[<indices to keep, best first, max ${MAX_TOUCHES}>],"why":"<one line>"}`;
}

/** Add up to 2 humorous touches to the story IN PLACE. Cached; best-effort (never throws, never fails a build). */
export async function applyHumour(
  story: StoryIR,
  fact: FactSheet | undefined,
  opts: { rootDir?: string } = {},
): Promise<HumourResult> {
  const rootDir = opts.rootDir ?? PROJECT_ROOT;
  const kit = loadKit(rootDir);
  if (!kit) return { applied: 0, touches: [] };

  const digest = beatDigest(story);
  const cacheDir = resolve(rootDir, '.cache/agents/humour');
  const key = createHash('sha256')
    .update(PROMPT_VERSION + '\n' + kit.version + '\n' + JSON.stringify(digest))
    .digest('hex')
    .slice(0, 16);
  const cacheFile = resolve(cacheDir, `${key}.json`);

  let touches: HumourTouch[];
  if (existsSync(cacheFile)) {
    touches = JSON.parse(readFileSync(cacheFile, 'utf8')) as HumourTouch[];
  } else {
    touches = await generateTouches(kit, digest, fact);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(touches, null, 2) + '\n', 'utf8');
  }

  // Apply the approved touches to the story (append the Hinglish aside / swap the English headline).
  let applied = 0;
  for (const t of touches.slice(0, MAX_TOUCHES)) {
    const beat = story.beats.find((b) => (b.id ?? '') === t.beatId);
    if (!beat) continue;
    if (t.surface === 'say' && typeof beat.say === 'string' && beat.say) {
      beat.say = `${beat.say.replace(/\s+$/, '')} ${t.content.trim()}`;
      applied += 1;
    } else if (t.surface === 'text') {
      const item = (beat.show ?? []).find((s) => typeof (s as { text?: unknown }).text === 'string') as
        | { text?: string }
        | undefined;
      if (item) {
        item.text = t.content.trim();
        applied += 1;
      }
    }
  }
  return { applied, touches };
}

/** The plan→judge pipeline (2 claude -p calls). Returns the APPROVED touches (possibly empty). Never throws. */
async function generateTouches(
  kit: ComedyKit,
  digest: ReturnType<typeof beatDigest>,
  fact: FactSheet | undefined,
): Promise<HumourTouch[]> {
  let candidates: HumourTouch[] = [];
  try {
    const raw = extractJson(await runClaudeText(architectPrompt(kit, digest, fact))) as { candidates?: HumourTouch[] };
    candidates = (raw.candidates ?? []).filter(
      (c) => c && (c.surface === 'say' || c.surface === 'text') && typeof c.content === 'string' && c.content.trim(),
    );
  } catch {
    return [];
  }
  if (candidates.length === 0) return [];

  try {
    const verdict = extractJson(await runClaudeText(judgePrompt(kit, candidates))) as { keep?: number[] };
    const keep = Array.isArray(verdict.keep) ? verdict.keep : [];
    return keep
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length)
      .slice(0, MAX_TOUCHES)
      .map((i) => candidates[i]!);
  } catch {
    return []; // judge failed → reject-biased default: add nothing rather than risk an unfiltered joke.
  }
}
