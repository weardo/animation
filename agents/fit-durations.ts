// Fit each beat's on-screen duration to its ACTUAL narration length so the video never cuts off
// mid-sentence. Sarvam's output length varies and can't be estimated up front, so we synth-or-cache the
// narration once (content-addressed) and READ the real duration — then set beat.duration = narration +
// a small tail. The wavs land in the project's assets/audio with the SAME params the render uses, so the
// render's narrate pass reuses them (no double synth). The recipe from producing-news-reels §7.
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { synthNarration, DEFAULT_VOICE, DEFAULT_WPM, type NarrateEngine } from '../src/cli/narrate.js';
import type { StoryIR } from '../src/ir/story.js';
import { PROJECT_ROOT } from './claude.js';

export interface FitOptions {
  engine?: NarrateEngine;
  lang?: string; // sarvam target language (en-IN/hi-IN); must match the render's SARVAM_LANG
  tailSeconds?: number;
}

/** Mutates the story: every beat with `say` gets duration = ceil(narration seconds + tail). */
export function fitDurations(story: StoryIR, projectId: string, opts: FitOptions = {}): void {
  const engine = opts.engine ?? 'sarvam';
  const tail = opts.tailSeconds ?? 1.2;
  const audioDir = resolve(PROJECT_ROOT, 'projects', projectId, 'assets', 'audio');
  mkdirSync(audioDir, { recursive: true });

  for (const beat of story.beats) {
    if (!beat.say) continue;
    try {
      const res = synthNarration(
        {
          text: beat.say,
          engine,
          voice: DEFAULT_VOICE[engine],
          wpm: DEFAULT_WPM,
          ...(engine === 'sarvam' && opts.lang ? { lang: opts.lang } : {}),
        },
        audioDir,
        PROJECT_ROOT,
      );
      beat.duration = { seconds: Math.max(2, Math.ceil(res.durationSeconds + tail)) };
    } catch {
      /* keep the authored duration if synth fails (never worse than before) */
    }
  }
}
