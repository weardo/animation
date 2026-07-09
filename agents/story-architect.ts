// Story Architect — the first specialist agent. Turns a one-line BRIEF into a validated Story IR
// (the authored `story.yaml` model): a hook→turn→payoff narrative of beats with narration + simple
// on-screen headlines. Uses `claude -p`, validates against the real StoryIRSchema, retries with the
// Zod errors fed back, and content-addresses the VALIDATED result so a warm brief replays exactly.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StoryIRSchema, type StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT, runClaudeText, extractJson } from './claude.js';
import type { FactSheet } from './research.js';

/** Bump when the prompt changes → invalidates the cache (like a pass PASS_VERSION). */
const PROMPT_VERSION = 'story-architect@7';

export interface StoryBrief {
  brief: string;
  aspect?: '9:16' | '16:9' | '1:1';
  style?: 'kurzgesagt' | 'plain';
  language?: string; // e.g. "Hinglish", "English"
  targetSeconds?: number;
  /** 'story' = footage explainer; 'concept' = teach with a real simulation; 'auto' = detect. */
  mode?: 'auto' | 'story' | 'concept';
  /** The FACT SHEET (from the research agent) — the SOLE factual basis every beat must be grounded in. */
  factSheet?: FactSheet;
  /** Seed source (a Radar candidate's article URL/summary) — carried for provenance/research. */
  sourceUrl?: string;
  sourceSummary?: string;
}

const SYSTEM = `You are the STORY ARCHITECT of an automated video studio. Turn the user's brief into a short, punchy explainer as STRICT JSON (a "Story IR"). Output ONLY the JSON object — no prose, no markdown fences.

SHAPE (all keys shown are the ONLY allowed keys — extras are rejected):
{
  "title": "short video title",
  "format": { "aspect": "9:16" },
  "style": "kurzgesagt",
  "beats": [
    {
      "id": "hook",
      "say": "One flowing sentence of narration for this beat.",
      "duration": { "seconds": 5 },
      "camera": "slow_push_in",
      "show": [
        { "footage": "q:swirling galaxy in deep space", "as": "bg",
          "args": { "z": 0, "loop": true, "muted": true, "fit": "cover",
                    "effects": [{ "kind": "color_grade", "brightness": 0.42, "saturate": 1.05 }] } },
        { "text": "SHORT HEADLINE", "as": "t", "at": "center",
          "args": { "z": 20, "size": 68, "weight": 800, "color": "#f5f7fa",
                    "anim": { "preset": "rise", "duration": 12, "distance": 40 } } }
      ]
    }
  ]
}

RULES:
- ⚠️ FACTS ARE THE CENTRE OF THE VIDEO. You are given a FACT SHEET (below). EVERY beat's narration MUST be
  built on SPECIFIC facts from it — real dates, places, names, and NUMBERS. NEVER talk "round-about" the
  topic with vague generalities. If the fact sheet gives a number/place/date for a point, USE it verbatim.
  Do NOT invent facts NOT in the sheet. A beat with no concrete fact is a failed beat — rewrite it.
- HOOK: open beat 1 on the single most STRIKING specific fact or number from the sheet (e.g. a death toll, a
  date, a place) — for HINGLISH open with a warm "दोस्तों," then hit that fact (NOT "देखिए", not a vague teaser).
- ⚠️ CHRONOLOGY when it helps: if the fact sheet has a 'timeline', and history explains how things got here
  (a conflict's roots, an escalation), WALK IT IN ORDER across beats ("2007 में शुरू हुआ… 2014 में… और 2022 तक…")
  so the viewer follows a coherent, relatable progression. Skip the timeline for a pure one-off event.
- 6 to 9 beats. ONE continuous story (each beat's "say" connects cause→effect to the previous, not isolated
  headlines). Talk TO the viewer (second person, respectful आप). End on a loop/takeaway + an opinion question.
- "text" is a VERY SHORT scannable headline (2-4 words MAX), DIFFERENT from the narration — prefer a FACT
  fragment ("150 मौतें", "2014 का हमला"). 9:16 → "size" 48-72; never a full sentence.
- ⚠️ MAP when geography helps (the fact sheet's 'needsMap'): if true, include ONE (rarely two) MAP beat where
  it best serves the story — a 'generator: world-in' item that shows WHERE things happened:
  { "generator": "world-in", "as": "world", "args": { "projection": "mercator", "fit": false,
    "center": [<lon>, <lat>], "scale": <400-1200, tighter=bigger>, "key_field": "name",
    "fill": "#223249", "no_data_fill": "#223249", "stroke": "#3a516c", "ocean": "#0a1420",
    "choropleth": { "<Country>": "#ff4438" },
    "markers": [ { "coord": [<lon>,<lat>], "label": "<place>", "color": "#ffb020", "radius": 6 } ],
    "labels": { "<Country>": "<Country>" } } }
  Put a MARKER at each incident location using the fact sheet's 'where[].lon/lat'; choropleth-highlight the
  'mapCountries'; set center/scale to frame those places tightly. Use ONLY if geography genuinely helps.
- ⚠️ VISUALS — pick the RIGHT source per beat (every non-map beat needs ONE background visual):
  (A) REAL WIKIMEDIA IMAGE — PREFER THIS for a beat about a SPECIFIC named subject that a real photo exists
      for (a person, a specific building/place, a named event/operation/weapon) — use a subject from the
      fact sheet's 'imageSubjects'. Shows the ACTUAL thing, which stock footage never has:
      { "asset": "wiki:<exact subject name>", "as": "bg", "args": { "z": 0, "fit": "cover", "kenburns": "in", "effects": [{ "kind": "color_grade", "brightness": 0.7, "saturate": 1.02 }] } }
      (e.g. "wiki:Baitullah Mehsud", "wiki:Army Public School Peshawar", "wiki:Operation Zarb-e-Azb").
  (B) STOCK FOOTAGE — for GENERIC action/atmosphere (soldiers patrolling, a flooded street, a crowd), use
      a 'footageHints' phrase: { "footage": "q:<specific phrase>", "as": "bg", "args": { "z": 0, "loop": true, "muted": true, "fit": "cover", "effects": [{ "kind": "color_grade", "brightness": 0.7, "saturate": 1.05 }] } }
      "q:" MUST be a SPECIFIC filmable phrase from 'footageHints' — NEVER generic ("war"/"conflict"/"time"),
      which return fireworks/junk.
  RULE OF THUMB: a named person/place/event → a WIKIMEDIA image (A); a generic scene → footage (B);
  geography → the map. Prefer real images/maps over vague stock for a hard-news story.
- MOTION: every text has an "anim" (+ "z":20). Every beat has a "camera" (first="establishing", then vary
  slow_push_in / slow_pull_out / pan_left / pan_right / hold; never 3 same in a row).
- Use ONLY these beat keys: id, say, duration, camera, show. Show keys: footage OR asset OR generator, text, as, at, args.
  "at" ∈ {center,top,bottom,left,right}. "camera" ∈ {establishing,slow_push_in,slow_pull_out,pan_left,pan_right,hold}.
- Return VALID JSON only.`;

