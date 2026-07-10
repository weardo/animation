// narrate-pass.ts — the WIRING that turns each beat's `say` into a Scene-IR `audio[]` cue.
//
// Narration is an OFFLINE asset-gen step in the COMPILE path (render.ts), consistent with how the
// font + factory:gen source material are produced offline and vendored. It runs AFTER lowering (so it
// can read each scene's global timeline `at`) and BEFORE scene.json is written + the bundle rendered.
//
// MAPPING: the lowering pass emits one scene per beat, and `scene.id === beat.id` with `scene.at` the
// scene's GLOBAL start frame. So for every beat that has a `say`, we synthesize a clip (cached) and
// emit an AudioCue { kind:'narration', src:<vendored wav>, at:<scene.at>, duration_frames, transcript }
// placed at the BEAT's scene start. The wav lands in the project's assets/audio/ (the render publicDir),
// so the bundle is self-contained and the cue `src` is the public-relative path the compositor resolves
// via staticFile. DETERMINISM: the synth is cached/content-addressed (skip-if-exists), so re-running on
// the same story reuses the same wavs and the same cues → byte-identical audio + video.

import { resolve as resolvePath } from 'node:path';

import type { SceneIR, Scene, Layer, AudioCue, CaptionCue, MouthTrack, StoryIR, Beat, Voice } from '../ir/index.js';
import {
  synthNarration,
  alignNarration,
  timedWordsFromAlignment,
  flowWordsFromEnglish,
  mouthTrackForNarration,
  type NarrateEngine,
  type AlignedWord,
  DEFAULT_ENGINE,
  DEFAULT_VOICE,
  DEFAULT_WPM,
  type NarrateRequest,
} from './narrate.js';
import { translateToEnglish, isEnglishLang } from './caption-english.js';

/** The TTS engine ids the narrate pass accepts; an authored `voice.engine` outside this set is ignored. */
const KNOWN_ENGINES: ReadonlySet<NarrateEngine> = new Set<NarrateEngine>([
  'espeak-ng', 'coqui', 'kokoro', 'chatterbox', 'parler', 'indic-parler', 'indicf5', 'sarvam',
]);

/**
 * This pass's id + version — folded into provenance + the determinism story. Adding the optional
 * voice/tone authoring surface (cast[].voice + beat.voice/tone → a per-beat NarrateRequest carrying
 * engine+voice+tone+style) changes how a beat's narration is synthesized, so bump it (cache-
 * invalidation rule). The wav cache key already incorporates the full NarrateRequest (engine/voice/
 * wpm/tone/style), so a voice change re-synthesizes a fresh wav regardless; this version pins the
 * pass behavior in provenance.
 *
 * M4 (whisper word-sync captions): after synthesizing/locating a narration wav, force-align it to its
 * transcript via faster-whisper (OFFLINE, cached content-addressed) → per-word LOCAL frame timings on
 * the `words`-mode CaptionCue (`wordsTimed[]`), so the renderer reveals words on their REAL spoken
 * times. This changes the emitted captions → bump the version (cache-invalidation rule). Whisper
 * missing / alignment failing → the even-split `words[]` fallback (never fail the build).
 *
 * M4b (lip-sync visemes): for each narrated beat whose scene has a SPEAKER rig layer (the first
 * on-screen actor — the same convention `resolveBeatVoice` uses to pick the cast voice), derive a
 * per-frame mouth-openness / viseme track OFFLINE from the cached narration wav (RMS energy envelope →
 * 0..1, cached content-addressed) and attach it to that rig layer's generic `mouth` channel. The
 * blob-creature provider reads it to open/close in sync; other providers ignore it. Opt-in (default on;
 * `--no-lip-sync` off). A beat with no narration → no mouth track (the rig idles). This changes the
 * emitted scene → bump the version (cache-invalidation rule). ffmpeg missing → no track (never fail).
 */
export const PASS_ID = 'narrate';
export const PASS_VERSION = '1.4'; // 1.4: `flow` caption mode (English karaoke synced to speech)

/**
 * Resolve the EFFECTIVE voice for one beat's narration: the per-beat override ?? the speaking cast
 * member's standing `cast[].voice` ?? (the caller's CLI/engine defaults, applied below). Returns a
 * partial {@link Voice} (only the authored fields); unset fields fall through to the run defaults.
 *
 * SPEAKER: a beat has no explicit "speaker" field (the front-end is generic), so the cast voice is
 * taken from the FIRST `show[].actor` the beat brings on screen (the conventional on-screen narrator);
 * a beat with no actor uses only its own override (or the defaults). The per-beat `voice` block plus
 * the `tone` shorthand are merged over the cast voice (beat wins; an explicit `voice.tone` beats the
 * `tone` shorthand). Pure: a function of the story + beat. No wall-clock, no RNG.
 */
