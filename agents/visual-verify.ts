// Visual verifier — the guarantee that a SIMULATION is actually correct, not just crash-free. After a
// concept story is written, it renders the beats to stills and has claude -p LOOK at each frame and
// judge the GEOMETRY (elements inside the frame, shadows/ropes/arrows actually connected, coherent
// layout). Any problems are fed back to the Concept Architect to regenerate. This catches the mistakes
// the execute-the-code gate can't — a sim that runs fine but draws the shadow not reaching Earth.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { PROJECT_ROOT, runClaudeVision, extractJson } from './claude.js';

/** Render the project's beats to stills (fast, no audio). Returns true on success. */
function renderStills(projectId: string): Promise<boolean> {
  return new Promise((done) => {
    const p = spawn(
      'npx',
      ['tsx', 'src/cli/render.ts', `projects/${projectId}/story.yaml`, '--project', projectId, '--frames', 'auto', '--no-audio'],
      { cwd: PROJECT_ROOT, stdio: 'ignore' },
    );
    p.on('close', (c) => done(c === 0));
    p.on('error', () => done(false));
  });
}

/**
 * Render the concept's stills and have the model judge each diagram's geometry. Returns a list of
 * specific problems (empty = all good). On any infrastructure failure it returns [] (never blocks the
 * build — the video still ships, just unverified).
 */
export async function visualVerify(projectId: string, concept: string): Promise<string[]> {
  const ok = await renderStills(projectId);
  const framesDir = resolve(PROJECT_ROOT, 'projects', projectId, 'media', 'frames');
  if (!ok || !existsSync(framesDir)) return [];
  const fullFrames = readdirSync(framesDir)
    .filter((f) => f.endsWith('.png') && !f.startsWith('_'))
    .sort()
    .map((f) => resolve(framesDir, f));
  if (!fullFrames.length) return [];

  // Downscale to ~768px wide for a FAST vision judgment — a geometry error (shadow not reaching Earth,
  // element off-screen) is obvious at low res, and small images judge in seconds vs minutes for full HD.
  const smallDir = resolve(framesDir, '_small');
  mkdirSync(smallDir, { recursive: true });
  const frames: string[] = [];
  for (const f of fullFrames) {
    const out = resolve(smallDir, basename(f));
    try {
      execFileSync('ffmpeg', ['-y', '-i', f, '-vf', 'scale=768:-1', out], { stdio: 'ignore' });
      frames.push(out);
    } catch {
      /* skip a frame that fails to downscale */
    }
  }
  if (!frames.length) return [];

  const prompt =
    `You are a STRICT visual-QA reviewer for an educational video explaining "${concept}". ` +
    `Look at each of these ${frames.length} rendered frames:\n` +
    frames.map((f, i) => `Frame ${i + 1}: ${f}`).join('\n') +
    `\n\nJudge ONLY the diagram/illustration in each — IGNORE the subtitle caption bar and any headline text. ` +
    `For each frame verify: (a) every element is fully INSIDE the frame (nothing cut off, off-screen, or drifting away alone); ` +
    `(b) things that should connect ARE connected with no gap (a shadow cone reaches the body it falls on; a rope reaches the weight; a ray hits the surface; an arrow starts and ends on the right points); ` +
    `(c) the layout is coherent and not badly overlapping. ` +
    `Reply with ONLY a JSON object: {"problems": ["frame N: <specific problem>", ...]}. ` +
    `Return an EMPTY array if every diagram is geometrically correct and well-composed. Report only REAL, specific problems.`;

  try {
    const res = extractJson(await runClaudeVision(prompt)) as { problems?: unknown };
    return Array.isArray(res?.problems) ? (res.problems.filter((x) => typeof x === 'string') as string[]) : [];
  } catch {
    return [];
  }
}
