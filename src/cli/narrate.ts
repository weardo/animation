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

/**
 * A narration TTS engine id. espeak-ng is the deterministic, always-available fallback; chatterbox is
 * the best-sounding DEFAULT. kokoro/chatterbox/parler each run in their own isolated venv at the repo
 * root (.venv-<engine>) via a productionized synth CLI in scripts/tts/; a missing venv or a synth error
 * NEVER fails the build — we fall back to espeak-ng (golden rule 1: the cached wav is the deterministic
 * record, not the engine).
 */
export type NarrateEngine = 'espeak-ng' | 'coqui' | 'kokoro' | 'chatterbox' | 'parler';

/** Inputs that fully determine a synthesized clip → its content-address (cache key). */
export interface NarrateRequest {
  text: string;
  engine: NarrateEngine;
  /** Engine voice id: an espeak-ng voice (e.g. "en"), a Coqui speaker, or a Kokoro voice (e.g. af_heart). */
  voice: string;
  /** Words-per-minute (espeak-ng pacing). Part of the cache key so a pacing change re-synthesizes. */
  wpm: number;
  /**
   * Optional tone DESCRIPTION / label. Parler uses it as the conditioning prompt ("calm, somber, slow");
   * other engines ignore it but it still folds into the cache key, so a tone change re-synthesizes.
   */
  tone?: string;
  /**
   * Optional numeric engine params (e.g. {exaggeration, cfg} for chatterbox). Folded into the cache key,
   * so a param change re-synthesizes; engines that don't use a given key ignore it.
   */
  style?: Record<string, number>;
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

/**
 * Defaults: chatterbox (best-sounding, ~ElevenLabs in blind tests) is the DEFAULT engine; if its venv
 * is missing or it errors we fall back to espeak-ng (never fail the build). Each engine has a sensible
 * default voice and a calm narration pace.
 */
export const DEFAULT_ENGINE: NarrateEngine = 'chatterbox';
export const DEFAULT_VOICE: Record<NarrateEngine, string> = {
  'espeak-ng': 'en',
  coqui: 'Ana Florence',
  kokoro: 'af_heart',
  // chatterbox/parler don't take a discrete voice id (chatterbox = built-in voice; parler = tone desc),
  // but the field is required by NarrateRequest and folds into the cache key, so use a stable label.
  chatterbox: 'default',
  parler: 'default',
};
export const DEFAULT_WPM = 165;

/** Per-engine default numeric params (chatterbox expressiveness/guidance). */
export const DEFAULT_STYLE: Partial<Record<NarrateEngine, Record<string, number>>> = {
  chatterbox: { exaggeration: 0.5, cfg: 0.5 },
};

/** Per-engine default tone description (parler conditioning prompt). */
export const DEFAULT_TONE: Partial<Record<NarrateEngine, string>> = {
  parler: 'A speaker delivers in a calm, somber and reverent tone, at a measured pace, with very clear high-quality audio and no background noise.',
};

/** The HF model cache shared by every venv engine; pinned so models never re-download per-process. */
const HF_HOME = '/mnt/data/astra/.cache/hf';

/** The isolated Coqui XTTS env (a heavy optional dependency, kept off the engine's critical path). */
const COQUI_TTS_BIN = '.venv-tts/bin/tts';
const COQUI_MODEL = 'tts_models/multilingual/multi-dataset/xtts_v2';

/** Each venv-based engine: its isolated python + the productionized synth CLI under scripts/tts/. */
const VENV_PYTHON: Partial<Record<NarrateEngine, string>> = {
  kokoro: '.venv-kokoro/bin/python',
  chatterbox: '.venv-chatterbox/bin/python',
  parler: '.venv-parler/bin/python',
};
const SYNTH_SCRIPT: Partial<Record<NarrateEngine, string>> = {
  kokoro: 'scripts/tts/kokoro_synth.py',
  chatterbox: 'scripts/tts/chatterbox_synth.py',
  parler: 'scripts/tts/parler_synth.py',
};

/**
 * Content-address a request: hash(text + engine + voice + wpm + tone + style). Stable + collision-
 * resistant (object-hash, the repo's adopted hasher), so identical narration shares ONE cached wav and
 * any change to the tone description or numeric style params re-synthesizes a fresh wav.
 */
export function narrateHash(req: NarrateRequest): string {
  return objectHash({
    text: req.text,
    engine: req.engine,
    voice: req.voice,
    wpm: req.wpm,
    tone: req.tone ?? null,
    style: req.style ?? null,
  }).slice(0, 16);
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
 * Run a venv-based engine's synth CLI: `.venv-<engine>/bin/python scripts/tts/<engine>_synth.py
 * --text … --out … <extra args>`, with HF_HOME pinned to the shared model cache. Returns false (→
 * espeak-ng fallback, never fail the build) if the venv python / script is missing or the synth errors.
 */
function runVenvSynth(engine: NarrateEngine, text: string, wavPath: string, rootDir: string, extra: string[]): boolean {
  const pyRel = VENV_PYTHON[engine];
  const scriptRel = SYNTH_SCRIPT[engine];
  if (!pyRel || !scriptRel) return false;
  const py = resolvePath(rootDir, pyRel);
  const script = resolvePath(rootDir, scriptRel);
  if (!existsSync(py) || !existsSync(script)) return false;
  try {
    execFileSync(py, [script, '--text', text, '--out', wavPath, ...extra], {
      stdio: 'pipe',
      env: { ...process.env, HF_HOME: process.env['HF_HOME'] ?? HF_HOME },
    });
    return existsSync(wavPath);
  } catch {
    return false;
  }
}

/** Kokoro (fast, clean) via .venv-kokoro: `--voice <id>`. */
function synthKokoro(req: NarrateRequest, wavPath: string, rootDir: string): boolean {
  return runVenvSynth('kokoro', req.text, wavPath, rootDir, ['--voice', req.voice]);
}

/** Chatterbox (best-sounding, default) via .venv-chatterbox: `--exaggeration <n> --cfg <n>`. */
function synthChatterbox(req: NarrateRequest, wavPath: string, rootDir: string): boolean {
  const style = req.style ?? DEFAULT_STYLE.chatterbox ?? {};
  const exaggeration = style['exaggeration'] ?? 0.5;
  const cfg = style['cfg'] ?? 0.5;
  return runVenvSynth('chatterbox', req.text, wavPath, rootDir, [
    '--exaggeration', String(exaggeration),
    '--cfg', String(cfg),
  ]);
}

/** Parler (describe-the-tone) via .venv-parler: `--desc "<tone>"`. */
function synthParler(req: NarrateRequest, wavPath: string, rootDir: string): boolean {
  const desc = req.tone ?? DEFAULT_TONE.parler;
  const extra = desc ? ['--desc', desc] : [];
  return runVenvSynth('parler', req.text, wavPath, rootDir, extra);
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
  if (req.engine === 'espeak-ng') {
    synthEspeak(req.text, req.voice, req.wpm, wavPath);
  } else {
    // Optional engines: try the selected engine; on any miss/error fall back to espeak-ng (never fail
    // the build — the cached wav from whatever engine is the deterministic record, golden rule 1).
    let ok = false;
    switch (req.engine) {
      case 'coqui':
        ok = synthCoqui(req.text, req.voice, wavPath, rootDir);
        break;
      case 'kokoro':
        ok = synthKokoro(req, wavPath, rootDir);
        break;
      case 'chatterbox':
        ok = synthChatterbox(req, wavPath, rootDir);
        break;
      case 'parler':
        ok = synthParler(req, wavPath, rootDir);
        break;
    }
    if (!ok) {
      console.warn(`[narrate] ${req.engine} unavailable/failed → falling back to espeak-ng for "${truncate(req.text)}"`);
      synthEspeak(req.text, DEFAULT_VOICE['espeak-ng'], req.wpm, wavPath);
      engineUsed = 'espeak-ng';
    }
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
