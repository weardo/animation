// The local self-hosted API + static web server (P1). Serves the web UI and the job API. Single-user,
// localhost-first — no auth, no cloud. `npm run studio` → http://localhost:5055.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import express, { type Request, type Response } from 'express';

import { PROJECT_ROOT } from '../agents/claude.js';
import { loadDotenv } from './env.js';
import { createJob, getJob, listJobs, publishProject, renderLogTail, type Job } from './jobs.js';

loadDotenv(); // pull .env (SARVAM_API_KEY, …) into process.env before any job spawns a render

const app = express();
app.use(express.json());
app.use(express.static(resolve(PROJECT_ROOT, 'web')));

const summary = (j: Job) => ({ id: j.id, title: j.title ?? '(untitled)', status: j.status, createdAt: j.createdAt });

// Submit a brief → a new job (renders in the background).
app.post('/api/jobs', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const brief = typeof body['brief'] === 'string' ? body['brief'].trim() : '';
  if (!brief) {
    res.status(400).json({ error: 'brief is required' });
    return;
  }
  const job = createJob({
    brief,
    ...(typeof body['aspect'] === 'string' ? { aspect: body['aspect'] as '9:16' | '16:9' | '1:1' } : {}),
    ...(typeof body['style'] === 'string' ? { style: body['style'] as 'kurzgesagt' | 'plain' } : {}),
    ...(typeof body['language'] === 'string' ? { language: body['language'] } : {}),
    ...(typeof body['targetSeconds'] === 'number' ? { targetSeconds: body['targetSeconds'] } : {}),
    ...(typeof body['mode'] === 'string' ? { mode: body['mode'] as 'auto' | 'story' | 'concept' } : {}),
  });
  res.json({ id: job.id });
});

// List past jobs (the Projects screen).
app.get('/api/jobs', (_req: Request, res: Response) => {
  res.json(listJobs().map(summary));
});

// Poll one job (status + stages + live render-log tail).
app.get('/api/jobs/:id', (req: Request, res: Response) => {
  const job = getJob(String(req.params['id']));
  if (!job) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json({ ...job, log: renderLogTail(job) });
});

// Stream the finished video (supports range requests → the <video> tag can seek).
app.get('/api/jobs/:id/video', (req: Request, res: Response) => {
  const job = getJob(String(req.params['id']));
  const abs = job?.outputRel ? resolve(PROJECT_ROOT, job.outputRel) : '';
  if (!abs || !existsSync(abs)) {
    res.status(404).json({ error: 'no video yet' });
    return;
  }
  res.sendFile(abs);
});

// Settings / first-run setup: which integrations are configured (keys present)?
app.get('/api/config', (_req: Request, res: Response) => {
  res.json({
    keys: {
      sarvam: Boolean(process.env['SARVAM_API_KEY']),
      pexels: Boolean(process.env['PEXELS_API_KEY']),
    },
    narrationEngine: process.env['SARVAM_API_KEY'] ? 'sarvam' : 'espeak-ng (fallback)',
    visuals: process.env['PEXELS_API_KEY'] ? 'footage on' : 'footage off (no PEXELS_API_KEY)',
  });
});

// Publish a finished video to YouTube (dry-run unless { confirm: true }).
app.post('/api/jobs/:id/publish', (req: Request, res: Response) => {
  const job = getJob(String(req.params['id']));
  if (!job?.projectId || !job.outputRel) {
    res.status(400).json({ error: 'no rendered video to publish' });
    return;
  }
  const confirm = ((req.body ?? {}) as { confirm?: unknown }).confirm === true;
  publishProject(job.projectId, confirm)
    .then((r) => res.json(r))
    .catch((e: Error) => res.status(500).json({ status: 'failed', output: e.message }));
});

const PORT = Number(process.env['PORT'] ?? 5055);
// Bind to loopback ONLY — this is a single-user local app with no auth; never expose it on 0.0.0.0.
app.listen(PORT, '127.0.0.1', () => {
  process.stdout.write(`[studio] Animation Factory — http://localhost:${PORT}\n`);
});
