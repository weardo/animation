// music-pass.ts — the WIRING that turns a story's `music` directive into a Scene-IR `audio[]` MUSIC
// cue (A3, spec §12). A music bed is a SINGLE track played UNDER the whole video, LOOPED to fill the
// timeline and DUCKED while narration speaks.
//
// MODEL. The story declares ONE `music` (a bare bed NAME / asset ref, or `{ ref, gain?, duck?, fade? }`).
// This pass resolves it to one `kind:"music"` cue spanning the WHOLE timeline (`at:0`,
// `duration_frames = config.duration_frames`), carrying `loop:true` + the `mix` controls (gain/duck/
// fade). The compositor plays it via Remotion `<Audio loop>` with a per-frame `volume(frame)` that
// dips from `gain` to `duck` while any NARRATION cue overlaps the frame (the ducking math is the
// compositor's, kept pure-by-frame so it is deterministic).
//
// Like narration + sfx, this is an OFFLINE asset-gen step in the COMPILE path: it runs AFTER lowering +
// narration/sfx (so the cue ordering is stable) and BEFORE scene.json is written. A built-in bed NAME
// is SYNTHESIZED ONCE into the shared `library/music/` cache (ffmpeg, deterministic — music.ts) and
// COPIED into the project's self-contained `assets/audio/`; an `asset://`/bare-path ref is passed
// straight through as the cue `src` (the project is expected to vendor it like any asset). DETERMINISM
// (golden rule 1): a fixed recipe → a fixed wav → a byte-identical, looped audio stream. Additive:
// existing narration/sfx cues are preserved; any prior music cue is replaced (one bed per video).

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { SceneIR, AudioCue, StoryIR } from '../ir/index.js';
import type { Music } from '../ir/story.js';
import { MUSIC_NAMES, synthMusic } from './music.js';

export interface MusicOptions {
  /** Project assets dir (the render publicDir); a synthesized bed wav is copied to `<assets>/audio/`. */
  assetsDir: string;
  /** Repo root (to locate the shared `library/music/` cache). */
  rootDir: string;
}

/** Mix defaults (A3): base bed volume, ducked volume while narration speaks, duck ramp length. */
export const DEFAULT_MUSIC_GAIN = 0.5;
export const DEFAULT_MUSIC_DUCK = 0.18;
export const DEFAULT_MUSIC_FADE = 8;

/** ffprobe a wav's duration → loop length in frames; null if the file is missing/unprobeable. */
function probeLoopFrames(wavPath: string, fps: number): number | null {
  if (!existsSync(wavPath)) return null;
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wavPath],
      { encoding: 'utf8' },
    ).trim();
    const d = Number(out);
    if (!Number.isFinite(d) || d <= 0) return null;
    return Math.max(1, Math.round(d * fps));
  } catch {
    return null;
  }
}

/** Normalize the story `music` (string shorthand or object) to `{ ref, gain, duck, fade }`. */
function normalizeMusic(m: Music): { ref: string; gain: number; duck: number; fade: number } {
  if (typeof m === 'string') {
    return { ref: m, gain: DEFAULT_MUSIC_GAIN, duck: DEFAULT_MUSIC_DUCK, fade: DEFAULT_MUSIC_FADE };
  }
  return {
    ref: m.ref,
    gain: m.gain ?? DEFAULT_MUSIC_GAIN,
    duck: m.duck ?? DEFAULT_MUSIC_DUCK,
    fade: m.fade ?? DEFAULT_MUSIC_FADE,
  };
}

/**
 * Augment a lowered Scene IR with ONE `kind:"music"` `audio[]` cue from the story's `music` directive.
 * Deterministic given the cache: a built-in bed is synthesized once into the shared library cache and
 * copied into the project assets; an `asset://`/bare-path ref is used verbatim. The cue spans the whole
 * timeline (`at:0`, full `duration_frames`), `loop:true`, with the resolved `mix` controls. Returns the
 * SAME IR object with `audio` extended (existing cues kept, any prior music replaced, re-sorted).
 */
export function applyMusic(sceneIR: SceneIR, story: StoryIR, opts: MusicOptions): SceneIR {
  if (!story.music) return sceneIR;
  const { ref, gain, duck, fade } = normalizeMusic(story.music);

  const fps = sceneIR.config.fps;

  // Resolve the cue `src` + the source loop length in FRAMES (so the renderer can <Loop>-tile it). A
  // built-in bed NAME → synthesize into library/music/ + copy into the project's assets/audio/ (self-
  // contained bundle); loop length comes from the recipe. An `asset://`/path ref → pass straight
  // through and ffprobe its duration (the project must vendor the file under assets/).
  let src: string;
  let detail: string;
  let loopFrames: number;
  if (MUSIC_NAMES.includes(ref)) {
    const libMusicDir = resolvePath(opts.rootDir, 'library', 'music');
    const res = synthMusic(ref, libMusicDir);
    const audioDir = resolvePath(opts.assetsDir, 'audio');
    mkdirSync(audioDir, { recursive: true });
    const dst = resolvePath(audioDir, `${ref}.wav`);
    if (!existsSync(dst)) copyFileSync(res.libPath, dst);
    src = `audio://${res.publicRel}`;
    loopFrames = Math.max(1, Math.round(res.loopSeconds * fps));
    detail = `bed "${ref}" (${res.cached ? 'cached' : 'synthesized'}, ${res.loopSeconds}s loop)`;
  } else {
    // A user-supplied ref (asset://… or a public-relative path). Used verbatim; the project must vendor
    // it (the asset pipeline handles `asset://` refs that appear in layers/defs). ffprobe its length so
    // the renderer can tile the loop; if the file isn't resolvable at compile time, fall back to the
    // full timeline (one play, no loop) rather than fail the build.
    src = ref.includes('://') ? ref : `audio://${ref}`;
    const rel = src.slice(src.indexOf('://') + 3);
    const probePath = resolvePath(opts.assetsDir, rel);
    loopFrames = probeLoopFrames(probePath, fps) ?? sceneIR.config.duration_frames;
    detail = `ref "${ref}"`;
  }

  // One music cue spanning the whole timeline, looped, carrying the mix controls.
  const total = sceneIR.config.duration_frames;
  const musicCue: AudioCue = {
    id: 'music-bed',
    kind: 'music',
    src,
    at: 0,
    duration_frames: total,
    loop: true,
    loop_frames: loopFrames,
    mix: { gain, duck, fade },
  };

  // Preserve every non-music cue; replace any prior music bed (one per video). Stable, diffable order.
  const cues: AudioCue[] = (sceneIR.audio ?? []).filter((c) => c.kind !== 'music');
  cues.push(musicCue);
  cues.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  console.log(
    `[music] 1 music bed → ${detail}, gain=${gain} duck=${duck} fade=${fade}f over ${total} frame(s)`,
  );

  return { ...sceneIR, audio: cues };
}
