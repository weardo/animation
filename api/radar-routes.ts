// Studio ↔ News Radar bridge. The radar daemon (npm run radar) writes candidates into the shared SQLite
// store; the studio READS the ranked shortlist here and, on the operator's one-click Approve, hands the
// candidate's `angle` straight to the existing job runner (createJob) — the same pipeline the manual
// "Create" tab uses. Dismiss just marks the row. No render/story logic lives here.
import type { Express, Request, Response } from 'express';

import { openStore } from '../radar/store.js';
import type { Candidate } from '../radar/types.js';
import { createJob } from './jobs.js';

/** One shared read/write handle (WAL — safe alongside the daemon's writer). Lazily opened. */
let store: ReturnType<typeof openStore> | null = null;
function radarStore(): ReturnType<typeof openStore> {
  if (!store) store = openStore();
  return store;
}

/** Trim a Candidate to the fields the inbox UI needs (drop the bulky internals). */
function toCard(c: Candidate): Record<string, unknown> {
  return {
    id: c.id,
    title: c.title,
    url: c.url,
    source: c.source,
    lane: c.lane,
    aiScore: c.aiScore,
    indiaFit: c.indiaFit,
    virality: c.virality,
    producible: c.producible,
    whyIndia: c.whyIndia,
    angle: c.angle,
    image: c.image,
    seenAt: c.seenAt,
    stage: c.stage,
    jobId: c.jobId,
  };
}

export function registerRadarRoutes(app: Express): void {
  // The ranked shortlist for the inbox (highest opportunity first). Best-effort: if the radar has never
  // run (no DB yet) this returns an empty list, never an error.
  app.get('/api/radar/candidates', (_req: Request, res: Response) => {
    try {
      const list = radarStore().shortlist({ limit: 40 }).map(toCard);
      res.json({ candidates: list });
    } catch (e) {
      res.json({ candidates: [], error: (e as Error).message });
    }
  });

  // Approve → build. Hands the candidate's `angle` to the existing job runner (unlisted draft), links the
  // job back onto the candidate row so the inbox can show building → done, and returns the new job.
  app.post('/api/radar/:id/approve', (req: Request, res: Response) => {
    const s = radarStore();
    const cand = s.shortlist({ limit: 200 }).find((c) => c.id === req.params.id);
    if (!cand) {
      res.status(404).json({ error: 'candidate not found' });
      return;
    }
    const job = createJob({
      brief: cand.angle || cand.title,
      language: 'Hinglish',
      aspect: '9:16',
      style: 'plain',
      mode: 'story',
    });
    s.attachJob(cand.id, job.id);
    res.json({ jobId: job.id, candidateId: cand.id });
  });

  // Dismiss → mark the row so it drops off the inbox.
  app.post('/api/radar/:id/dismiss', (req: Request, res: Response) => {
    try {
      radarStore().dismiss(req.params.id as string);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}
