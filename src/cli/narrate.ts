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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import objectHash from 'object-hash';

/**
 * A narration TTS engine id. espeak-ng is the deterministic, always-available fallback; chatterbox is
 * the best-sounding DEFAULT. kokoro/chatterbox/parler each run in their own isolated venv at the repo
 * root (.venv-<engine>) via a productionized synth CLI in scripts/tts/; a missing venv or a synth error
 * NEVER fails the build — we fall back to espeak-ng (golden rule 1: the cached wav is the deterministic
 * record, not the engine).
 */
export type NarrateEngine = 'espeak-ng' | 'coqui' | 'kokoro' | 'chatterbox' | 'parler' | 'indic-parler' | 'indicf5' | 'sarvam';

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
  // indic-parler: the voice is steered by the tone DESCRIPTION (like parler), not a discrete id.
  'indic-parler': 'default',
  // indicf5: the voice IS the reference audio (voice cloning). "default" = the vendored reference clip.
  indicf5: 'default',
  // sarvam: Bulbul v3 speaker name (young Hindi voices: shubh/aditya/dev/aayan/sunny/advait).
  sarvam: 'shubh',
};
export const DEFAULT_WPM = 165;

/** Per-engine default numeric params (chatterbox expressiveness/guidance). */
export const DEFAULT_STYLE: Partial<Record<NarrateEngine, Record<string, number>>> = {
  chatterbox: { exaggeration: 0.5, cfg: 0.5 },
};

/** Per-engine default tone description (parler / indic-parler conditioning prompt). */
export const DEFAULT_TONE: Partial<Record<NarrateEngine, string>> = {
  parler: 'A speaker delivers in a calm, somber and reverent tone, at a measured pace, with very clear high-quality audio and no background noise.',
  // Indic Parler steers the voice by the SPEAKER NAME in the description; the language is inferred from
  // the SCRIPT of the text (Devanagari → Hindi, …). "Rohit" is a recommended HINDI speaker — use a
  // language-matched speaker or the model renders Hindi in another language's accent (e.g. "Aditi" is
  // BENGALI, which made Hindi text sound Bengali). Hindi recommended: Rohit, Divya.
  'indic-parler': 'Divya speaks in a youthful, bright and highly energetic voice, at a very fast and continuous pace with almost no pauses, full of excitement and punchy emphasis like a captivating young reel storyteller, in very clear high-quality audio with no background noise.',
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
  // indic-parler reuses the parler venv (same parler_tts package, different checkpoint).
  'indic-parler': '.venv-parler/bin/python',
  indicf5: '.venv-indicf5/bin/python',
};
const SYNTH_SCRIPT: Partial<Record<NarrateEngine, string>> = {
  kokoro: 'scripts/tts/kokoro_synth.py',
  chatterbox: 'scripts/tts/chatterbox_synth.py',
  parler: 'scripts/tts/parler_synth.py',
  'indic-parler': 'scripts/tts/indic_parler_synth.py',
  indicf5: 'scripts/tts/indicf5_synth.py',
};

/** The vendored default IndicF5 reference voice (wav + its transcript sidecar), relative to rootDir. */
const INDICF5_REF_AUDIO = 'scripts/tts/refs/indicf5_default.wav';
const INDICF5_REF_TEXT_FILE = 'scripts/tts/refs/indicf5_default.txt';

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
 * Indic Parler-TTS (21 Indian languages) via .venv-parler: `--desc "<voice/tone>"`. The spoken
 * language is inferred from the SCRIPT of `req.text` (Devanagari → Hindi, etc.), so no lang flag is
 * needed. Uses the ai4bharat/indic-parler-tts checkpoint (gated: auto — needs a cached, license-
 * accepted download; a missing/failed engine falls back to espeak-ng, never fails the build).
 */
