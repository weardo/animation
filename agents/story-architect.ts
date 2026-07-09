// Story Architect — the first specialist agent. Turns a one-line BRIEF into a validated Story IR
// (the authored `story.yaml` model): a hook→turn→payoff narrative of beats with narration + simple
// on-screen headlines. Uses `claude -p`, validates against the real StoryIRSchema, retries with the
// Zod errors fed back, and content-addresses the VALIDATED result so a warm brief replays exactly.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { StoryIRSchema, type StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT, runClaudeText, extractJson } from './claude.js';

/** Bump when the prompt changes → invalidates the cache (like a pass PASS_VERSION). */
const PROMPT_VERSION = 'story-architect@4';

export interface StoryBrief {
  brief: string;
  aspect?: '9:16' | '16:9' | '1:1';
  style?: 'kurzgesagt' | 'plain';
  language?: string; // e.g. "Hinglish", "English"
  targetSeconds?: number;
  /** 'story' = footage explainer; 'concept' = teach with a real simulation; 'auto' = detect. */
  mode?: 'auto' | 'story' | 'concept';
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
- 6 to 9 beats. Structure the narration as ONE continuous story split into beats: HOOK → context → stakes → turn → payoff. Each beat's "say" must connect to the previous (cause→effect), not read as isolated headlines.
- Talk TO the viewer (second person, respectful). Open warmly, not with a gimmick. End on a loop/takeaway.
- "text" is a VERY SHORT scannable headline (2-4 words MAX), DIFFERENT from the narration. It MUST fit the frame width: for 9:16 (vertical) keep "size" 48-72 and 2-4 words; for 16:9 you may go 60-96. Never a full sentence — it will overflow and clip.
- Bump the PROMPT_VERSION-worthy note: prefer punchy fragments ("THE LITTLE ENGINE", "25× A SECOND") over long phrases.
- Keep every fact plausible/verifiable; do not invent statistics you are unsure of.
- VISUALS ARE MANDATORY — a video of only text is broken. EVERY beat's "show" MUST START with a background FOOTAGE item that visually depicts the beat:
  { "footage": "q:<query>", "as": "bg", "args": { "z": 0, "loop": true, "muted": true, "fit": "cover", "effects": [{ "kind": "color_grade", "brightness": 0.42, "saturate": 1.05 }] } }
  The "q:" value is a CONCRETE, literal STOCK-VIDEO search phrase (2-4 words) for real filmable footage that shows this beat's subject — e.g. "black hole space", "spinning galaxy", "clock close up", "city traffic timelapse", "ocean waves aerial". NEVER abstract concepts ("time", "confusion") — those return nothing. Pick footage a stock library would actually have. Vary it per beat.
- MOTION IS MANDATORY:
  · EVERY text MUST have an "anim" in its args (plus "z": 20 so it sits above the footage). Use {"preset":"rise","duration":12,"distance":40} for most; {"preset":"fade","duration":12} occasionally.
  · EVERY beat MUST have a "camera" move. First beat = "establishing". Then VARY: "slow_push_in", "slow_pull_out", "pan_left", "pan_right", occasional "hold". Never repeat the same camera 3 beats running.
- Use ONLY these beat keys: id, say, duration, camera, show. Use ONLY these show keys: footage, text, as, at, args. "at" is one of: center, top, bottom, left, right. "camera" is one of: establishing, slow_push_in, slow_pull_out, pan_left, pan_right, hold. Give each beat a unique id.
- Return VALID JSON only.`;

function buildPrompt(b: StoryBrief, priorError?: string): string {
  const controls = [
    `BRIEF: ${b.brief}`,
    `ASPECT: ${b.aspect ?? '9:16'}`,
    `STYLE: ${b.style ?? 'kurzgesagt'}`,
    `LANGUAGE: ${b.language ?? 'English'} (write the "say" narration in this language; keep "text" headlines short in the same language)`,
    `TARGET LENGTH: about ${b.targetSeconds ?? 45} seconds total`,
  ].join('\n');
  const fix = priorError
    ? `\n\nYour previous answer FAILED validation with:\n${priorError}\nFix EXACTLY those problems and return corrected JSON only.`
    : '';
  return `${SYSTEM}\n\n${controls}${fix}`;
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
