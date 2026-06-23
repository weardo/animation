// music.ts — OFFLINE music-bed synthesis (A3). Golden rule 2: audio NEVER touches frames or the
// runtime — a music bed, like narration + SFX + the vendored font, is produced OFFLINE at BUILD time,
// cached to a deterministic .wav, then LOOPED by Remotion <Audio loop> under the whole video. No
// external sourcing: each bed is SYNTHESIZED from `ffmpeg`'s `lavfi` math sources (stacked sine
// partials + a slow tremolo + soft filtering), so the factory ships a tiny CC0-clean ambient palette
// with zero downloads (golden rules: determinism + offline + disk-safe).
//
// SHARED LIBRARY CACHE: synthesized beds live in `library/music/<name>.wav` (a shared, content-stable
// catalog reused across projects — keyed by the NAMED bed since a recipe is fixed DATA), exactly like
// SFX. The music pass then COPIES the cached wav into the project's self-contained `assets/audio/` and
// references it by an `audio://` cue src (resolved at render with staticFile). The bed is short (a few
// seconds) and LOOPED at render to fill the timeline, so the cached file stays tiny (disk-safe) while
// the track covers any length. skip-if-exists makes re-runs reuse the same bytes → byte-identical
// audio stream (golden rule 1).
//
// This module is PURE I/O at build time: it never runs at render. ffmpeg is the adopted encoder
// (ADR-003: never reimplement a media primitive) — here also the deterministic tone generator.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/**
 * A built-in MUSIC-BED recipe: a NAME → a deterministic `ffmpeg -filter_complex` graph + its loop
 * length. Each graph builds a short, seamless-ish ambient pad from PURE-MATH lavfi sources (`sine`
 * partials mixed + a slow `tremolo`/`vibrato` + gentle `lowpass`), so the same name always yields the
 * same wav (caching by name is sound; golden rule 1) and there is NO random/noise seed that could
 * drift run-to-run. The bed is intentionally LOW-LEVEL (it is mixed UNDER narration at `gain` and
 * ducked further while speaking) and SHORT — the renderer loops it to fill the timeline.
 */
interface MusicRecipe {
  /** The ffmpeg `-filter_complex` graph producing a single mono [out] stream. */
  graph: string;
  /** Loop length in seconds (the cached wav's duration; <Audio loop> repeats it). */
  dur: number;
}

/**
 * The built-in music palette. Each is a short, loopable ambient bed synthesized from math:
 *   • calm   — a soft major-triad pad (root+third+fifth) with a slow tremolo → a gentle, warm bed.
 *   • drone  — a low root+octave drone with a slow vibrato → a tense/serious undercurrent.
 *   • uplift — a brighter stacked-fifths pad with a faster shimmer → a hopeful, lifting bed.
 * All deterministic (no random seed); the tremolo/vibrato give motion so the loop is not a dead tone.
 * Levels are kept modest in-graph; the per-frame mix `gain`/`duck` does the final balancing at render.
 */
const MUSIC_RECIPES: Record<string, MusicRecipe> = {
  calm: {
    dur: 8,
    // C major triad pad (C4/E4/G4) summed, softened by a lowpass + a slow 0.12Hz tremolo.
    graph:
      'sine=frequency=261.63:duration=8[a];sine=frequency=329.63:duration=8[b];sine=frequency=392.0:duration=8[c];' +
      '[a][b][c]amix=inputs=3:normalize=0,lowpass=f=1200,tremolo=f=0.12:d=0.5,volume=0.35[out]',
  },
  drone: {
    dur: 8,
    // A2 root + A3 octave drone, slow vibrato for movement, heavy lowpass → a dark undercurrent.
    graph:
      'sine=frequency=110.0:duration=8[a];sine=frequency=220.0:duration=8[b];' +
      '[a][b]amix=inputs=2:normalize=0,vibrato=f=0.1:d=0.4,lowpass=f=700,volume=0.4[out]',
  },
  uplift: {
    dur: 8,
    // Stacked fifths (G4/D5/A5) → an open, bright pad; a quicker 0.25Hz shimmer; lighter lowpass.
    graph:
      'sine=frequency=392.0:duration=8[a];sine=frequency=587.33:duration=8[b];sine=frequency=880.0:duration=8[c];' +
      '[a][b][c]amix=inputs=3:normalize=0,lowpass=f=2000,tremolo=f=0.25:d=0.45,volume=0.3[out]',
  },
};

/** The names of every built-in music bed (used by validation/help + the factory:list lane). */
export const MUSIC_NAMES = Object.keys(MUSIC_RECIPES);

/** Where a synthesized bed lands + how the renderer references it. */
export interface MusicResult {
  /** The bed name (also the wav basename). */
  name: string;
  /** Absolute path to the cached wav in the shared library cache. */
  libPath: string;
  /** The wav's path RELATIVE to the render publicDir (assets/), the value stored as the cue `src`. */
  publicRel: string;
  /** The bed's loop length in seconds (informational; the renderer loops to fill the timeline). */
  loopSeconds: number;
  /** True when this call reused an existing cached wav (skip-if-exists). */
  cached: boolean;
}

/**
 * Synthesize (or reuse) one named music bed into the SHARED library cache, then return where it lives.
 * CONTENT-STABLE by NAME (the recipe is fixed data) + skip-if-exists, so re-running on any story reuses
 * the identical wav → byte-identical audio (golden rule 1). The caller copies the cached wav into the
 * project's `assets/audio/` for a self-contained bundle, and the renderer LOOPS it to fill the timeline.
 *
 * Unknown names throw (loud failure beats a silent missing bed). `libMusicDir` is `library/music/`.
 */
export function synthMusic(name: string, libMusicDir: string): MusicResult {
  const recipe = MUSIC_RECIPES[name];
  if (!recipe) {
    throw new Error(`[music] unknown bed "${name}". Known: ${MUSIC_NAMES.join(', ')}`);
  }
  mkdirSync(libMusicDir, { recursive: true });
  const wavPath = resolvePath(libMusicDir, `${name}.wav`);
  const publicRel = `audio/${name}.wav`;

  if (existsSync(wavPath)) {
    return { name, libPath: wavPath, publicRel, loopSeconds: recipe.dur, cached: true };
  }

  // Render the recipe to a 44.1kHz mono PCM wav (a fixed, deterministic encode). `-filter_complex` +
  // `-map [out]` build the single bed stream; `-y` overwrites a partial file from a prior failed run.
  execFileSync(
    'ffmpeg',
    [
      '-v', 'error',
      '-filter_complex', recipe.graph,
      '-map', '[out]',
      '-ar', '44100',
      '-ac', '1',
      '-c:a', 'pcm_s16le',
      '-y', wavPath,
    ],
    { stdio: 'pipe' },
  );
  if (!existsSync(wavPath)) throw new Error(`[music] ffmpeg produced no wav at ${wavPath}`);
  return { name, libPath: wavPath, publicRel, loopSeconds: recipe.dur, cached: false };
}