function synthIndicParler(req: NarrateRequest, wavPath: string, rootDir: string): boolean {
  const desc = req.tone ?? DEFAULT_TONE['indic-parler'];
  const extra = desc ? ['--desc', desc] : [];
  return runVenvSynth('indic-parler', req.text, wavPath, rootDir, extra);
}

/**
 * IndicF5 (11 Indian languages, near-human) via .venv-indicf5. Voice CLONING: it needs a reference
 * wav + that wav's transcript. Defaults to the vendored reference (scripts/tts/refs/indicf5_default.*);
 * a project may override via req.voice = an absolute wav path with a `<path>.txt` transcript sidecar.
 * A missing reference / venv / synth error falls back to espeak-ng (never fails the build).
 */
/**
 * Sarvam Bulbul v3 (native Hinglish, cloud API) — NOT a venv/local model: a stdlib HTTP call via
 * system python3 (scripts/tts/sarvam_synth.py), keyed by SARVAM_API_KEY in the env. The speaker id is
 * req.voice (default "shubh"). Runs ONCE offline into the content-addressed cache like every engine, so
 * the render replays the fixed wav. A missing key / network error → false → espeak-ng fallback.
 */
function synthSarvam(req: NarrateRequest, wavPath: string, rootDir: string): boolean {
  if (!process.env['SARVAM_API_KEY']) return false;
  const script = resolvePath(rootDir, 'scripts/tts/sarvam_synth.py');
  if (!existsSync(script)) return false;
  const speaker = req.voice && req.voice !== 'default' ? req.voice : DEFAULT_VOICE.sarvam;
  // Bulbul v3 `pace` (0.5–2.0; >1 = FASTER). Read from the request (folded into the cache key by
  // synthNarration) so it stays in sync with the hash; falls back to the env / a slightly-fast default.
  const pace = String(req.style?.['pace'] ?? process.env['SARVAM_PACE'] ?? '1.15');
  try {
    execFileSync('python3', [script, '--text', req.text, '--out', wavPath, '--speaker', speaker, '--pace', pace], {
      stdio: 'pipe',
      env: { ...process.env },
    });
    return existsSync(wavPath);
  } catch {
    return false;
  }
}

