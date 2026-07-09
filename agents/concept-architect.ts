// Concept Architect — the "explain this to me" agent. Turns a concept prompt ("how do pulleys work",
// "explain an eclipse", "how an AND gate works", a math idea) into a short TEACHING video: each beat
// has narration that explains one step AND a `sim` generator whose agent-authored code DEMONSTRATES it
// with a real, animated, deterministic SVG diagram. Uses claude -p, validates the Story IR, and — the
// key gate — EXECUTES each beat's sim code once to catch runtime errors before the (slow) render,
// retrying with the error fed back.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import Matter from 'matter-js';

import { StoryIRSchema, type StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT, runClaudeText, extractJson } from './claude.js';

const PROMPT_VERSION = 'concept-architect@2';

export interface ConceptBrief {
  brief: string;
  aspect?: '9:16' | '16:9' | '1:1';
  language?: string;
  targetSeconds?: number;
}

const SYSTEM = `You are the CONCEPT ARCHITECT of an educational video studio. Explain the user's concept as a short, clear video, output as STRICT JSON (a "Story IR"). Output ONLY the JSON — no prose, no markdown fences.

Each beat TEACHES one step with narration AND a live SIMULATION that visually demonstrates it. The simulation is agent-written code you provide.

SHAPE (only these keys allowed):
{
  "title": "How Pulleys Work",
  "format": { "aspect": "16:9" },
  "style": "plain",
  "beats": [
    {
      "id": "step1",
      "say": "One or two sentences teaching THIS step, spoken to the viewer.",
      "duration": { "seconds": 7 },
      "camera": "hold",
      "show": [
        { "generator": "sim", "as": "viz", "args": { "z": 0, "code": "<SIM CODE>", "params": {} } },
        { "text": "SHORT LABEL", "as": "t", "at": "bottom", "args": { "z": 20, "size": 46, "weight": 800, "color": "#f5f7fa" } }
      ]
    }
  ]
}

THE SIM CODE (the heart of this) — the value of "code" is the BODY of a JS function \`(frame, fps, width, height, params) => string\` that RETURNS an SVG-markup string for the given frame:
- IT MUST BE A PURE FUNCTION OF \`frame\`: recompute the ENTIRE state from scratch every call (frames render in parallel — no state carried between calls). Use \`var t = frame / fps;\` for elapsed seconds.
- NO Date, NO Math.random (use deterministic math only). Plain ES5-ish JS (var, string concatenation).
- FIRST draw a full-frame opaque background: \`'<rect x="0" y="0" width="'+width+'" height="'+height+'" fill="#0a0d14"/>'\` — then everything else on top.
- Draw with SVG elements only: <rect> <circle> <ellipse> <line> <path> <polygon> <text>. Build the string with + concatenation. Use double-quotes inside the SVG and single-quotes for the JS strings.
- Use width/height for layout (center = width/2, height/2). Keep things well inside the frame.
- ANIMATE to DEMONSTRATE the concept — motion that actually teaches (a weight rising as a rope is pulled, the moon moving into shadow, current flowing through a gate, a wave propagating). Loop or ease smoothly over the beat's duration (duration_seconds ≈ beat.duration.seconds; you may assume ~7s, ~210 frames at 30fps).
- LABEL the important parts with <text fill="#cfd8e6" font-size="26"> so the viewer understands what they see. Keep labels short.
- Return "" only if truly nothing to draw (avoid — always draw something).

USE REAL PHYSICS — accuracy is the whole point (don't eyeball motion):
- For MECHANICS (pulleys, levers, gears, ramps, collisions, pendulums, springs, projectiles, gravity): use the injected \`Matter\` — the real matter.js 2D physics engine. Build an engine + bodies + constraints, then RE-SIMULATE FROM FRAME 0 each call so it stays deterministic:
    var eng = Matter.Engine.create(); eng.gravity.y = 1;
    var ground = Matter.Bodies.rectangle(width/2, height-60, width, 40, { isStatic: true });
    var ball = Matter.Bodies.circle(width/2, 220, 34, { restitution: 0.6 });
    Matter.Composite.add(eng.world, [ground, ball]);
    for (var i = 0; i < frame; i++) Matter.Engine.update(eng, 1000 / fps);   // step to THIS frame
    // now ball.position.x / ball.position.y are the REAL simulated positions — draw from them.
  Use Matter.Constraint for ropes/pulleys, multiple bodies for gears/levers. Read body.position and body.angle to draw each as an SVG <circle>/<rect transform="rotate(...)">.
- For ORBITS / ASTRONOMY: use accurate relationships (Kepler/Newton) — the moon's orbital period vs earth's, correct relative sizes/distances (scaled), real geometry for an eclipse (bodies actually line up).
- For WAVES / OPTICS / SOUND: use the real wave equation y = A·sin(k·x − ω·t); real reflection/refraction angles.
- For CIRCUITS / LOGIC GATES: show the correct truth-table behavior and current flow.
- For MATH: plot the actual function / real geometric construction accurately.
The viewer should learn something TRUE. If a value is uncertain, pick a physically reasonable one and keep the RELATIONSHIP correct.

RULES:
- 4 to 6 beats, each a clear step. Narration flows as ONE explanation (step builds on step), spoken TO the viewer, warm and plain. Be accurate; don't invent false facts.
- Every beat: a "sim" generator (z:0) + a short "text" label (z:20). "at" is one of center/top/bottom/left/right. "camera" is "hold".
- Use ONLY these beat keys: id, say, duration, camera, show. Show keys: generator, text, as, at, args.
- Return VALID JSON only.`;

