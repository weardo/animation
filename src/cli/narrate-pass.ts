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

import type { SceneIR, AudioCue, StoryIR } from '../ir/index.js';
import {
  synthNarration,
  type NarrateEngine,
  DEFAULT_ENGINE,
  DEFAULT_VOICE,
  DEFAULT_WPM,
  type NarrateRequest,
} from './narrate.js';

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
}

/**
 * Augment a lowered Scene IR with narration `audio[]` cues synthesized from the story beats' `say`.
 * Pure-ish (deterministic given the cache): synthesizes each say ONCE (content-addressed, skip-if-
 * exists), measures its duration via ffprobe → `duration_frames` at the scene fps, and appends a
 * `kind:'narration'` cue at the matching scene's `at`. Beats with no `say`, or whose scene is missing,
 * are skipped. Returns the SAME IR object with `audio` replaced (existing non-narration cues kept).
 */
export function applyNarration(sceneIR: SceneIR, story: StoryIR, opts: NarrateOptions): SceneIR {
  const engine = opts.engine ?? DEFAULT_ENGINE;
  const voice = opts.voice ?? DEFAULT_VOICE[engine];
  const wpm = opts.wpm ?? DEFAULT_WPM;
  const fps = sceneIR.config.fps;
  const audioDir = resolvePath(opts.assetsDir, 'audio');

  // scene.id === beat.id; index scene start frames by id for the beat→timeline lookup.
  const sceneAt = new Map<string, number>();
  for (const scene of sceneIR.scenes) sceneAt.set(scene.id, scene.at ?? 0);

  // Preserve any non-narration cues already present (none today, but future SFX/music are additive).
  const cues: AudioCue[] = (sceneIR.audio ?? []).filter((c) => c.kind !== 'narration');

  let synthCount = 0;
  let cachedCount = 0;
  for (const beat of story.beats) {
    const say = beat.say?.trim();
    if (!say) continue;
    const at = sceneAt.get(beat.id);
    if (at === undefined) continue; // beat produced no scene (nothing renderable) — no place to anchor

    const req: NarrateRequest = { text: say, engine, voice, wpm };
    const res = synthNarration(req, audioDir, opts.rootDir);
    if (res.cached) cachedCount += 1;
    else synthCount += 1;

    cues.push({
      id: `narration-${beat.id}`,
      kind: 'narration',
      // The cue src is the public-relative path under the render publicDir (assets/). The compositor
      // resolves it with staticFile. An `audio://` scheme keeps it self-describing + parallel to asset://.
      src: `audio://${res.publicRel}`,
      at,
      duration_frames: Math.max(1, Math.round(res.durationSeconds * fps)),
      transcript: say,
    });
  }

  // Sort cues by start frame for a stable, diffable scene.json (deterministic ordering).
  cues.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  console.log(
    `[narrate] engine=${engine} voice="${voice}" → ${cues.filter((c) => c.kind === 'narration').length} narration cue(s) ` +
      `(${synthCount} synthesized, ${cachedCount} cached) → ${audioDir}`,
  );

  return { ...sceneIR, audio: cues };
}