function synthIndicF5(req: NarrateRequest, wavPath: string, rootDir: string): boolean {
  // Resolve the reference voice: a project-supplied absolute wav (voice id) or the vendored default.
  const custom = req.voice && req.voice !== 'default' && req.voice.endsWith('.wav') ? req.voice : undefined;
  const refAudio = custom ? resolvePath(rootDir, custom) : resolvePath(rootDir, INDICF5_REF_AUDIO);
  const refTextFile = custom ? `${custom.slice(0, -4)}.txt` : INDICF5_REF_TEXT_FILE;
  const refTextPath = resolvePath(rootDir, refTextFile);
  if (!existsSync(refAudio) || !existsSync(refTextPath)) return false;
  const refText = readFileSync(refTextPath, 'utf8').trim();
  if (!refText) return false;
  return runVenvSynth('indicf5', req.text, wavPath, rootDir, [
    '--ref-audio', refAudio,
    '--ref-text', refText,
  ]);
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
  // Fold the Sarvam pace into the request BEFORE hashing so a pace change re-synthesizes (it was an env
  // var read after the hash → stale wavs). Now `style.pace` is part of the content address.
  if (req.engine === 'sarvam' && (!req.style || req.style['pace'] === undefined)) {
    const pace = Number(process.env['SARVAM_PACE'] ?? '1.15');
    req = { ...req, style: { ...(req.style ?? {}), pace } };
  }
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
      case 'indic-parler':
        ok = synthIndicParler(req, wavPath, rootDir);
        break;
      case 'indicf5':
        ok = synthIndicF5(req, wavPath, rootDir);
        break;
      case 'sarvam':
        ok = synthSarvam(req, wavPath, rootDir);
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

// --- M4 whisper word-sync alignment (OFFLINE, build-time, content-addressed cache) ---
//
// Like TTS, forced-alignment runs ONCE OFFLINE at build into a content-addressed cache and the render
// replays the FIXED cached JSON → byte-deterministic even though whisper is not bit-exact across
// machines (golden rule 1: the cached artifact is the record, not the engine). The whisper engine
// lives in an isolated venv (.venv-whisper) + a small CLI (scripts/tts/align_whisper.py); a missing
// venv / model / alignment error NEVER fails the build — the caller falls back to even-split captions.

/** The isolated faster-whisper venv + the alignment CLI (run OFFLINE; never at render). */
const WHISPER_PYTHON = '.venv-whisper/bin/python';
const ALIGN_SCRIPT = 'scripts/tts/align_whisper.py';
const WHISPER_MODEL = 'small';

/** One aligned word: the spoken token + its start/end in SECONDS (from faster-whisper). */
export interface AlignedWord {
  word: string;
  start: number;
  end: number;
}

/** Where a cached alignment lives + whether it came from whisper or the even-split fallback. */
export interface AlignResult {
  /** Per-word timings (seconds). Empty only if both whisper AND fallback produced nothing. */
  words: AlignedWord[];
  /** True when these timings came from a fresh/cached whisper run; false = even-split fallback. */
  aligned: boolean;
  /** True when this call reused an existing cached alignment JSON (skip-if-exists). */
  cached: boolean;
}

/**
 * Content-address an alignment: hash(wav content-address + transcript + model). The wav hash already
 * folds in engine/voice/wpm/tone/style, so a different-sounding clip re-aligns; folding the transcript
 * in too keeps the key self-describing. Distinct prefix length from the wav hash is irrelevant — the
 * file lives under a separate `align/` folder.
 */
export function alignHash(wavHash: string, transcript: string): string {
  return objectHash({ wav: wavHash, text: transcript, model: WHISPER_MODEL }).slice(0, 16);
}

/** Read + validate a cached alignment JSON ([{word,start,end}]); returns null if malformed. */
function readAlignJson(jsonPath: string): AlignedWord[] | null {
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return null;
    const words: AlignedWord[] = [];
    for (const e of raw) {
      if (
        e && typeof e === 'object' &&
        typeof (e as AlignedWord).word === 'string' &&
        typeof (e as AlignedWord).start === 'number' &&
        typeof (e as AlignedWord).end === 'number'
      ) {
        words.push({ word: (e as AlignedWord).word, start: (e as AlignedWord).start, end: (e as AlignedWord).end });
      }
    }
    return words.length > 0 ? words : null;
  } catch {
    return null;
  }
}

/**
 * Force-align a cached narration wav to its transcript → per-word timings, CACHED content-addressed
 * (skip-if-exists) under `<audioDir>/align/<hash>.json`. DETERMINISTIC: a cache hit replays the FIXED
 * JSON; a cache miss runs whisper ONCE into the cache. NEVER fails the build — if the whisper venv /
 * model is missing or alignment errors, returns `{aligned:false}` (the caller keeps the even-split
 * cadence). `wavHash` is the wav's content-address (from {@link NarrateResult}); `rootDir` locates the
 * isolated venv + CLI.
 */
