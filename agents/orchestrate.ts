// Orchestrator (P1 walking skeleton) — runs the specialist pipeline for a brief. For now that is just
// the Story Architect (brief → Story IR → story.yaml); the render is triggered separately (async job).
// P2 inserts the Asset Scout / Map Designer / Audio Designer / Assembler + verify gates between here and
// the render, each as another stage on this spine.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { PROJECT_ROOT } from './claude.js';
import { runStoryArchitect, type StoryBrief } from './story-architect.js';

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'video';
}

export interface OrchestrateResult {
  projectId: string;
  storyPath: string; // repo-relative (what the render CLI takes as its target)
  title: string;
  beats: number;
  cached: boolean;
  attempts: number;
}

/** Brief → Story IR → projects/<id>/story.yaml. Deterministic id derived from the brief. */
export function orchestrateBrief(b: StoryBrief, projectId?: string): OrchestrateResult {
  const arch = runStoryArchitect(b);
  const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 6);
  const id = projectId ?? `gen-${slug(arch.story.title)}-${hash}`;
  const dir = resolve(PROJECT_ROOT, 'projects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'story.yaml'), stringifyYaml(arch.story), 'utf8');
  return {
    projectId: id,
    storyPath: `projects/${id}/story.yaml`,
    title: arch.story.title,
    beats: arch.story.beats.length,
    cached: arch.cached,
    attempts: arch.attempts,
  };
}