function resolveBeatVoice(beat: Beat, story: StoryIR): Voice {
  // Cast voice: the first on-screen actor's standing voice (generic — no domain speaker field).
  const speaker = (beat.show ?? []).find((s) => s.actor)?.actor;
  const castVoice: Voice = (speaker && story.cast[speaker]?.voice) || {};
  // Per-beat override block + the `tone` shorthand (explicit voice.tone wins over the shorthand).
  const beatVoice: Voice = { ...(beat.voice ?? {}) };
  if (beat.tone !== undefined && beatVoice.tone === undefined) beatVoice.tone = beat.tone;
  // Merge: beat fields override cast fields (only defined keys override, so unset falls through).
  const merged: Voice = { ...castVoice };
  for (const [k, v] of Object.entries(beatVoice)) {
    if (v !== undefined) (merged as Record<string, unknown>)[k] = v;
  }
  return merged;
}

/** Build the NarrateRequest `style` map (chatterbox params) from a resolved voice; undefined if empty. */
function styleFromVoice(v: Voice): Record<string, number> | undefined {
  const style: Record<string, number> = {};
  if (typeof v.exaggeration === 'number') style['exaggeration'] = v.exaggeration;
  if (typeof v.cfg === 'number') style['cfg'] = v.cfg;
  return Object.keys(style).length > 0 ? style : undefined;
}

export interface NarrateOptions {
  /** TTS engine (default espeak-ng). Coqui falls back to espeak-ng if its venv is missing. */
  engine?: NarrateEngine | undefined;
  /** Engine voice id (espeak-ng voice or Coqui speaker). Defaults per-engine. */
  voice?: string | undefined;
  /** espeak-ng pace (words per minute). */
  wpm?: number | undefined;
  /** Project assets dir (the render publicDir); wavs go to `<assets>/audio/`. */
  assetsDir: string;
  /** Repo root (to locate the optional Coqui venv). */
  rootDir: string;
  /**
   * Emit on-screen CAPTION cues synced to each narration line (A1; default true). `--no-captions`
   * sets this false. Captions are DERIVED from the authored transcript + the cue window (deterministic,
   * no whisper), so they cost nothing extra to produce.
   */
  captions?: boolean | undefined;
  /**
   * Caption cadence: `line` (whole line — default), `words` (cumulative reveal), or `flow` (karaoke — a
   * rolling ENGLISH phrase that highlights the spoken word; subtitles are translated to English and timed
   * to the real speech via whisper). `words`/`flow` are timed by forced-alignment, else even-split.
   */
  captionMode?: 'line' | 'words' | 'flow' | undefined;
  /**
   * Narration language (e.g. "hi-IN", "en-IN"). Used by `flow` captions to decide whether to translate to
   * English (non-English → translate; English → use the transcript verbatim). Defaults to $SARVAM_LANG.
   */
  captionLang?: string | undefined;
  /**
   * M4: force-align each narration wav to its transcript via faster-whisper (OFFLINE, cached content-
   * addressed) for PRECISE per-word caption timings (`words` mode only). Default true; missing whisper
   * venv / alignment failure falls back to even-split (never fails the build). `--no-word-align` sets
   * this false to skip the (slow, first-run only) whisper step and use even-split directly.
   */
  align?: boolean | undefined;
  /**
   * M4b: derive a per-frame MOUTH-OPENNESS / viseme track from each narration wav (OFFLINE, cached
   * content-addressed) and attach it to the speaking rig layer's generic `mouth` channel so a provider
   * (blob-creature) can lip-sync. Default true; `--no-lip-sync` sets this false. ffmpeg missing / decode
   * failure → no track (the rig idles; never fails the build). A beat with no narration carries none.
   */
  lipSync?: boolean | undefined;
}

/**
 * The SPEAKER rig-layer id for a beat: the first on-screen `actor`'s handle (`as ?? actor`), matching
 * how lowering names a rig layer (`L_rig_<handle>`) and how {@link resolveBeatVoice} picks the cast
 * voice. Returns undefined when the beat brings no actor on screen (no rig to lip-sync). Pure.
 */
function speakerRigId(beat: Beat): string | undefined {
  const item = (beat.show ?? []).find((s) => s.actor);
  if (!item) return undefined;
  const handle = item.as ?? item.actor;
  return handle ? `L_rig_${handle}` : undefined;
}

/**
 * Augment a lowered Scene IR with narration `audio[]` cues synthesized from the story beats' `say`.
 * Pure-ish (deterministic given the cache): synthesizes each say ONCE (content-addressed, skip-if-
 * exists), measures its duration via ffprobe → `duration_frames` at the scene fps, and appends a
 * `kind:'narration'` cue at the matching scene's `at`. Beats with no `say`, or whose scene is missing,
 * are skipped. Returns the SAME IR object with `audio` replaced (existing non-narration cues kept).
 */