export function alignNarration(
  wavPath: string,
  wavHash: string,
  transcript: string,
  audioDir: string,
  rootDir: string,
): AlignResult {
  const alignDir = resolvePath(audioDir, 'align');
  const hash = alignHash(wavHash, transcript);
  const jsonPath = resolvePath(alignDir, `${hash}.json`);

  // Cache hit → replay the FIXED JSON (the deterministic record).
  if (existsSync(jsonPath)) {
    const cachedWords = readAlignJson(jsonPath);
    if (cachedWords) return { words: cachedWords, aligned: true, cached: true };
    // A malformed cache file: fall through to re-run (it will overwrite).
  }

  const py = resolvePath(rootDir, WHISPER_PYTHON);
  const script = resolvePath(rootDir, ALIGN_SCRIPT);
  if (!existsSync(py) || !existsSync(script)) {
    return { words: [], aligned: false, cached: false };
  }

  mkdirSync(alignDir, { recursive: true });
  try {
    execFileSync(
      py,
      [script, '--wav', wavPath, '--out', jsonPath, '--model', WHISPER_MODEL],
      { stdio: 'pipe', env: { ...process.env, HF_HOME: process.env['HF_HOME'] ?? HF_HOME } },
    );
  } catch {
    return { words: [], aligned: false, cached: false };
  }

  const words = existsSync(jsonPath) ? readAlignJson(jsonPath) : null;
  if (!words) return { words: [], aligned: false, cached: false };
  return { words, aligned: true, cached: false };
}

/**
 * Map whisper's per-word seconds to the CaptionCue `wordsTimed[]` (token + LOCAL frame offset `at` +
 * `dur` in frames, relative to the cue start). Pure + deterministic: a function of the alignment + fps
 * + the cue's local window. Clamps each word into `[0, durationFrames)` and ensures `dur >= 1` so the
 * renderer always has a non-empty reveal window. The TOKENS come from whisper (its segmentation), not
 * the authored text — so a word the synth elided/merged stays consistent with what was actually spoken.
 */
export function timedWordsFromAlignment(
  words: AlignedWord[],
  fps: number,
  durationFrames: number,
): Array<{ w: string; at: number; dur: number }> {
  const timed: Array<{ w: string; at: number; dur: number }> = [];
  for (const { word, start, end } of words) {
    const token = word.trim();
    if (!token) continue;
    const atF = Math.max(0, Math.min(durationFrames - 1, Math.round(start * fps)));
    const endF = Math.max(atF + 1, Math.min(durationFrames, Math.round(end * fps)));
    timed.push({ w: token, at: atF, dur: endF - atF });
  }
  return timed;
}

// --- M4b lip-sync visemes: per-frame mouth-openness from the cached narration wav (OFFLINE, cached) ---
//
// Like TTS + alignment, the viseme/openness track is produced ONCE OFFLINE at build into a CONTENT-
// ADDRESSED cache (hash of the wav + fps + analyzer version, skip-if-exists); the render replays the
// FIXED samples → byte-deterministic even though the analyzer is not bit-exact across machines (golden
// rule 1: the cached artifact is the record, not the generator). The render NEVER runs this — it reads
// the cached `mouth` track from the Scene IR and the provider interprets it.
//
// SIGNAL: a simple, robust short-time RMS ENERGY ENVELOPE. We decode the wav to mono f32 PCM via ffmpeg
// (always available — no python/venv), bin the samples into one window per output frame, take each
// window's RMS, then map RMS → 0..1 openness with a perceptual curve (a noise floor + a soft knee + a
// gamma) and a tiny attack/decay smoothing so the mouth doesn't chatter. Louder ⇒ wider; silence ⇒
// closed. OPTIONAL viseme LABELS: when a whisper alignment is supplied, frames INSIDE a spoken word are
// labelled "open" and frames in the gaps "closed" (a coarse class a part-swap provider may use); without
// alignment the label track is omitted (openness-only). A missing/failed ffmpeg decode NEVER fails the
// build — we return null and the caller emits no mouth track (the rig idles).

/** The analyzer version — folded into the cache key so a curve change re-derives (cache-invalidation). */
const MOUTH_ANALYZER_VERSION = '1';
/** The RMS analysis sample rate (mono). Low enough to be cheap, high enough for a clean envelope. */
const MOUTH_PCM_RATE = 16000;

/** One per-frame mouth sample: openness in [0,1] + an optional coarse viseme class label. */
export interface MouthTrackData {
  /** Sampling rate (fps) the envelope was computed at (matches the scene fps). */
  fps: number;
  /** Per-LOCAL-frame openness in [0,1] (0 closed … 1 wide). Length = the narration's frame span. */
  open: number[];
  /** OPTIONAL coarse per-frame viseme class label (same length as `open`); omitted = openness-only. */
  viseme?: string[];
}