function buildPrompt(b: StoryBrief, priorError?: string): string {
  const controls = [
    `BRIEF: ${b.brief}`,
    `ASPECT: ${b.aspect ?? '9:16'}`,
    `STYLE: ${b.style ?? 'kurzgesagt'}`,
    `LANGUAGE: ${b.language ?? 'English'} (write the "say" narration in this language; keep "text" headlines short in the same language)`,
    `TARGET LENGTH: about ${b.targetSeconds ?? 45} seconds total`,
  ].join('\n');
  const facts = b.factSheet
    ? `\n\nFACT SHEET (the SOLE factual basis — ground every beat in these; do not invent beyond them):\n${JSON.stringify(
        b.factSheet,
        null,
        1,
      )}`
    : '\n\n(No fact sheet available — stay high-level and DO NOT invent specific numbers/dates/names.)';
  const fix = priorError
    ? `\n\nYour previous answer FAILED validation with:\n${priorError}\nFix EXACTLY those problems and return corrected JSON only.`
    : '';
  return `${SYSTEM}\n\n${controls}${facts}${fix}`;
}

export interface ArchitectResult {
  story: StoryIR;
  cached: boolean;
  attempts: number;
}

/** Run the Story Architect. Returns a validated StoryIR, content-addressed cached (run-once, replay). */
export async function runStoryArchitect(b: StoryBrief): Promise<ArchitectResult> {
  const cacheDir = resolve(PROJECT_ROOT, '.cache/agents/story-architect');
  const key = createHash('sha256').update(PROMPT_VERSION + '\n' + JSON.stringify(b)).digest('hex').slice(0, 16);
  const cacheFile = resolve(cacheDir, `${key}.json`);
  if (existsSync(cacheFile)) {
    return { story: JSON.parse(readFileSync(cacheFile, 'utf8')) as StoryIR, cached: true, attempts: 0 };
  }

  let priorError: string | undefined;
  const MAX = 3;
  for (let attempt = 1; attempt <= MAX; attempt++) {
    let candidate: unknown;
    try {
      candidate = extractJson(await runClaudeText(buildPrompt(b, priorError)));
    } catch (e) {
      priorError = `Response was not parseable JSON: ${(e as Error).message}`;
      continue;
    }
    const parsed = StoryIRSchema.safeParse(candidate);
    if (parsed.success) {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
      return { story: parsed.data, cached: false, attempts: attempt };
    }
    priorError = parsed.error.issues
      .slice(0, 12)
      .map((i) => `- ${i.path.join('.')}: ${i.message}`)
      .join('\n');
  }
  throw new Error(`Story Architect failed to produce a valid Story IR after ${MAX} attempts. Last error:\n${priorError}`);
}
