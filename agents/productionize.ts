// Production-enrichment pass — makes a GENERATED story (from the Story/Concept Architect) as complete as
// a hand-authored one, so a dashboard build and a manual build are the SAME single premium process. The
// architects emit only beats; this fills the production layer the render + publish steps expect:
//   • a story-level `post` grade (color_grade + grain) — the cinematic-dark polish,
//   • a ducked `music` bed (mandatory per producing-news-reels) — picked deterministically per title,
//   • a COMPLETE `publish` block (real description + tags + hashtags, privacy=unlisted, language=hi-IN) —
//     so the project is upload-ready instead of an empty, private, untagged draft.
// Idempotent: only fills what the architect DID NOT provide (a hand-authored publish/music/post wins).
import type { StoryIR } from '../src/ir/story.js';

/** Vendored royalty-free beds (library/music/) — a moody/tense rotation fitting news + geopolitics. */
const MUSIC_BEDS = ['the-descent', 'tension', 'impact-prelude', 'echoes-of-time-v2', 'ghost-story'] as const;

/** Stable index from a string (build-time; deterministic so re-runs pick the same bed). */
function pick<T>(seed: string, arr: readonly T[]): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return arr[h % arr.length]!;
}

/** Map a Sarvam lang code / human language to a publish BCP-47 `language`. */
function pubLang(lang?: string): string {
  const l = (lang ?? 'hi-IN').toLowerCase();
  if (l.startsWith('en')) return 'en-IN';
  if (l.startsWith('hi') || l.includes('hindi') || l.includes('hinglish')) return 'hi-IN';
  return lang && lang.includes('-') ? lang : 'hi-IN';
}

/** Derive a handful of keyword tags from the title (significant words) + channel defaults. */
function deriveTags(title: string, brief?: string): string[] {
  const stop = new Set(['the', 'and', 'for', 'why', 'how', 'what', 'में', 'का', 'की', 'के', 'और', 'से', 'है']);
  const words = `${title} ${brief ?? ''}`
    .replace(/[|—·:?!.,]/g, ' ')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length > 2 && !stop.has(w.toLowerCase()));
  const uniq = [...new Set(words)].slice(0, 6);
  return [...uniq, 'India Storyboard', 'Hinglish', 'India news', 'geopolitics'];
}

/** Build a non-empty, upload-ready description from the story itself. */
function buildDescription(story: StoryIR): string {
  const hook = story.beats?.[0]?.say?.trim() ?? '';
  return [
    hook,
    'Follow India Storyboard for daily geopolitics + India news, explained in Hinglish. 🇮🇳',
    'Voice — Sarvam Bulbul · b-roll — Pexels · music — Kevin MacLeod (incompetech.com, CC-BY 4.0).',
    'Disclaimer: A news explainer compiled from public reporting; facts per the sources cited at time of publishing.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export interface ProductionizeOptions {
  /** Sarvam lang code (hi-IN / en-IN) — sets the publish language. */
  lang?: string;
  /** The original brief (for tag derivation). */
  brief?: string;
}

/**
 * Mutate a generated Story IR into a production-ready one. Only ADDS the production layer where the
 * architect left it out — never overwrites author-provided post/music/publish fields.
 */
export function productionize(story: StoryIR, opts: ProductionizeOptions = {}): void {
  // 0. Brand: news reels default to the India Storyboard stylekit (persistent bug + end-card, same flat
  // footage-forward look as `plain`). Leave a deliberately-chosen non-plain style (e.g. concept videos'
  // `kurzgesagt`) alone. So every generated reel is on-brand automatically.
  if (!story.style || story.style === 'plain') story.style = 'india-storyboard';

  // 1. Cinematic-dark post grade (color_grade + grain; NO vignette by default — skill §Depth).
  if (!story.post || story.post.length === 0) {
    story.post = [
      { kind: 'color_grade', contrast: 1.12, saturate: 1.03 },
      { kind: 'grain', amount: 0.05 },
    ] as StoryIR['post'];
  }

  // 2. Ducked music bed (mandatory) — a deterministic pick so a given story always gets the same bed.
  // Levels per producing-news-reels: gain 0.6 / duck 0.32. The old 0.24/0.12 was inaudible — ducked to
  // ~-34 dB under the VO across a mostly-narrated reel, so the bed effectively vanished (user-reported).
  if (!story.music) {
    const bed = pick(story.title, MUSIC_BEDS);
    story.music = { ref: `library/music/${bed}.mp3`, gain: 0.6, duck: 0.32, fade: 16 };
  }

  // 2b. Beat polish: a fade transition between beats (smooth, not hard cuts) + a soft whoosh on each cut
  // (NEVER `riser` — user-banned in reels). Only where the architect left them out.
  story.beats.forEach((beat, i) => {
    const b2 = beat as { transition?: unknown; sfx?: unknown[] };
    if (i > 0 && b2.transition === undefined) b2.transition = { kind: 'fade', duration: 14 };
    if (i > 0 && (!b2.sfx || b2.sfx.length === 0)) b2.sfx = [{ name: 'whoosh', at: 1 }];
  });

  // 3. Complete, upload-ready publish block — fill only the gaps the architect left.
  const p = (story.publish ?? {}) as NonNullable<StoryIR['publish']>;
  story.publish = {
    title: p.title || story.title,
    description: p.description && p.description.trim() ? p.description : buildDescription(story),
    tags: p.tags && p.tags.length ? p.tags : deriveTags(story.title, opts.brief),
    hashtags: p.hashtags && p.hashtags.length ? p.hashtags : ['IndiaStoryboard', 'geopolitics', 'IndiaNews'],
    category: p.category || 'News & Politics',
    language: p.language && p.language !== 'hi' ? p.language : pubLang(opts.lang),
    privacy: p.privacy && p.privacy !== 'private' ? p.privacy : 'unlisted',
    ...(p.caption_language ? { caption_language: p.caption_language } : {}),
    ...(p.credits ? { credits: p.credits } : {}),
    ...(p.thumbnail ? { thumbnail: p.thumbnail } : {}),
    ...(p.playlist ? { playlist: p.playlist } : {}),
    made_for_kids: p.made_for_kids ?? false,
    license: p.license || 'standard',
  };
}