/**
 * Content-address a mouth track: hash(wav content-address + fps + frame count + analyzer version +
 * whether viseme labels were derived). The wav hash already folds in engine/voice/wpm/tone/style, so a
 * different-sounding clip re-derives; folding fps/frames keeps the cached samples valid for exactly the
 * render config they were computed at.
 */
export function mouthHash(wavHash: string, fps: number, durationFrames: number, labelled: boolean): string {
  return objectHash({
    wav: wavHash,
    fps,
    frames: durationFrames,
    labelled,
    analyzer: MOUTH_ANALYZER_VERSION,
  }).slice(0, 16);
}

/** Decode a wav to mono f32 PCM samples via ffmpeg (deterministic — a fixed file). Null on any error. */
function decodePcm(wavPath: string): Float32Array | null {
  try {
    const buf = execFileSync(
      'ffmpeg',
      ['-v', 'error', '-i', wavPath, '-ac', '1', '-ar', String(MOUTH_PCM_RATE), '-f', 'f32le', '-'],
      { maxBuffer: 1 << 28 }, // up to 256 MB of PCM (a long narration clip); returns a Buffer
    ) as Buffer;
    if (buf.length < 4) return null;
    // Reinterpret the byte buffer as little-endian float32 (ffmpeg `f32le`). Copy to align the view.
    const aligned = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length - (buf.length % 4));
    return new Float32Array(aligned);
  } catch {
    return null;
  }
}

/**
 * Map a window RMS to a perceptual mouth openness in [0,1]: subtract a noise floor, normalize against a
 * reference loudness, apply a gamma so quiet speech still opens the mouth a little, and clamp. Pure.
 */
function rmsToOpenness(rms: number): number {
  const FLOOR = 0.01; // below this is treated as silence (closed)
  const REF = 0.18; // RMS that maps to a wide-open mouth (typical speech peak for our TTS levels)
  const GAMMA = 0.6; // < 1 lifts mid energies so normal speech reads as a clearly moving mouth
  const x = (rms - FLOOR) / (REF - FLOOR);
  if (x <= 0) return 0;
  const clamped = x >= 1 ? 1 : x;
  return Math.pow(clamped, GAMMA);
}

/**
 * Compute a per-frame openness envelope (0..1) from mono PCM. Bins the samples into `durationFrames`
 * windows (one per output frame), takes each window's RMS, maps to openness, then applies a one-pole
 * attack/decay smoother so the mouth opens fast and closes a touch slower (natural, no chatter). Pure +
 * deterministic — a function of the samples + frame count only (the PCM rate is implicit in the buffer
 * length spread over `durationFrames` windows).
 */
export function opennessEnvelope(pcm: Float32Array, durationFrames: number): number[] {
  const total = pcm.length;
  const open = new Array<number>(durationFrames).fill(0);
  if (total === 0 || durationFrames <= 0) return open;
  const samplesPerFrame = total / durationFrames;
  for (let f = 0; f < durationFrames; f++) {
    const start = Math.floor(f * samplesPerFrame);
    const end = Math.min(total, Math.floor((f + 1) * samplesPerFrame));
    let sumSq = 0;
    let n = 0;
    for (let i = start; i < end; i++) {
      const s = pcm[i] ?? 0;
      sumSq += s * s;
      n++;
    }
    const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
    open[f] = rmsToOpenness(rms);
  }
  // One-pole attack/decay smoothing (deterministic; coefficients are fps-independent enough for our use).
  const ATTACK = 0.6; // toward a louder target quickly
  const DECAY = 0.35; // close a bit slower
  let prev = 0;
  for (let f = 0; f < durationFrames; f++) {
    const target = open[f] ?? 0;
    const coeff = target > prev ? ATTACK : DECAY;
    const v = prev + (target - prev) * coeff;
    open[f] = Math.round(v * 1000) / 1000; // fixed precision → byte-stable JSON
    prev = v;
  }
  return open;
}