function buildPrompt(b: ConceptBrief, priorError?: string): string {
  const controls = [
    `CONCEPT TO EXPLAIN: ${b.brief}`,
    `ASPECT: ${b.aspect ?? '16:9'}`,
    `LANGUAGE: ${b.language ?? 'English'} (write "say" in this language; keep "text" labels short)`,
    `TARGET LENGTH: about ${b.targetSeconds ?? 45} seconds`,
  ].join('\n');
  const fix = priorError
    ? `\n\nYour previous answer had problems:\n${priorError}\nFix EXACTLY those and return corrected JSON only.`
    : '';
  return `${SYSTEM}\n\n${controls}${fix}`;
}

/** Execute a sim code body once to catch runtime errors + verify it returns non-empty SVG. */
function checkSimCode(code: string, w: number, h: number): string | null {
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('frame', 'fps', 'width', 'height', 'params', 'Matter', code) as (
      ...a: unknown[]
    ) => unknown;
    // Test a few frames (incl. a late one) so a re-simulate-from-0 physics loop is actually exercised.
    for (const f of [0, 30, 150]) {
      const out = String(fn(f, 30, w, h, {}, Matter) ?? '');
      if (f === 30 && !out.includes('<')) return 'returned no SVG markup';
    }
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Validate the Story IR AND every sim's code; returns an error string, or null if all good. */
function verify(story: StoryIR, aspect?: string): string | null {
  const [w, h] = aspect === '9:16' ? [1080, 1920] : aspect === '1:1' ? [1080, 1080] : [1920, 1080];
  const errs: string[] = [];
  story.beats.forEach((beat, bi) => {
    (beat.show ?? []).forEach((item, si) => {
      const gen = (item as { generator?: string }).generator;
      if (gen !== 'sim') return;
      const code = ((item.args as Record<string, unknown> | undefined)?.['code'] ?? '') as string;
      if (typeof code !== 'string' || !code.trim()) {
        errs.push(`beat[${bi}].show[${si}] sim has no code`);
        return;
      }
      const e = checkSimCode(code, w, h);
      if (e) errs.push(`beat[${bi}] (${beat.id}) sim code error: ${e}`);
    });
  });
  return errs.length ? errs.slice(0, 8).join('\n') : null;
}

export interface ConceptResult {
  story: StoryIR;
  cached: boolean;
  attempts: number;
}

/** Run the Concept Architect → a validated, sim-verified Story IR. Content-addressed cached. */
export async function runConceptArchitect(b: ConceptBrief): Promise<ConceptResult> {
  const cacheDir = resolve(PROJECT_ROOT, '.cache/agents/concept-architect');
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
    if (!parsed.success) {
      priorError = parsed.error.issues.slice(0, 10).map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n');
      continue;
    }
    const simError = verify(parsed.data, b.aspect);
    if (simError) {
      priorError = `The Story IR is valid but simulation code failed:\n${simError}`;
      continue;
    }
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(parsed.data, null, 2) + '\n', 'utf8');
    return { story: parsed.data, cached: false, attempts: attempt };
  }
  throw new Error(`Concept Architect failed after ${MAX} attempts. Last error:\n${priorError}`);
}
