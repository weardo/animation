// Asset Scout — the specialist that turns the Story Architect's VISUAL INTENT into real footage. The
// architect emits a background footage item per beat with a `q:<search phrase>` placeholder; the scout
// resolves each to an actual stock clip (Pexels, proxy-transcoded + cataloged) and swaps the placeholder
// for the asset id the render resolves. Failures degrade gracefully — the footage item is dropped and
// the beat falls back to text on the styled background (never a broken render).
import { pickFootage } from '../src/cli/footage.js';
import { pickPhoto } from '../src/cli/photo.js';
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

function slugSubject(q: string): string {
  return ('img-' + q.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')).slice(0, 40);
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
  const seen = new Map<string, string | null>(); // footage query → resolved asset id (or null = failed)
  const seenWiki = new Map<string, string | null>(); // wiki subject → resolved image asset id
  let resolved = 0;
  let failed = 0;

  // Camera moves that zoom out or pan expose the frame edge past a frame-filling clip → an ugly border.
  // Push-in/hold never do (they only zoom IN). Downgrade the rest on any beat that has a footage bg.
  const SAFE_ON_FOOTAGE = new Set(['slow_push_in', 'hold']);

  for (const beat of story.beats) {
    if (!beat.show) continue;
    const kept: NonNullable<typeof beat.show> = [];
    let hasFootage = false;
    for (const item of beat.show) {
      // A `asset: "wiki:<subject>"` placeholder → a REAL Wikimedia image (the actual person/place/event),
      // rendered as a Ken Burns still. This is how hard-news subjects that stock footage never carries
      // (a named leader, a specific building, an event) get real visuals. Falls back gracefully.
      const av = typeof (item as { asset?: unknown }).asset === 'string' ? (item as { asset: string }).asset : '';
      if (av.startsWith('wiki:')) {
        const subject = av.slice(5).trim();
        let wid = seenWiki.get(subject);
        if (wid === undefined) {
          try {
            const photoOrient = orientation === 'square' ? 'any' : orientation;
            const r = await pickPhoto({ query: subject, source: 'wikimedia', id: slugSubject(subject), orientation: photoOrient, rootDir: PROJECT_ROOT });
            wid = slugSubject(subject);
            void r;
            resolved += 1;
          } catch {
            wid = null;
            failed += 1;
          }
          seenWiki.set(subject, wid);
        }
        if (wid) {
          const a = { ...((item.args as Record<string, unknown>) ?? {}) };
          if (a['kenburns'] === undefined) a['kenburns'] = 'in';
          if (a['fit'] === undefined) a['fit'] = 'cover';
          kept.push({ ...(item as object), asset: wid, at: 'center', args: a } as (typeof kept)[number]);
          hasFootage = true; // a full-frame still — treat like footage for the camera-safety downgrade
        }
        // else: drop → the beat renders text over the styled background
        continue;
      }
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
      if (id) {
        const a = { ...((item.args as Record<string, unknown>) ?? {}) };
        if (a['fit'] === undefined) a['fit'] = 'cover';
        // Anchor the bg to CENTER so the layout director doesn't place it at a focal slot (which shoved
        // it 256px below centre → an uncovered band at the top). Centered + fit:cover fills the frame.
        kept.push({ ...item, footage: id, at: 'center', args: a });
        hasFootage = true;
      }
      // else: drop the footage item → the beat renders text over the styled background
    }
    beat.show = kept;
    // Force a safe camera on footage beats so the clip always covers the frame.
    if (hasFootage && (typeof beat.camera !== 'string' || !SAFE_ON_FOOTAGE.has(beat.camera))) {
      beat.camera = 'slow_push_in';
    }
  }
  return { resolved, failed };
}
