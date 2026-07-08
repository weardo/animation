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
    dur: 0.12,
    // A crisp high click + a tiny body — a clean "text appears" tick.
    graph:
      'sine=frequency=2200:duration=0.12[a];sine=frequency=1100:duration=0.12[b];[a][b]amix=inputs=2:normalize=0,afade=t=out:st=0.01:d=0.11:curve=exp,volume=0.5[out]',
  },
  pop: {
    dur: 0.18,
    // A satisfying UI pop: a pitch-rising body chirp + a bright click transient at the attack, tight
    // envelope. Two layers mixed → a fuller "element pops in" than a bare sine.
    graph:
      "aevalsrc='0.8*sin(2*PI*(360+1500*t)*t)':d=0.18:s=44100[body];" +
      'sine=frequency=2600:duration=0.05[click];' +
      '[body][click]amix=inputs=2:normalize=0,afade=t=out:st=0.03:d=0.15:curve=exp,volume=0.85[out]',
  },
  whoosh: {
    dur: 0.55,
    // A cinematic transition swoosh: warm PINK noise (airier than white) with a swelling tri envelope +
    // a descending body tone underneath → a real "move/reveal" whoosh, not a hiss. Fixed seed = stable.
    graph:
      'anoisesrc=color=pink:duration=0.55:seed=1:amplitude=0.7,highpass=f=180,lowpass=f=3200[n];' +
      "aevalsrc='0.25*sin(2*PI*(600*exp(-3*t))*t)':d=0.55:s=44100[tone];" +
      '[n][tone]amix=inputs=2:normalize=0,afade=t=in:st=0:d=0.22:curve=tri,afade=t=out:st=0.3:d=0.25,volume=0.85[out]',
  },
  ding: {
    dur: 0.75,
    // A rich bell/reveal: three (slightly inharmonic) partials + a long exponential decay → a bright,
    // shimmering "highlight" chime, warmer than a bare fifth.
    graph:
      'sine=frequency=1200:duration=0.75[a];sine=frequency=1800:duration=0.75[b];sine=frequency=2680:duration=0.75[c];' +
      '[a][b][c]amix=inputs=3:normalize=0,afade=t=out:st=0.06:d=0.69:curve=exp,volume=0.4[out]',
  },
  thud: {
    dur: 0.45,
    // A cinematic IMPACT: a sub-bass sine that DROPS in pitch (an exponentially falling frequency,
    // ~150→40 Hz) for the "boom", plus a short noise transient for the attack "hit". The classic
    // trailer-hit synthesis. Snappy exp decay.
    graph:
      "aevalsrc='0.95*sin(2*PI*(150*exp(-7*t))*t)':d=0.45:s=44100[sub];" +
      'anoisesrc=color=white:duration=0.06:seed=2:amplitude=0.5,highpass=f=800[hit];' +
      '[sub][hit]amix=inputs=2:normalize=0,afade=t=out:st=0.04:d=0.41:curve=exp,volume=0.95[out]',
  },
  click: {
    dur: 0.05,
    graph: 'sine=frequency=1800:duration=0.05,afade=t=out:st=0.004:d=0.046:curve=exp,volume=0.45[out]',
  },
  shutter: {
    dur: 0.08,
    // A crisp camera-SHUTTER snap: a tight band-limited noise transient + a high click → the per-cut
    // sound for a rapid NEWS/photo MONTAGE. Short + percussive so it reads at accelerating cut speeds.
    graph:
      'anoisesrc=color=white:duration=0.08:seed=5:amplitude=0.6,highpass=f=1200,lowpass=f=7000[snap];' +
      'sine=frequency=2100:duration=0.02[k];' +
      '[snap][k]amix=inputs=2:normalize=0,afade=t=out:st=0.008:d=0.07:curve=exp,volume=0.8[out]',
  },
  glitch: {
    dur: 0.14,
    // A DIGITAL glitch stutter: harsh high noise + a fast descending zap → a "data/tech" accent (a screen
    // flash, a system cut). Alternative per-cut montage sound; also good on a tech reveal.
    graph:
      'anoisesrc=color=white:duration=0.14:seed=6:amplitude=0.5,highpass=f=900[n];' +
      "aevalsrc='0.4*sin(2*PI*(1300*exp(-6*t))*t)':d=0.14:s=44100[z];" +
      '[n][z]amix=inputs=2:normalize=0,afade=t=out:st=0.02:d=0.11:curve=exp,volume=0.6[out]',
  },
  riser: {
    dur: 1.2,
    // A TENSION BUILD: rising filtered noise + a rising pitch, crescendo to the end → tension before a
    // reveal/turn (the geopolitics "something is coming" build). Fixed seed = deterministic.
    graph:
      'anoisesrc=color=white:duration=1.2:seed=3:amplitude=0.5,highpass=f=500[n];' +
      "aevalsrc='0.35*sin(2*PI*(180+700*t)*t)':d=1.2:s=44100[t];" +
      '[n][t]amix=inputs=2:normalize=0,afade=t=in:st=0:d=1.05:curve=exp,afade=t=out:st=1.1:d=0.1,volume=0.6[out]',
  },
  boom: {
    dur: 0.85,
    // A BIG cinematic sub-impact: a deeper, longer pitch drop (~110→30 Hz) with a longer tail than
    // `thud` → the payoff/climax hit. Sub-bass — feel it more than hear it.
    graph:
      "aevalsrc='0.98*sin(2*PI*(110*exp(-4.5*t))*t)':d=0.85:s=44100,afade=t=out:st=0.12:d=0.7:curve=exp,volume=1.0[out]",
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
