// Asset Scout — the specialist that turns the Story Architect's VISUAL INTENT into real footage. The
// architect emits a background footage item per beat with a `q:<search phrase>` placeholder; the scout
// resolves each to an actual stock clip (Pexels, proxy-transcoded + cataloged) and swaps the placeholder
// for the asset id the render resolves. Failures degrade gracefully — the footage item is dropped and
// the beat falls back to text on the styled background (never a broken render).
import { createHash } from 'node:crypto';

import { pickFootage } from '../src/cli/footage.js';
import { generateImage } from '../src/cli/imagegen.js';
import { fetchNewsclip, searchClipUrl } from '../src/cli/newsclip.js';
import { captureNewsshot } from '../src/cli/newsshot.js';
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

/** A file-safe [a-z0-9_] catalog id for a generated illustration, content-addressed by its prompt. */
function genId(prompt: string): string {
  return 'gen_' + createHash('sha256').update(prompt).digest('hex').slice(0, 12);
}

/** Pixel size for a generated image by aspect (rendered fit:cover, so exact ratio isn't critical). */
function genSize(orientation: Orientation): { width: number; height: number } {
  if (orientation === 'landscape') return { width: 1344, height: 768 };
  if (orientation === 'square') return { width: 1024, height: 1024 };
  return { width: 768, height: 1344 };
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
  const seenShot = new Map<string, string | null>(); // newsshot url → resolved screenshot asset id
  const seenGen = new Map<string, string | null>(); // gen prompt → resolved generated-illustration asset id
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
      const av = typeof (item as { asset?: unknown }).asset === 'string' ? (item as { asset: string }).asset : '';
      // A `asset: "newsshot:<url>"` placeholder → a REAL SCREENSHOT of the source article/report (data
      // EVIDENCE: "here's the actual source"). Captured offline (content-addressed PNG), rendered as a
      // Ken Burns still. Falls back to the beat's `fallback_q` footage if the capture fails.
      if (av.startsWith('newsshot:')) {
        const url = av.slice('newsshot:'.length).trim();
        let sid = seenShot.get(url);
        if (sid === undefined) {
          try {
            const r = await captureNewsshot({ url, rootDir: PROJECT_ROOT });
            sid = r.id;
            resolved += 1;
          } catch {
            sid = null;
            failed += 1;
          }
          seenShot.set(url, sid);
        }
        if (sid) {
          const a = { ...((item.args as Record<string, unknown>) ?? {}) };
          delete a['fallback_q'];
          // A CITATION must stay READABLE: show the WHOLE screenshot ('contain', never crop it) and
          // 'out-slow' so it SETTLES to fully-visible instead of zooming IN (which crops off the content).
          if (a['fit'] === undefined) a['fit'] = 'contain';
          if (a['kenburns'] === undefined) a['kenburns'] = 'out-slow';
          kept.push({ ...(item as object), asset: sid, at: 'center', args: a } as (typeof kept)[number]);
          hasFootage = true;
          continue;
        }
        // capture failed → try the beat's fallback footage, else drop to text (handled by shared code below)
        const fb0 = typeof (item.args as { fallback_q?: unknown } | undefined)?.fallback_q === 'string'
          ? (item.args as { fallback_q: string }).fallback_q.trim()
          : '';
        if (fb0) {
          let fid = seen.get(fb0);
          if (fid === undefined) {
            try { fid = (await pickFootage({ query: fb0, id: slugQuery(fb0), orientation, rootDir: PROJECT_ROOT })).id; resolved += 1; }
            catch { fid = null; }
            seen.set(fb0, fid);
          }
          if (fid) {
            const a = { ...((item.args as Record<string, unknown>) ?? {}) };
            delete a['fallback_q']; delete a['kenburns'];
            if (a['fit'] === undefined) a['fit'] = 'cover';
            a['loop'] = true; a['muted'] = true;
            kept.push({ ...(item as object), asset: undefined, footage: fid, at: 'center', args: a } as (typeof kept)[number]);
            hasFootage = true;
          }
        }
        continue;
      }
      // A `asset: "wiki:<subject>"` placeholder → a REAL Wikimedia image (the actual person/place/event),
      // rendered as a Ken Burns still. This is how hard-news subjects that stock footage never carries
      // (a named leader, a specific building, an event) get real visuals. Falls back gracefully.
      if (av.startsWith('wiki:')) {
        const subject = av.slice(5).trim();
        let wid = seenWiki.get(subject);
        if (wid === undefined) {
          try {
            // 'any' orientation: a REAL photo of the subject (often a landscape portrait) beats dropping it
            // for aspect — ken-burns "in" + fit "cover" crops it to the 9:16 frame either way.
            const r = await pickPhoto({ query: subject, source: 'wikimedia', id: slugSubject(subject), orientation: 'any', rootDir: PROJECT_ROOT });
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
          delete a['fallback_q']; // consumed here — never leak into the asset layer args
          if (a['kenburns'] === undefined) a['kenburns'] = 'in';
          if (a['fit'] === undefined) a['fit'] = 'cover';
          kept.push({ ...(item as object), asset: wid, at: 'center', args: a } as (typeof kept)[number]);
          hasFootage = true; // a full-frame still — treat like footage for the camera-safety downgrade
          continue;
        }
        // No free photo for this subject (common for militant leaders / obscure people). Rather than leave
        // a bare dark frame, fall back to the beat's `fallback_q` footage so it still has a real background.
        const fb = typeof (item.args as { fallback_q?: unknown } | undefined)?.fallback_q === 'string'
          ? (item.args as { fallback_q: string }).fallback_q.trim()
          : '';
        if (fb) {
          let fid = seen.get(fb);
          if (fid === undefined) {
            try {
              const r = await pickFootage({ query: fb, id: slugQuery(fb), orientation, rootDir: PROJECT_ROOT });
              fid = r.id;
              resolved += 1;
            } catch {
              fid = null;
            }
            seen.set(fb, fid);
          }
          if (fid) {
            const a = { ...((item.args as Record<string, unknown>) ?? {}) };
            delete a['fallback_q'];
            delete a['kenburns']; // it's now a video, not a ken-burns still
            if (a['fit'] === undefined) a['fit'] = 'cover';
            a['loop'] = true;
            a['muted'] = true;
            kept.push({ ...(item as object), asset: undefined, footage: fid, at: 'center', args: a } as (typeof kept)[number]);
            hasFootage = true;
          }
        }
        // else: drop → the beat renders text over the styled background
        continue;
      }
      // A `asset: "gen:<prompt>"` placeholder → an AI-GENERATED illustration from the FREE FLUX provider
      // pool (Cloudflare → HF → Pollinations → AI Horde). For an ABSTRACT/CONCEPTUAL beat where no real
      // photo/footage fits (economics, policy, a concept) or a stylized scene. Cached content-addressed;
      // falls back to `fallback_q` footage if every provider fails.
      if (av.startsWith('gen:')) {
        const prompt = av.slice(4).trim();
        let gid = seenGen.get(prompt);
        if (gid === undefined) {
          try {
            const id = genId(prompt);
            await generateImage({ prompt, id, rootDir: PROJECT_ROOT, ...genSize(orientation) });
            gid = id;
            resolved += 1;
          } catch {
            gid = null;
            failed += 1;
          }
          seenGen.set(prompt, gid);
        }
        if (gid) {
          const a = { ...((item.args as Record<string, unknown>) ?? {}) };
          delete a['fallback_q'];
          if (a['kenburns'] === undefined) a['kenburns'] = 'in';
          if (a['fit'] === undefined) a['fit'] = 'cover';
          kept.push({ ...(item as object), asset: gid, at: 'center', args: a } as (typeof kept)[number]);
          hasFootage = true;
          continue;
        }
        // All providers failed (rare — two keyless backstops) → the beat's fallback footage, else text.
        const fbg = typeof (item.args as { fallback_q?: unknown } | undefined)?.fallback_q === 'string'
          ? (item.args as { fallback_q: string }).fallback_q.trim()
          : '';
        if (fbg) {
          let fid = seen.get(fbg);
          if (fid === undefined) {
            try { fid = (await pickFootage({ query: fbg, id: slugQuery(fbg), orientation, rootDir: PROJECT_ROOT })).id; resolved += 1; }
            catch { fid = null; }
            seen.set(fbg, fid);
          }
          if (fid) {
            const a = { ...((item.args as Record<string, unknown>) ?? {}) };
            delete a['fallback_q']; delete a['kenburns'];
            if (a['fit'] === undefined) a['fit'] = 'cover';
            a['loop'] = true; a['muted'] = true;
            kept.push({ ...(item as object), asset: undefined, footage: fid, at: 'center', args: a } as (typeof kept)[number]);
            hasFootage = true;
          }
        }
        continue;
      }
      const fv = typeof item.footage === 'string' ? item.footage : '';
      // A `footage: "clip:<search>"` placeholder → the REAL public news/social VIDEO of a statement / event /
      // viral moment (yt-dlp search → download a short section → footage). This is the EVIDENCE for a "here's
      // the actual clip" beat — far better than stock footage. Falls back to a stock search of the query.
      if (fv.startsWith('clip:')) {
        const query = fv.slice(5).trim();
        const kkey = 'clip:' + query;
        let cid = seen.get(kkey);
        if (cid === undefined) {
          try {
            const hit = searchClipUrl(query);
            if (hit) {
              const r = await fetchNewsclip({ url: hit.url, id: slugQuery(query), duration: 15, rootDir: PROJECT_ROOT });
              cid = r.id;
              resolved += 1;
            } else {
              cid = null;
              failed += 1;
            }
          } catch {
            cid = null;
            failed += 1;
          }
          seen.set(kkey, cid);
        }
        if (cid) {
          const a = { ...((item.args as Record<string, unknown>) ?? {}) };
          if (a['fit'] === undefined) a['fit'] = 'cover';
          a['loop'] = true;
          if (a['muted'] === undefined) a['muted'] = true; // a gaffe clip often WANTS its audio — architect can set muted:false
          kept.push({ ...(item as object), footage: cid, at: 'center', args: a } as (typeof kept)[number]);
          hasFootage = true;
          continue;
        }
        // No clip found → fall through to a stock footage search of the query below.
      }
      if (!fv.startsWith('q:') && !fv.startsWith('clip:')) {
        kept.push(item);
        continue;
      }
      // A `q:<query>` footage item, OR a `clip:<query>` that found no real video (fall back to stock).
      const query = fv.startsWith('clip:') ? fv.slice(5).trim() : fv.slice(2).trim();
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
