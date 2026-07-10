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
export const PROMPT_VERSION = 'story-architect@14'; // @14: clip: |phrase locator + contain

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
  /** Add sparse, tone-gated, judge-filtered humour (default ON for reels). false → keep it straight. */
  humour?: boolean;
  /** News-source PROVENANCE (the Radar candidate this video came from) — recorded into
   *  projects/<id>/source.json so every video is traceable to its news point even after the Radar DB
   *  rolls over. All optional (a hand-typed brief has none of this). */
  radar?: {
    candidateId?: string;
    title?: string; // the RAW headline the story came from (not the reframed angle)
    publisher?: string; // e.g. "ndtv"
    lane?: string;
    angle?: string; // the Radar's suggested VISUAL angle (a hint, not the story premise)
    whyIndia?: string;
    scores?: { aiScore?: number; indiaFit?: number; virality?: number };
    seenAt?: number;
  };
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
- ⚠️ THE CURRENT NEWS IS THE POINT — history is only SUPPORT. This is a NEWS explainer: the SPINE is what is
  happening NOW (the fact sheet's 'headline' / 'summary' / 'when' / latest 'incidents'). Anchor the whole
  video on the CURRENT development — why this is news TODAY, what it means, what is at stake, what happens
  next. Do NOT turn the reel into a history lesson / a documentary timeline; that loses the essence of the news.
- HOOK: open beat 1 on the CURRENT news itself — the latest striking fact/number/development that makes this
  news RIGHT NOW (not the oldest event in the timeline). For HINGLISH open with a warm "दोस्तों," then hit that
  CURRENT fact (NOT "देखिए", not a vague teaser).
- ⚠️ HISTORY = BRIEF CONTEXT, NOT THE BACKBONE. Use the 'timeline' ONLY to make the present make sense, and
  COMPRESS it into AT MOST 1 (rarely 2) context beat(s) — one line like "इसकी जड़ें 2007 में हैं, जब…" that
  lands the viewer back in the present immediately after. NEVER walk the timeline event-by-event across many
  beats. If the current news stands on its own, skip history entirely. The MAJORITY of beats stay on the NOW.
- 6 to 9 beats. ONE continuous story about the CURRENT event (each beat's "say" connects cause→effect to the
  previous, not isolated headlines). Talk TO the viewer (second person, respectful आप). END on the PRESENT —
  the stakes / what happens next / what it means for the viewer today — + an opinion question. Do NOT end on a
  historical summary.
- "text" is a VERY SHORT scannable headline (2-4 words MAX), DIFFERENT from the narration. ⚠️ ALWAYS in
  ENGLISH (even though the narration "say" is Hinglish) — the on-screen text + subtitles are English so a
  muted / non-Hindi viewer can read; prefer a punchy FACT fragment ("150 DEAD", "#1 SINCE 2013",
  "1,045 ATTACKS", "ZARB-E-AZB, 2014"). Keep proper nouns/numbers exact. 9:16 → "size" 48-72; never a sentence.
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
      { "asset": "wiki:<exact subject name>", "as": "bg", "args": { "z": 0, "fit": "cover", "kenburns": "in", "fallback_q": "<a specific footage phrase for this beat>", "effects": [{ "kind": "color_grade", "brightness": 0.7, "saturate": 1.02 }] } }
      (e.g. "wiki:Baitullah Mehsud", "wiki:Army Public School Peshawar", "wiki:Operation Zarb-e-Azb").
      ⚠️ ALWAYS include "fallback_q" (a 'footageHints'-style filmable phrase) on a wiki image: some subjects
      (esp. militant leaders / obscure people) have NO free photo, so if the image can't be found the beat
      falls back to this footage instead of an empty frame. Make it relevant to the beat (e.g. for
      "wiki:Baitullah Mehsud" during the 2007 origins → "fallback_q": "pakistan tribal areas mountains fighters").
  (B) STOCK FOOTAGE — for GENERIC action/atmosphere (soldiers patrolling, a flooded street, a crowd), use
      a 'footageHints' phrase: { "footage": "q:<specific phrase>", "as": "bg", "args": { "z": 0, "loop": true, "muted": true, "fit": "cover", "effects": [{ "kind": "color_grade", "brightness": 0.7, "saturate": 1.05 }] } }
      "q:" MUST be a SPECIFIC filmable phrase from 'footageHints' — NEVER generic ("war"/"conflict"/"time"),
      which return fireworks/junk.
  (B2) REAL VIDEO CLIP (EVIDENCE) — ⚠️ when the story IS ABOUT a specific PUBLIC STATEMENT, a VIRAL CLIP, a
      speech, a press moment, or a real event with known video, SHOW THE ACTUAL CLIP (the real moment is the
      whole point — far better than stock or a caveat):
      { "footage": "clip:<precise search query>|<exact spoken phrase to show>", "as": "bg", "args": { "z": 0, "loop": true, "muted": false } }.
      Format is "clip:" + a YouTube search query + "|" + the EXACT WORDS spoken at the moment to show — the
      phrase LOCATES the moment in the clip so it plays FROM the gaffe/quote (not the clip's dull first
      seconds). E.g. "clip:Trump Islamic Republic of Japan speech|islamic republic of japan". Set "muted":
      false when the WORDS matter (a gaffe, a quote) — the clip's own audio plays. Do NOT set "fit" (the scout
      uses 'contain' so the landscape clip is never side-cropped). Because the clip IS the evidence, DO NOT add
      an "unverified/we can't confirm" caveat beat for a story you are showing the real footage of.
  (C) REAL SOURCE SCREENSHOT (EVIDENCE) — for a DATA/REPORT/RANKING/STATISTIC story, show the ACTUAL
      article/report the facts come from ("here is the real source", not a reconstruction). Use a URL from
      the fact sheet's 'sourceUrls': { "asset": "newsshot:<url>", "as": "bg", "args": { "z": 0, "fit": "contain", "kenburns": "out-slow", "fallback_q": "<footage phrase>" } }.
      ⚠️ A citation MUST stay readable: "fit":"contain" (show the WHOLE screenshot, never crop) + "kenburns":
      "out-slow" (SETTLE to fully-visible, never "in" which zooms in and crops off the article text).
      Put it near the top (the "proof" beat right after the hook). ONLY use a URL that appears in 'sourceUrls'.
  (D) DATA CHART — if the fact sheet has a 'chart' with non-empty data, render it as the DATA hero (a
      striking stat IS the story): { "generator": "chart", "as": "chart", "at": "center",
        "args": { "z": 6, "kind": "<chart.kind>", "orientation": "horizontal",
          "inset": { "top": 560, "right": 110, "bottom": 640, "left": 300 },
          "colors": ["#3a516c"], "gap": 0.3, "labels": true, "axes": true,
          "draw_on": { "duration": 26, "stagger": 5, "easing": "easeOut" },
          "data": [ { "label": "<from chart.data>", "value": <n> }, ... ] } }
      Copy chart.data VERBATIM (the REAL numbers) into "data"; give ONLY the 'chart.emphasis' row a
      "color": "#ff4438" (others omit color). Pair the chart beat with a short "text" naming the metric
      ("1,045 हमले") and a 'say' built on those numbers.
  (E) GENERATED ILLUSTRATION — for an ABSTRACT / CONCEPTUAL beat where NO real photo, footage, map, or chart
      fits (an economic idea, a policy, a metaphor, a "what if", a concept) — a custom AI illustration beats
      vague stock: { "asset": "gen:<a detailed illustration prompt>", "as": "bg", "args": { "z": 0, "fit": "cover", "kenburns": "in", "fallback_q": "<footage phrase>" } }.
      Write the gen prompt as a FLAT-VECTOR EDITORIAL or CINEMATIC-STYLIZED illustration (e.g. "flat-vector
      editorial illustration of a supply chain breaking, minimal, dark cinematic background") — NEVER for a
      real named person/place/event (use a real WIKIMEDIA image for those). Use SPARINGLY (1 per reel at most).
  RULE OF THUMB: a striking STAT/ranking/report → a CHART (D) + the REAL source screenshot (C) as the
  STARS (lead with them, don't bury the number under generic footage); a named person/place/event → a
  WIKIMEDIA image (A); a generic scene → footage (B); geography → the map; an ABSTRACT CONCEPT with no real
  visual → a GENERATED illustration (E). Prefer real data/images/maps; generate only for the abstract.
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
