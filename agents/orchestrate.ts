// Orchestrator (P1 walking skeleton) — runs the specialist pipeline for a brief. For now that is just
// the Story Architect (brief → Story IR → story.yaml); the render is triggered separately (async job).
// P2 inserts the Asset Scout / Map Designer / Audio Designer / Assembler + verify gates between here and
// the render, each as another stage on this spine.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import type { StoryIR } from '../src/ir/story.js';
import { resolveVisuals } from './asset-scout.js';
import { PROJECT_ROOT } from './claude.js';
import { runConceptArchitect, type ConceptBrief } from './concept-architect.js';
import { fitDurations } from './fit-durations.js';
import { progress } from './progress.js';
import { productionize } from './productionize.js';
import { research, type FactSheet, PROMPT_VERSION as RESEARCH_VERSION } from './research.js';
import { runStoryArchitect, type StoryBrief, PROMPT_VERSION as ARCHITECT_VERSION } from './story-architect.js';
import { visualVerify } from './visual-verify.js';

function conceptBriefFrom(b: StoryBrief, feedback?: string): ConceptBrief {
  return {
    brief: b.brief,
    ...(b.aspect ? { aspect: b.aspect } : {}),
    ...(b.language ? { language: b.language } : {}),
    ...(b.targetSeconds ? { targetSeconds: b.targetSeconds } : {}),
    ...(feedback ? { feedback } : {}),
  };
}

// "explain X", "how X works", "what is X", "why does X" → a concept/teaching video (real simulation).
function looksLikeConcept(brief: string): boolean {
  return /\b(explain|teach me|how (does|do|is|are|a |an )|how\s+\w+\s+works?|what (is|are)|why (does|do|is|are)|the concept of)\b/i.test(
    brief,
  );
}

/**
 * Record WHERE this video came from — the news point, the brief, the gathered facts, and the pipeline
 * versions — into projects/<id>/source.json. Durable provenance: survives a Radar DB rollover, so a
 * finished video is always traceable back to its source article + the facts it was built on.
 */
function writeProvenance(id: string, b: StoryBrief, factSheet?: FactSheet): void {
  const rec = {
    generatedAt: new Date().toISOString(),
    brief: b.brief,
    language: b.language ?? null,
    aspect: b.aspect ?? '9:16',
    source: {
      url: b.sourceUrl ?? null,
      summary: b.sourceSummary ?? null,
      radar: b.radar ?? null, // candidate id, raw headline, publisher, angle, scores, whyIndia
    },
    facts: factSheet
      ? {
          headline: factSheet.headline,
          when: factSheet.when,
          confidence: factSheet.confidence,
          keyNumbers: factSheet.keyNumbers,
          sources: factSheet.sources,
        }
      : null,
    pipeline: { research: RESEARCH_VERSION, architect: ARCHITECT_VERSION },
  };
  writeFileSync(resolve(PROJECT_ROOT, 'projects', id, 'source.json'), JSON.stringify(rec, null, 2) + '\n', 'utf8');
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
  const hash = createHash('sha256').update(JSON.stringify(b)).digest('hex').slice(0, 6);
  const lang = process.env['SARVAM_LANG'];

  // Write story.yaml for a project id, fitting each beat's duration to its real narration length first
  // (so the video never cuts off mid-sentence — producing-news-reels §7).
  const writeStory = (id: string, story: StoryIR): void => {
    mkdirSync(resolve(PROJECT_ROOT, 'projects', id), { recursive: true });
    // Make a generated story as complete as a hand-authored one (post grade + music bed + a real,
    // upload-ready publish block) BEFORE timing — so a dashboard build === a manual build (one process).
    productionize(story, { ...(lang ? { lang } : {}), brief: b.brief });
    fitDurations(story, id, { ...(lang ? { lang } : {}) });
    writeFileSync(resolve(PROJECT_ROOT, 'projects', id, 'story.yaml'), stringifyYaml(story), 'utf8');
  };
  const simCount = (story: StoryIR): number =>
    story.beats.filter((be) => (be.show ?? []).some((it) => (it as { generator?: string }).generator === 'sim')).length;

  if (useConcept) {
    // Concept path: Concept Architect (real-physics sim) → VISUAL VERIFY loop. After writing the story
    // we render the beats to stills and a model LOOKS at the geometry; if a shadow/rope/etc. doesn't
    // connect (or something is off-screen), we regenerate feeding the visual critique back. One retry.
    progress('Writing the script + designing the simulation…');
    let arch = await runConceptArchitect(conceptBriefFrom(b));
    const id = projectId ?? `gen-${slug(arch.story.title)}-${hash}`;
    progress(`Script ready · ${arch.story.beats.length} steps · timing the narration…`);
    writeStory(id, arch.story);
    writeProvenance(id, b); // concept/sim video — no news fact sheet, still record brief + source
    let attempts = arch.attempts;
    let problems = await visualVerify(id, b.brief);
    for (let v = 0; problems.length > 0 && v < 1; v++) {
      progress(`Found ${problems.length} visual issue(s) — fixing the geometry…`);
      arch = await runConceptArchitect(conceptBriefFrom(b, problems.join('\n')));
      attempts += arch.attempts;
      writeStory(id, arch.story);
      progress('Re-reviewing the corrected diagrams…');
      problems = await visualVerify(id, b.brief);
    }
    progress(problems.length ? 'Visuals reviewed — starting the render…' : 'Visuals verified ✓ — starting the render…');
    return {
      projectId: id,
      storyPath: `projects/${id}/story.yaml`,
      title: arch.story.title,
      beats: arch.story.beats.length,
      cached: arch.cached,
      attempts,
      visualsResolved: simCount(arch.story),
      visualsFailed: problems.length,
    };
  }

  // Story path: RESEARCH → the Story Architect (fact-grounded) → the Asset Scout (real footage per beat).
  // Facts first (user rule): gather the real what/when/where/who/numbers/timeline BEFORE writing a word, so
  // the narration is specific + chronological, not vague. The fact sheet also decides if a MAP belongs.
  progress('Researching the facts…');
  const factSheet = await research(b.brief, {
    ...(b.sourceUrl ? { sourceUrl: b.sourceUrl } : {}),
    ...(b.sourceSummary ? { sourceSummary: b.sourceSummary } : {}),
    ...(lang ? { lang } : {}),
  });
  progress(`Facts gathered (${factSheet.confidence}${factSheet.needsMap ? ' · map' : ''}) · writing the script…`);
  const arch = await runStoryArchitect({ ...b, factSheet });
  progress(`Script ready · ${arch.story.beats.length} beats · fetching footage…`);
  const scout = await resolveVisuals(arch.story, b.aspect);
  const id = projectId ?? `gen-${slug(arch.story.title)}-${hash}`;
  writeStory(id, arch.story);
  writeProvenance(id, b, factSheet);
  return {
    projectId: id,
    storyPath: `projects/${id}/story.yaml`,
    title: arch.story.title,
    beats: arch.story.beats.length,
    cached: arch.cached,
    attempts: arch.attempts,
    visualsResolved: scout.resolved,
    visualsFailed: scout.failed,
  };
}
