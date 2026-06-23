// sfx.ts — OFFLINE sound-effect synthesis (A2). Golden rule 2: AI/voice/audio NEVER touches frames or
// the runtime — SFX, like narration + the vendored font, are produced OFFLINE at BUILD time, cached to
// a deterministic .wav, then played by Remotion <Audio> at render. No external sourcing: every effect
// is SYNTHESIZED from `ffmpeg`'s `lavfi` math sources (sine/exp envelope/noise), so the factory has a
// small CC0-clean palette with zero downloads (golden rules: determinism + offline + disk-safe).
//
// SHARED LIBRARY CACHE: synthesized SFX live in `library/sfx/<name>.wav` (a shared, content-stable
// catalog reused across projects — mirrors how narration is content-addressed, but keyed by the NAMED
// effect since an sfx recipe is fixed DATA). The sfx pass then COPIES the cached wav into the project's
// self-contained `assets/audio/` and references it by an `audio://` cue src (resolved at render with
// staticFile), exactly like a narration wav. skip-if-exists makes re-runs reuse the same bytes →
// byte-identical audio stream (golden rule 1).
//
// This module is PURE I/O at build time: it never runs at render. ffmpeg is the adopted muxer/encoder
// (ADR-003: never reimplement a media primitive) — here also the deterministic tone generator.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

/**
 * A built-in SFX recipe: a NAME → a deterministic `ffmpeg -filter_complex` graph (and its output
 * length). Each graph builds one short cue from lavfi math sources + an exponential amplitude envelope
 * (so the cue reads as a clean, percussive "event" sound, not a flat tone). The recipes are FIXED data:
 * the same name always yields the same wav, so caching by name is sound (golden rule 1).
 *
 * The graphs use only `aevalsrc` / `sine` (pure-math, deterministic) + `volume`/`afade` envelopes —
 * no random/noise seed that could drift run-to-run. `dur` is the cue length in seconds (the render
 * lower-bounds the cue window to 1 frame regardless).
 */
interface SfxRecipe {
  /** The ffmpeg `-filter_complex` graph producing a single mono [out] stream. */
  graph: string;
  /** Output duration in seconds. */
  dur: number;
}

/**
 * The built-in SFX palette. Each is a short, recognizable UI/motion cue synthesized from math:
 *   • tick   — a quick high sine pulse (an item/text appears).
 *   • pop    — a fast rising sine burst with a snappy decay (an element pops in).
 *   • whoosh — filtered noise swept down (a fast move / camera push / slide).
 *   • ding   — a bright two-partial bell (a positive beat / reveal).
 *   • thud   — a low sine thump (an impact / landing).
 *   • click  — a very short tick (a small UI step).
 * All deterministic (no random seed); `afade` shapes the envelope so each is percussive, not droning.
 */
const SFX_RECIPES: Record<string, SfxRecipe> = {
  tick: {
    dur: 0.18,
    graph: 'sine=frequency=880:duration=0.18,afade=t=out:st=0.04:d=0.14:curve=exp,volume=0.6[out]',
  },
  pop: {
    dur: 0.16,
    // A short pitch-rising chirp: aevalsrc with a time-varying frequency, fast decay.
    graph:
      "aevalsrc='0.7*sin(2*PI*(420+1600*t)*t)':d=0.16:s=44100,afade=t=out:st=0.02:d=0.14:curve=exp[out]",
  },
  whoosh: {
    dur: 0.45,
    // White-ish noise (deterministic sine-sum approximation) swept by a falling lowpass → an airy
    // whoosh. Uses anoisesrc with a FIXED seed so the bytes are stable across runs (determinism).
    graph:
      'anoisesrc=color=white:duration=0.45:seed=1:amplitude=0.5,highpass=f=300,lowpass=f=2500,afade=t=in:st=0:d=0.12,afade=t=out:st=0.2:d=0.25,volume=0.7[out]',
  },
  ding: {
    dur: 0.6,
    // Two stacked partials (a perfect fifth) with a long exponential decay → a bright bell/reveal.
    graph:
      'sine=frequency=1320:duration=0.6[a];sine=frequency=1980:duration=0.6[b];[a][b]amix=inputs=2:normalize=0,afade=t=out:st=0.05:d=0.55:curve=exp,volume=0.5[out]',
  },
  thud: {
    dur: 0.35,
    // A low body sine with a snappy decay → an impact/landing.
    graph: 'sine=frequency=110:duration=0.35,afade=t=out:st=0.02:d=0.33:curve=exp,volume=0.9[out]',
  },
  click: {
    dur: 0.06,
    graph: 'sine=frequency=1600:duration=0.06,afade=t=out:st=0.005:d=0.055:curve=exp,volume=0.5[out]',
  },
};

/** The names of every built-in SFX recipe (used by validation/help + the factory:list lane). */
export const SFX_NAMES = Object.keys(SFX_RECIPES);

/** Where a synthesized SFX lands + how the renderer references it. */
export interface SfxResult {
  /** The effect name (also the wav basename). */
  name: string;
  /** Absolute path to the cached wav in the shared library cache. */
  libPath: string;
  /** The wav's path RELATIVE to the render publicDir (assets/), the value stored as the cue `src`. */
  publicRel: string;
  /** Cue length in frames at the given fps (≥1). */
  durationFrames: number;
  /** True when this call reused an existing cached wav (skip-if-exists). */
  cached: boolean;
}

/**
 * Synthesize (or reuse) one named SFX into the SHARED library cache, then return where it lives + its
 * frame length. CONTENT-STABLE by NAME (the recipe is fixed data) + skip-if-exists, so re-running on
 * any story reuses the identical wav → byte-identical audio (golden rule 1). The caller copies the
 * cached wav into the project's `assets/audio/` for a self-contained bundle.
 *
 * Unknown names throw (loud failure beats a silent missing cue). `libSfxDir` is `library/sfx/`.
 */
export function synthSfx(name: string, libSfxDir: string, fps: number): SfxResult {
  const recipe = SFX_RECIPES[name];
  if (!recipe) {
    throw new Error(`[sfx] unknown effect "${name}". Known: ${SFX_NAMES.join(', ')}`);
  }
  mkdirSync(libSfxDir, { recursive: true });
  const wavPath = resolvePath(libSfxDir, `${name}.wav`);
  const publicRel = `audio/${name}.wav`;
  const durationFrames = Math.max(1, Math.round(recipe.dur * fps));

  if (existsSync(wavPath)) {
    return { name, libPath: wavPath, publicRel, durationFrames, cached: true };
  }

  // Render the recipe to a 44.1kHz mono PCM wav (a fixed, deterministic encode). `-filter_complex` +
  // `-map [out]` build the single cue stream; `-y` overwrites a partial file from a prior failed run.
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
  if (!existsSync(wavPath)) throw new Error(`[sfx] ffmpeg produced no wav at ${wavPath}`);
  return { name, libPath: wavPath, publicRel, durationFrames, cached: false };
}