export function applyNarration(sceneIR: SceneIR, story: StoryIR, opts: NarrateOptions): SceneIR {
  // Run-level DEFAULTS (CLI flags). A beat/cast voice overrides these per beat (resolveBeatVoice).
  const defaultEngine = opts.engine ?? DEFAULT_ENGINE;
  const defaultWpm = opts.wpm ?? DEFAULT_WPM;
  const fps = sceneIR.config.fps;
  const audioDir = resolvePath(opts.assetsDir, 'audio');

  // scene.id === beat.id; index scene start frames by id for the beat→timeline lookup.
  const sceneAt = new Map<string, number>();
  for (const scene of sceneIR.scenes) sceneAt.set(scene.id, scene.at ?? 0);

  // Preserve any non-narration cues already present (none today, but future SFX/music are additive).
  const cues: AudioCue[] = (sceneIR.audio ?? []).filter((c) => c.kind !== 'narration');
  // Captions are re-derived here from this run's narration lines (replace any prior caption set).
  const wantCaptions = opts.captions !== false;
  const captionMode = opts.captionMode ?? 'line';
  // `flow` needs the whisper speech timeline too (to ride the real narration pace).
  const wantAlign = opts.align !== false && (captionMode === 'words' || captionMode === 'flow');
  // `flow` captions are ALWAYS English: translate unless the narration itself is English.
  const captionLang = opts.captionLang ?? process.env['SARVAM_LANG'];
  const translateCaptions = captionMode === 'flow' && !isEnglishLang(captionLang);
  // Brand accent for the active-word highlight (a caption-edge override; else the renderer's saffron default).
  const brandAccent = sceneIR.defs?.stylekit?.brand?.accent?.captionEdge;
  const wantLipSync = opts.lipSync !== false;
  const captions: CaptionCue[] = [];
  // M4b: mouth tracks keyed by the SPEAKER rig-layer id (one per narrated beat with an on-screen actor),
  // applied onto that scene's rig layer after the loop. scene.id === beat.id, so a (sceneId, rigId) pair
  // is unique; we key by `${sceneId}::${rigId}`.
  const mouthByLayer = new Map<string, MouthTrack>();

  let synthCount = 0;
  let cachedCount = 0;
  let alignedCount = 0; // captions with REAL whisper word timings
  let evenSplitCount = 0; // word-mode captions that fell back to even-split
  let lipSyncCount = 0; // beats that got a mouth track
  for (const beat of story.beats) {
    const say = beat.say?.trim();
    if (!say) continue;
    const at = sceneAt.get(beat.id);
    if (at === undefined) continue; // beat produced no scene (nothing renderable) — no place to anchor

    // Resolve the EFFECTIVE voice for this beat: per-beat override ?? cast voice ?? run defaults.
    const v = resolveBeatVoice(beat, story);
    const engine: NarrateEngine =
      v.engine && KNOWN_ENGINES.has(v.engine as NarrateEngine)
        ? (v.engine as NarrateEngine)
        : defaultEngine;
    // Voice id: an authored voice id, else the run default voice (only meaningful when the run default
    // engine is used; per engine the DEFAULT_VOICE label keeps the cache key stable).
    const voice = v.voice ?? opts.voice ?? DEFAULT_VOICE[engine];
    const wpm = typeof v.wpm === 'number' ? v.wpm : defaultWpm;
    const tone = v.tone;
    const style = styleFromVoice(v);

    const req: NarrateRequest = {
      text: say,
      engine,
      voice,
      wpm,
      ...(tone !== undefined ? { tone } : {}),
      ...(style !== undefined ? { style } : {}),
      // Sarvam Bulbul target language (en-IN/hi-IN); env-driven so the studio can set it per video.
      ...(engine === 'sarvam' ? { lang: process.env['SARVAM_LANG'] ?? 'hi-IN' } : {}),
    };
    const res = synthNarration(req, audioDir, opts.rootDir);
    if (res.cached) cachedCount += 1;
    else synthCount += 1;

    const durationFrames = Math.max(1, Math.round(res.durationSeconds * fps));
    cues.push({
      id: `narration-${beat.id}`,
      kind: 'narration',
      // The cue src is the public-relative path under the render publicDir (assets/). The compositor
      // resolves it with staticFile. An `audio://` scheme keeps it self-describing + parallel to asset://.
      src: `audio://${res.publicRel}`,
      at,
      duration_frames: durationFrames,
      transcript: say,
    });

    // CAPTION: one caption per narration line, sharing the cue's exact window. `line` mode is the
    // whole transcript for the window. `words` mode pre-tokenizes for an even-split reveal AND (M4)
    // attempts whisper forced-alignment for REAL per-word timings. We KEEP any computed alignment to
    // reuse as M4b viseme labels (so lip-sync gets word/gap classes for free when captions aligned).
    let alignWords: AlignedWord[] | undefined;
    if (wantCaptions) {
      const cap: CaptionCue = {
        id: `caption-${beat.id}`,
        text: say,
        at,
        duration_frames: durationFrames,
        mode: captionMode,
      };
      if (captionMode === 'words' || captionMode === 'flow') {
        // The whisper speech timeline (real per-word timings) — shared by both modes. Missing / failed →
        // even-split fallback (never fail the build).
        let al: { aligned: boolean; words: AlignedWord[] } = { aligned: false, words: [] };
        if (wantAlign) {
          al = alignNarration(res.wavPath, res.hash, say, audioDir, opts.rootDir);
          if (al.aligned && al.words.length > 0) alignWords = al.words; // reused for coarse viseme labels
        }

        if (captionMode === 'flow') {
          // ENGLISH subtitle text (translated once, cached), timed to the real speech pace so it FLOWS with
          // the narration (a muted viewer reads along). English narration → use the transcript verbatim.
          const english = translateCaptions ? translateToEnglish(say, opts.rootDir) : say;
          cap.text = english;
          const timed = flowWordsFromEnglish(english, alignWords, fps, durationFrames);
          // Keep `words` and `wordsTimed` the SAME token list (flow merges lone punctuation) so the
          // renderer's chunking (words) and active-index (wordsTimed) never drift apart.
          cap.words = timed.length > 0 ? timed.map((t) => t.w) : english.split(/\s+/).filter(Boolean);
          if (timed.length > 0) cap.wordsTimed = timed;
          if (brandAccent) cap.accent = brandAccent;
          if (alignWords) alignedCount += 1;
          else evenSplitCount += 1;
        } else {
          // `words`: cumulative reveal of the transcript at real spoken times (M4).
          cap.words = say.split(/\s+/).filter(Boolean);
          const timed = alignWords ? timedWordsFromAlignment(alignWords, fps, durationFrames) : [];
          if (timed.length > 0) {
            cap.wordsTimed = timed;
            alignedCount += 1;
          } else {
            evenSplitCount += 1;
          }
        }
      }
      captions.push(cap);
    }

    // M4b LIP-SYNC: derive a per-frame mouth-openness/viseme track from this clip's cached wav (OFFLINE,
    // content-addressed; ffmpeg RMS envelope) and stage it for the beat's SPEAKER rig layer. The track is
    // LOCAL-frame indexed (frame 0 = the clip's start = the scene start, since the cue `at` === scene.at),
    // so the provider samples it by its own scene-local frame. Opt-in; ffmpeg missing → no track (idle).
    if (wantLipSync) {
      const rigId = speakerRigId(beat);
      if (rigId) {
        const md = mouthTrackForNarration(res.wavPath, res.hash, fps, durationFrames, audioDir, alignWords);
        if (md) {
          const track: MouthTrack = { fps: md.fps, open: md.open };
          if (md.viseme) track.viseme = md.viseme;
          mouthByLayer.set(`${beat.id}::${rigId}`, track);
          lipSyncCount += 1;
        }
      }
    }
  }

  // Sort cues + captions by start frame for a stable, diffable scene.json (deterministic ordering).
  cues.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  captions.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  // M4b: apply the staged mouth tracks onto the speaker rig layers (immutable rewrite). A scene's rig
  // layer gets `mouth` iff this run derived a track for it; lip-sync off / no actor / no narration → no
  // change (the rig idles, byte-identical to before). Pure structural attach: no clock, no RNG.
  const scenes: Scene[] = mouthByLayer.size === 0
    ? sceneIR.scenes
    : sceneIR.scenes.map((scene) => {
        let touched = false;
        const layers: Layer[] = scene.layers.map((layer) => {
          if (layer.type !== 'rig') return layer;
          const track = mouthByLayer.get(`${scene.id}::${layer.id}`);
          if (!track) return layer;
          touched = true;
          return { ...layer, mouth: track };
        });
        return touched ? { ...scene, layers } : scene;
      });

  console.log(
    `[narrate] default engine=${defaultEngine} (per-beat voice/tone overrides honored) → ` +
      `${cues.filter((c) => c.kind === 'narration').length} narration cue(s) ` +
      `(${synthCount} synthesized, ${cachedCount} cached)` +
      (wantCaptions
        ? ` + ${captions.length} caption(s) [${captionMode}]` +
          (captionMode === 'words'
            ? ` (${alignedCount} whisper-aligned, ${evenSplitCount} even-split)`
            : '')
        : ' (captions off)') +
      (wantLipSync ? ` + ${lipSyncCount} lip-sync mouth track(s)` : ' (lip-sync off)') +
      ` → ${audioDir}`,
  );

  return {
    ...sceneIR,
    audio: cues,
    captions: wantCaptions ? captions : (sceneIR.captions ?? []),
    scenes,
  };
}
