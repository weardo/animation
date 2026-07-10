// Job store + runner (P1 walking skeleton). A brief becomes a JOB that runs the orchestrator
// (brief → Story IR → story.yaml) then spawns the render as a subprocess. Jobs live in memory + a
// JSON file (.data/jobs.json) — SQLite is the P3/cloud swap-in. The render is async (off-request);
// progress is followed via the project's own media/render.log.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { PROJECT_ROOT } from '../agents/claude.js';
import type { OrchestrateResult } from '../agents/orchestrate.js';
import type { StoryBrief } from '../agents/story-architect.js';

// Map a human language name (from the brief) to a Sarvam Bulbul target_language_code. English is the
// studio default; Hindi/Hinglish → hi-IN; the common Indic languages Sarvam supports are handled too.
function sarvamLang(language?: string): string {
  const l = (language ?? 'English').toLowerCase();
  if (l.includes('hindi') || l.includes('hinglish')) return 'hi-IN';
  const map: Record<string, string> = {
    bengali: 'bn-IN', tamil: 'ta-IN', telugu: 'te-IN', kannada: 'kn-IN', malayalam: 'ml-IN',
    marathi: 'mr-IN', gujarati: 'gu-IN', punjabi: 'pa-IN', odia: 'od-IN',
  };
  for (const [name, code] of Object.entries(map)) if (l.includes(name)) return code;
  return 'en-IN';
}

export type JobStatus = 'queued' | 'writing_story' | 'rendering' | 'done' | 'error' | 'draft';

export interface JobStage {
  name: string;
  at: number;
  note?: string;
}

export interface Job {
  id: string;
  brief: StoryBrief;
  status: JobStatus;
  createdAt: number;
  projectId?: string;
  storyPath?: string;
  title?: string;
  beats?: number;
  outputRel?: string; // repo-relative path to out.mp4
  error?: string;
  stages: JobStage[];
}

const DATA_DIR = resolve(PROJECT_ROOT, '.data');
const JOBS_FILE = resolve(DATA_DIR, 'jobs.json');
const jobs = new Map<string, Job>();

function persist(): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(JOBS_FILE, JSON.stringify([...jobs.values()], null, 2), 'utf8');
}

function load(): void {
  if (!existsSync(JOBS_FILE)) return;
  try {
    for (const j of JSON.parse(readFileSync(JOBS_FILE, 'utf8')) as Job[]) {
      // A render in flight when the server stopped is not recoverable — mark it errored on load.
      if (j.status === 'rendering' || j.status === 'writing_story' || j.status === 'queued') {
        j.status = 'error';
        j.error = 'server restarted mid-job';
      }
      jobs.set(j.id, j);
    }
  } catch {
    /* corrupt file → start empty */
  }
}
load();

let counter = 0;
function newId(): string {
  counter += 1;
  return `job-${Date.now().toString(36)}-${counter}`;
}

function stage(job: Job, name: string, status: JobStatus, note?: string): void {
  job.status = status;
  job.stages.push({ name, at: Date.now(), ...(note ? { note } : {}) });
  persist();
}

export function createJob(brief: StoryBrief): Job {
  const job: Job = { id: newId(), brief, status: 'queued', createdAt: Date.now(), stages: [] };
  jobs.set(job.id, job);
  persist();
  void runJob(job.id);
  return job;
}

/**
 * Read a project's display metadata straight from its directory — the SINGLE SOURCE OF TRUTH. Title comes
 * from project.json (rendered) → story.yaml → source.json → id; a finished video is projects/<id>/media/
 * out.mp4. This is what makes EVERY project (dashboard OR CLI-generated) show up: the dashboard lists the
 * disk, not just its own job store. Returns null if the dir isn't a real project.
 */
