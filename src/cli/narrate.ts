// narrate.ts — OFFLINE narration synthesis (the M3 MVP). Golden rule 2: AI/voice NEVER touches frames
// or the runtime — TTS runs OFFLINE at BUILD time (exactly like factory:gen and the vendored font),
// producing a CACHED, CONTENT-ADDRESSED .wav. The render plays the FIXED wav via Remotion <Audio>, so
// the muxed video is byte-deterministic even though the TTS ENGINE itself may be stochastic (golden
// rule 1): the deterministic artifact is the cached wav, not the engine.
//
// ARCHITECTURE (the swappable TTS abstraction):
//   • A small engine interface `synth(text, voice, wpm) → wav bytes`. Two engines:
//       - espeak-ng (DEFAULT, deterministic + offline + always available): a pure formant synth.
//       - coqui (XTTS v2, the user's choice): an isolated venv at .venv-tts/bin/tts. Wired but heavy;
//         if its binary is missing we FALL BACK to espeak-ng with a warning (never fail the build).
//   • CONTENT-ADDRESSED CACHE: the wav file name = hash(text + engine + voice + wpm). Identical
//     narration is synthesized ONCE and reused (skip-if-exists). The cache lives UNDER the project
//     (assets/audio/<hash>.wav) so the bundle is self-contained — no separate vendor step needed; the
//     render publicDir IS that assets/ dir, and scene.json references the wav by its public-relative
//     path. Re-rendering an existing project reuses the same wavs (the lock pins the scene.json).
//   • ffprobe measures each wav's duration → duration_frames at the scene fps (deterministic rounding).
//
// This module is PURE I/O at build time: it never runs at render. The engine is selected via a flag/
// env; the cached wav is the deterministic record regardless of which engine produced it.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import objectHash from 'object-hash';

/** A narration TTS engine id. espeak-ng is the deterministic, always-available default. */
export type NarrateEngine = 'espeak-ng' | 'coqui';

/** Inputs that fully determine a synthesized clip → its content-address (cache key). */
export interface NarrateRequest {
  text: string;
  engine: NarrateEngine;
  /** Engine voice id: an espeak-ng voice (e.g. "en") or a Coqui speaker name (e.g. "Ana Florence"). */
  voice: string;
  /** Words-per-minute (espeak-ng pacing). Part of the cache key so a pacing change re-synthesizes. */
  wpm: number;
}

/** Where a synthesized clip lives + how the renderer references it. */
export interface NarrateResult {
  /** Content-address (hash of the request). The wav file is `<hash>.wav`. */
  hash: string;
  /** Absolute path to the cached wav on disk. */
  wavPath: string;
  /** The wav's path RELATIVE to the render publicDir (assets/), the value stored as the cue `src`. */
  publicRel: string;
  /** Decoded duration in seconds (from ffprobe). */
  durationSeconds: number;
  /** Which engine actually produced the wav (coqui may have fallen back to espeak-ng). */
  engineUsed: NarrateEngine;
  /** True when this call reused an existing cached wav (skip-if-exists). */
  cached: boolean;
}

/** Defaults: deterministic engine, a neutral English voice, a calm narration pace. */
export const DEFAULT_ENGINE: NarrateEngine = 'espeak-ng';
export const DEFAULT_VOICE: Record<NarrateEngine, string> = {
  'espeak-ng': 'en',
  coqui: 'Ana Florence',
};
export const DEFAULT_WPM = 165;

/** The isolated Coqui XTTS env (a heavy optional dependency, kept off the engine's critical path). */
const COQUI_TTS_BIN = '.venv-tts/bin/tts';
const COQUI_MODEL = 'tts_models/multilingual/multi-dataset/xtts_v2';

/**
 * Content-address a request: hash(text + engine + voice + wpm). Stable + collision-resistant
 * (object-hash, the repo's adopted hasher), so identical narration shares ONE cached wav.
 */