/**
 * Derive a coarse per-frame viseme CLASS LABEL from a whisper alignment: frames inside a spoken word →
 * "open", frames in the silent gaps → "closed" (a class a part-swap mouth provider MAY use). Length =
 * `durationFrames`. Pure. Returns null when no alignment is available (caller omits the label track).
 */
export function visemeLabels(
  words: AlignedWord[],
  fps: number,
  durationFrames: number,
): string[] | null {
  if (words.length === 0) return null;
  const labels = new Array<string>(durationFrames).fill('closed');
  for (const { start, end } of words) {
    const a = Math.max(0, Math.floor(start * fps));
    const b = Math.min(durationFrames, Math.ceil(end * fps));
    for (let f = a; f < b; f++) labels[f] = 'open';
  }
  return labels;
}

/** Read + validate a cached mouth-track JSON; returns null if malformed. */
function readMouthJson(jsonPath: string): MouthTrackData | null {
  try {
    const raw = JSON.parse(readFileSync(jsonPath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const o = raw as Partial<MouthTrackData>;
    if (typeof o.fps !== 'number' || !Array.isArray(o.open)) return null;
    if (!o.open.every((n) => typeof n === 'number')) return null;
    const out: MouthTrackData = { fps: o.fps, open: o.open as number[] };
    if (Array.isArray(o.viseme) && o.viseme.every((s) => typeof s === 'string')) {
      out.viseme = o.viseme as string[];
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Derive (or reuse) the per-frame mouth/viseme track for a narration clip, CACHED content-addressed
 * (skip-if-exists) under `<audioDir>/mouth/<hash>.json`. DETERMINISTIC: a cache hit replays the FIXED
 * samples; a cache miss decodes the wav ONCE (ffmpeg → RMS envelope) into the cache. NEVER fails the
 * build — a missing/failed ffmpeg decode returns null (the caller emits no mouth track → the rig idles).
 *
 * `wavHash` is the wav's content-address (from {@link NarrateResult}); `durationFrames` the narration's
 * frame span at `fps`; `alignWords` an optional whisper alignment (its presence adds a coarse viseme
 * label track). The samples are LOCAL-frame indexed (frame 0 = the clip's start).
 */
export function mouthTrackForNarration(
  wavPath: string,
  wavHash: string,
  fps: number,
  durationFrames: number,
  audioDir: string,
  alignWords?: AlignedWord[],
): MouthTrackData | null {
  const labelled = !!alignWords && alignWords.length > 0;
  const mouthDir = resolvePath(audioDir, 'mouth');
  const hash = mouthHash(wavHash, fps, durationFrames, labelled);
  const jsonPath = resolvePath(mouthDir, `${hash}.json`);

  // Cache hit → replay the FIXED samples (the deterministic record).
  if (existsSync(jsonPath)) {
    const cached = readMouthJson(jsonPath);
    if (cached) return cached;
    // Malformed cache file: fall through to re-derive (it will overwrite).
  }

  const pcm = decodePcm(wavPath);
  if (!pcm) return null; // ffmpeg unavailable/failed → no mouth track (never fail the build)

  const open = opennessEnvelope(pcm, durationFrames);
  const data: MouthTrackData = { fps, open };
  if (labelled) {
    const labels = visemeLabels(alignWords as AlignedWord[], fps, durationFrames);
    if (labels) data.viseme = labels;
  }

  mkdirSync(mouthDir, { recursive: true });
  // Stable key order + fixed-precision numbers → byte-stable JSON (a re-derive on the same inputs matches).
  writeFileSync(jsonPath, JSON.stringify(data));
  return data;
}