function readProjectMeta(id: string): { title: string; hasVideo: boolean; createdAt: number } | null {
  const dir = resolve(PROJECT_ROOT, 'projects', id);
  const story = resolve(dir, 'story.yaml');
  const project = resolve(dir, 'project.json');
  if (!existsSync(story) && !existsSync(project)) return null; // not a factory project

  // Prefer the human STORY title (project.json.name is usually just the id). Fall back to project name →
  // the source brief → the id.
  let title = '';
  try {
    const t = (parseYaml(readFileSync(story, 'utf8')) as { title?: unknown } | null)?.title;
    if (typeof t === 'string') title = t.trim();
  } catch { /* no story / bad yaml */ }
  if (!title) {
    try {
      const n = (JSON.parse(readFileSync(project, 'utf8')) as { name?: string }).name;
      if (n && n !== id) title = n;
    } catch { /* no project.json */ }
  }
  if (!title) {
    try {
      const s = JSON.parse(readFileSync(resolve(dir, 'source.json'), 'utf8')) as { brief?: string };
      if (s.brief) title = s.brief;
    } catch { /* none */ }
  }
  if (!title) title = id;
  const out = resolve(dir, 'media', 'out.mp4');
  const hasVideo = existsSync(out);
  let createdAt = 0;
  try { createdAt = statSync(hasVideo ? out : existsSync(project) ? project : story).mtimeMs; } catch { /* 0 */ }
  return { title, hasVideo, createdAt };
}

/**
 * Resolve a card id to a Job. A real (in-flight or recent) job wins; otherwise SYNTHESIZE one from the
 * on-disk project so /api/jobs/:id/{video,detail,publish} work for a CLI-generated project the dashboard
 * never ran. This is the unification: the id space is projects, and a job is just transient build status.
 */
export function getJob(id: string): Job | undefined {
  const j = jobs.get(id);
  if (j) return j;
  const meta = readProjectMeta(id);
  if (!meta) return undefined;
  return {
    id,
    projectId: id,
    brief: { brief: meta.title } as StoryBrief,
    status: meta.hasVideo ? 'done' : 'draft',
    createdAt: meta.createdAt,
    title: meta.title,
    ...(meta.hasVideo ? { outputRel: `projects/${id}/media/out.mp4` } : {}),
    stages: [],
  };
}

/**
 * The dashboard's project list: EVERY project on disk merged with live job status. A building job with no
 * disk project yet shows as building; a finished disk project shows as done; a job's live status overlays
 * its project while it runs. Keyed by project id (or job id for a not-yet-written build), newest first — so
 * a project made by the CLI and one made by the dashboard appear identically.
 */
export function listJobs(): Job[] {
  const cards = new Map<string, Job>();

  // 1. Every project on disk (the source of truth).
  const projectsDir = resolve(PROJECT_ROOT, 'projects');
  let ids: string[] = [];
  try {
    ids = readdirSync(projectsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { /* no projects dir yet */ }
  for (const id of ids) {
    const meta = readProjectMeta(id);
    if (!meta) continue;
    cards.set(id, {
      id, projectId: id, brief: { brief: meta.title } as StoryBrief,
      status: meta.hasVideo ? 'done' : 'draft', // a story written but not yet rendered
      createdAt: meta.createdAt, title: meta.title,
      ...(meta.hasVideo ? { outputRel: `projects/${id}/media/out.mp4` } : {}),
      stages: [],
    });
  }

  // 2. Overlay jobs: a running job shows its live status on its project; a job still building (no disk
  //    project yet) is added on its own; a finished job just defers to the disk project (already listed).
  for (const job of jobs.values()) {
    const pid = job.projectId;
    if (pid && cards.has(pid)) {
      if (job.status !== 'done') cards.set(pid, job); // live build status wins over the static disk card
    } else if (job.status !== 'done') {
      cards.set(pid ?? job.id, job); // an in-flight build not yet written to disk
    }
  }

  return [...cards.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Run the orchestration (Story Architect + Asset Scout) in its own process (keeps the server free). */
function runOrchestrateSubprocess(brief: StoryBrief, onProgress: (m: string) => void): Promise<OrchestrateResult> {
  return new Promise((done, reject) => {
    const p = spawn('npx', ['tsx', 'api/orchestrate-cli.ts'], {
      cwd: PROJECT_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Same narration language the render uses, so fit-durations measures (and caches) the right wavs.
      env: { ...process.env, SARVAM_LANG: sarvamLang(brief.language) },
    });
    let out = '';
    let err = '';
    let buf = ''; // line-buffer stderr to pull out @@P@@ progress markers (rest is real error text)
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      err += s;
      buf += s;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.startsWith('@@P@@')) onProgress(line.slice(5));
      }
    });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(err || `orchestrate exited ${code}`));
        return;
      }
      try {
        done(JSON.parse(out) as OrchestrateResult);
      } catch (e) {
        reject(e as Error);
      }
    });
    p.stdin.write(JSON.stringify(brief));
    p.stdin.end();
  });
}

