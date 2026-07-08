// Asset Scout — the specialist that turns the Story Architect's VISUAL INTENT into real footage. The
// architect emits a background footage item per beat with a `q:<search phrase>` placeholder; the scout
// resolves each to an actual stock clip (Pexels, proxy-transcoded + cataloged) and swaps the placeholder
// for the asset id the render resolves. Failures degrade gracefully — the footage item is dropped and
// the beat falls back to text on the styled background (never a broken render).
import { pickFootage } from '../src/cli/footage.js';
import type { StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT } from './claude.js';

type Orientation = 'portrait' | 'landscape' | 'square';

function orientationForAspect(aspect?: string): Orientation {
  if (aspect === '16:9') return 'landscape';
  if (aspect === '1:1') return 'square';
  return 'portrait';
}

function slugQuery(q: string): string {
  return ('bg-' + q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 36);
}

export interface ScoutResult {
  resolved: number;
  failed: number;
}

/**
 * Resolve every `footage: "q:<query>"` placeholder in the story to a real fetched clip. Mutates the
 * story in place. Deduplicates identical queries within the story; drops the footage item on failure.
 */
export async function resolveVisuals(story: StoryIR, aspect?: string): Promise<ScoutResult> {
  const orientation = orientationForAspect(aspect);
  const seen = new Map<string, string | null>(); // query → resolved asset id (or null = failed)
  let resolved = 0;
  let failed = 0;

  for (const beat of story.beats) {
    if (!beat.show) continue;
    const kept: NonNullable<typeof beat.show> = [];
    for (const item of beat.show) {
      const fv = typeof item.footage === 'string' ? item.footage : '';
      if (!fv.startsWith('q:')) {
        kept.push(item);
        continue;
      }
      const query = fv.slice(2).trim();
      let id = seen.get(query);
      if (id === undefined) {
        try {
          const r = await pickFootage({ query, id: slugQuery(query), orientation, rootDir: PROJECT_ROOT });
          id = r.id;
          resolved += 1;
        } catch {
          id = null;
          failed += 1;
        }
        seen.set(query, id);
      }
      if (id) kept.push({ ...item, footage: id });
      // else: drop the footage item → the beat renders text over the styled background
    }
    beat.show = kept;
  }
  return { resolved, failed };
}
