// Job store + runner (P1 walking skeleton). A brief becomes a JOB that runs the orchestrator
// (brief → Story IR → story.yaml) then spawns the render as a subprocess. Jobs live in memory + a
// JSON file (.data/jobs.json) — SQLite is the P3/cloud swap-in. The render is async (off-request);
// progress is followed via the project's own media/render.log.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { PROJECT_ROOT } from '../agents/claude.js';
import { orchestrateBrief } from '../agents/orchestrate.js';
import type { StoryBrief } from '../agents/story-architect.js';

export type JobStatus = 'queued' | 'writing_story' | 'rendering' | 'done' | 'error';

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

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function listJobs(): Job[] {
  return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

async function runJob(id: string): Promise<void> {
  const job = jobs.get(id);
  if (!job) return;
  try {
    // 1. Story Architect: brief → Story IR → story.yaml
    stage(job, 'Writing story', 'writing_story');
    const res = orchestrateBrief(job.brief);
    job.projectId = res.projectId;
    job.storyPath = res.storyPath;
    job.title = res.title;
    job.beats = res.beats;
    stage(job, `Story ready · ${res.beats} beats`, 'writing_story');

    // 2. Render (full video with narration + captions + music/sfx). espeak-ng = fast, offline,
    //    always-available TTS for the walking skeleton; word-align/lip-sync (venv-gated) disabled.
    stage(job, 'Rendering video', 'rendering');
    const args = [
      'tsx', 'src/cli/render.ts', res.storyPath,
      '--project', res.projectId,
      '--engine', 'espeak-ng',
      '--no-word-align', '--no-lip-sync',
    ];
    const code = await new Promise<number>((done) => {
      const p = spawn('npx', args, { cwd: PROJECT_ROOT, stdio: 'ignore' });
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

/** Last N non-empty lines of a job's render log (for live progress in the UI). */
export function renderLogTail(job: Job, n = 10): string {
  if (!job.projectId) return '';
  const log = resolve(PROJECT_ROOT, 'projects', job.projectId, 'media', 'render.log');
  if (!existsSync(log)) return '';
  return readFileSync(log, 'utf8').split('\n').filter((l) => l.trim()).slice(-n).join('\n');
}