async function runJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  try {
    // 1. Story Architect (brief → Story IR) + Asset Scout (fetch a background clip per beat).
    //    Run in a SUBPROCESS: the footage proxy-transcode (ffmpeg, synchronous) would otherwise block
    //    the server's event loop for a minute+ and freeze the UI mid-job.
    stage(job, 'Writing story + fetching visuals', 'writing_story');
    const res = await runOrchestrateSubprocess(job.brief, (msg) => stage(job, msg, 'writing_story'));
    job.projectId = res.projectId;
    job.storyPath = res.storyPath;
    job.title = res.title;
    job.beats = res.beats;
    stage(job, `Story ready · ${res.beats} beats · ${res.visualsResolved} clips`, 'writing_story');

    // 2. Render (full video with narration + captions + music/sfx). Narration goes through Sarvam AI
    //    (best voice); if SARVAM_API_KEY is unset it falls back to espeak-ng automatically. word-align
    //    / lip-sync (venv-gated) stay disabled for speed.
    stage(job, 'Rendering video', 'rendering');
    const args = [
      'tsx', 'src/cli/render.ts', res.storyPath,
      '--project', res.projectId,
      '--engine', 'sarvam',
      '--no-word-align', '--no-lip-sync',
    ];
    const code = await new Promise<number>((done) => {
      const p = spawn('npx', args, {
        cwd: PROJECT_ROOT,
        stdio: 'ignore',
        env: { ...process.env, SARVAM_LANG: sarvamLang(job.brief.language) },
      });
      p.on('close', (c) => done(c ?? -1));
      p.on('error', () => done(-1));
    });
    if (code !== 0) throw new Error(`render exited with code ${code}`);

    const outputRel = `projects/${res.projectId}/media/out.mp4`;
    if (!existsSync(resolve(PROJECT_ROOT, outputRel))) throw new Error('render finished but no out.mp4');
    job.outputRel = outputRel;
    stage(job, 'Done', 'done');
  } catch (e) {
    job.error = (e as Error).message;
    stage(job, 'Error', 'error', job.error);
  }
}

/**
 * Publish a rendered project to YouTube via the existing publisher. DRY-RUN by default (validates +
 * previews, no upload); pass confirm=true to actually upload (unlisted). Returns the CLI output + any
 * resulting URL.
 */
export async function publishProject(
  projectId: string,
  confirm: boolean,
): Promise<{ status: string; output: string; url?: string }> {
  const args = ['tsx', 'src/cli/publish.ts', projectId, '--visibility', 'unlisted'];
  if (confirm) args.push('--yes');
  return new Promise((done) => {
    let out = '';
    const p = spawn('npx', args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (out += d.toString()));
    p.on('close', (code) => {
      const m = out.match(/https?:\/\/(?:youtu\.be|www\.youtube\.com)\/\S+/);
      done({ status: code === 0 ? 'ok' : 'failed', output: out.slice(-2000), ...(m ? { url: m[0] } : {}) });
    });
    p.on('error', (e) => done({ status: 'failed', output: String(e) }));
  });
}

/** Last N non-empty lines of a job's render log (for live progress in the UI). */
export function renderLogTail(job: Job, n = 10): string {
  if (!job.projectId) return '';
  const log = resolve(PROJECT_ROOT, 'projects', job.projectId, 'media', 'render.log');
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}