export function narrateHash(req: NarrateRequest): string {
  return objectHash({ text: req.text, engine: req.engine, voice: req.voice, wpm: req.wpm }).slice(0, 16);
}

/** Probe a wav's duration in seconds via ffprobe (deterministic; the wav is a fixed file). */
function probeDurationSeconds(wavPath: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wavPath],
    { encoding: 'utf8' },
  ).trim();
  const d = Number(out);
  if (!Number.isFinite(d) || d <= 0) throw new Error(`ffprobe gave no duration for ${wavPath}: '${out}'`);
  return d;
}

/** Synthesize with espeak-ng (deterministic formant synth): `espeak-ng -v <voice> -s <wpm> -w <out>`. */
function synthEspeak(text: string, voice: string, wpm: number, wavPath: string): void {
  execFileSync('espeak-ng', ['-v', voice, '-s', String(wpm), '-w', wavPath, text], { stdio: 'pipe' });
}

/**
 * Synthesize with Coqui XTTS v2 via the isolated venv. Returns false if the binary is unavailable
 * (caller falls back to espeak-ng) or the synth fails — we NEVER fail the build on a missing/broken
 * optional engine; the cached wav (from whatever engine) is the deterministic artifact.
 */
function synthCoqui(text: string, voice: string, wavPath: string, rootDir: string): boolean {
  const bin = resolvePath(rootDir, COQUI_TTS_BIN);
  if (!existsSync(bin)) return false;
  try {
    execFileSync(
      bin,
      [
        '--model_name', COQUI_MODEL,
        '--speaker_idx', voice,
        '--language_idx', 'en',
        '--text', text,
        '--out_path', wavPath,
      ],
      { stdio: 'pipe', env: { ...process.env, COQUI_TOS_AGREED: '1' } },
    );
    return existsSync(wavPath);
  } catch {
    return false;
  }
}

/**
 * Synthesize (or reuse) one narration clip into the project's audio cache. CONTENT-ADDRESSED +
 * skip-if-exists: if `<audioDir>/<hash>.wav` already exists we reuse it (no re-synth), which is what
 * makes a re-render byte-identical regardless of engine stochasticity. `audioDir` is the project's
 * `assets/audio/`; `publicRelPrefix` is the public-relative folder ("audio") used to build the cue
 * `src` the compositor resolves with `staticFile`.
 *
 * `rootDir` locates the optional Coqui venv. Selecting `coqui` with a missing/broken binary falls
 * back to espeak-ng (a warning, never an error).
 */
export function synthNarration(
  req: NarrateRequest,
  audioDir: string,
  rootDir: string,
  publicRelPrefix = 'audio',
): NarrateResult {
  mkdirSync(audioDir, { recursive: true });
  const hash = narrateHash(req);
  const wavPath = resolvePath(audioDir, `${hash}.wav`);
  const publicRel = `${publicRelPrefix}/${hash}.wav`;

  if (existsSync(wavPath)) {
    return {
      hash,
      wavPath,
      publicRel,
      durationSeconds: probeDurationSeconds(wavPath),
      engineUsed: req.engine,
      cached: true,
    };
  }

  let engineUsed: NarrateEngine = req.engine;
  if (req.engine === 'coqui') {
    const ok = synthCoqui(req.text, req.voice, wavPath, rootDir);
    if (!ok) {
      console.warn(`[narrate] coqui unavailable/failed → falling back to espeak-ng for "${truncate(req.text)}"`);
      synthEspeak(req.text, DEFAULT_VOICE['espeak-ng'], req.wpm, wavPath);
      engineUsed = 'espeak-ng';
    }
  } else {
    synthEspeak(req.text, req.voice, req.wpm, wavPath);
  }

  if (!existsSync(wavPath)) throw new Error(`[narrate] synthesis produced no wav at ${wavPath}`);
  return {
    hash,
    wavPath,
    publicRel,
    durationSeconds: probeDurationSeconds(wavPath),
    engineUsed,
    cached: false,
  };
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
