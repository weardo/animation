// Orchestrator (P1 walking skeleton) — runs the specialist pipeline for a brief. For now that is just
// the Story Architect (brief → Story IR → story.yaml); the render is triggered separately (async job).
// P2 inserts the Asset Scout / Map Designer / Audio Designer / Assembler + verify gates between here and
// the render, each as another stage on this spine.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import { resolveVisuals } from './asset-scout.js';
import { PROJECT_ROOT } from './claude.js';
import { runConceptArchitect } from './concept-architect.js';
import { runStoryArchitect, type StoryBrief } from './story-architect.js';

// "explain X", "how X works", "what is X", "why does X" → a concept/teaching video (real simulation).
function looksLikeConcept(brief: string): boolean {
  return /\b(explain|teach me|how (does|do|is|are|a |an )|how\s+\w+\s+works?|what (is|are)|why (does|do|is|are)|the concept of)\b/i.test(
    brief,
  );
}

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
  visualsResolved: number;
  visualsFailed: number;
}

/** Brief → Story IR (footage explainer OR concept simulation) → projects/<id>/story.yaml. */
export async function orchestrateBrief(b: StoryBrief, projectId?: string): Promise<OrchestrateResult> {
  const useConcept = b.mode === 'concept' || (b.mode !== 'story' && looksLikeConcept(b.brief));

  // Build the Story IR (+ any async visual resolution) via the chosen path.
  let story;
  let cached: boolean;
  let attempts: number;
  let visualsResolved: number;
  let visualsFailed = 0;
  if (useConcept) {
    // Concept path: the Concept Architect writes teaching narration + per-beat `sim` code (real physics).
    // The simulation IS the visual — no footage scout.
    const arch = await runConceptArchitect({
      brief: b.brief,
      ...(b.aspect ? { aspect: b.aspect } : {}),
      ...(b.language ? { language: b.language } : {}),
      ...(b.targetSeconds ? { targetSeconds: b.targetSeconds } : {}),
    });
    story = arch.story;
    cached = arch.cached;
    attempts = arch.attempts;
    visualsResolved = arch.story.beats.filter((be) =>
      (be.show ?? []).some((it) => (it as { generator?: string }).generator === 'sim'),
    ).length;
  } else {
    // Story path: the Story Architect + the Asset Scout (real footage per beat).
    const arch = await runStoryArchitect(b);
    const scout = await resolveVisuals(arch.story, b.aspect);
    story = arch.story;
    cached = arch.cached;
    attempts = arch.attempts;
    visualsResolved = scout.resolved;
    visualsFailed = scout.failed;
  }

  const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 6);
  const id = projectId ?? `gen-${slug(story.title)}-${hash}`;
  const dir = resolve(PROJECT_ROOT, 'projects', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, 'story.yaml'), stringifyYaml(story), 'utf8');
  return {
    projectId: id,
    storyPath: `projects/${id}/story.yaml`,
    title: story.title,
    beats: story.beats.length,
    cached,
    attempts,
    visualsResolved,
    visualsFailed,
  };
}
