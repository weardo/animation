// audio-pass.ts — lower the story's general `audio[]` LAYERED tracks (mix/overlap/crop/speed/fade) into
// Scene-IR `audio[]` cues. Sits alongside narration/sfx/music as another OFFLINE asset-gen step in the
// compile path (golden rule 2): a built-in bed/sfx NAME is synthesized into the shared library cache +
// copied into the project's self-contained assets/audio/; an `asset://`/path ref is passed through (the
// project vendors it). The cue carries the generic per-track controls (volume/playback_rate/trim/fade/
// loop) which the compositor maps 1:1 to Remotion `<Audio>` (golden rule 3: reuse, never reimplement).
// DETERMINISM (golden rule 1): the cached wav is the fixed record; every control is a pure fn of frame.
// Additive: existing narration/sfx/music cues are preserved.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { SceneIR, AudioCue, StoryIR, AudioTrack } from '../ir/index.js';
import { MUSIC_NAMES, synthMusic } from './music.js';
import { SFX_NAMES, synthSfx } from './sfx.js';

export interface AudioTracksOptions {
  /** Project assets dir (the render publicDir); built-in beds/sfx are copied to `<assets>/audio/`. */
  assetsDir: string;
  /** Repo root (to locate the shared `library/music/` + `library/sfx/` caches). */
  rootDir: string;
}

/** ffprobe a wav's duration → frames; null if missing/unprobeable. */
function probeFrames(wavPath: string, fps: number): number | null {
  if (!existsSync(wavPath)) return null;
  try {
    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wavPath],
      { encoding: 'utf8' },
    ).trim();
    const d = Number(out);
    return Number.isFinite(d) && d > 0 ? Math.max(1, Math.round(d * fps)) : null;
  } catch {
    return null;
  }
}

/** Resolve a track `at` (frames | {seconds} | undefined) → a non-negative frame. */
function atFrames(at: AudioTrack['at'], fps: number): number {
  if (at === undefined) return 0;
  if (typeof at === 'number') return Math.max(0, Math.round(at));
  return Math.max(0, Math.round(at.seconds * fps));
}

/** Resolve a Duration (number seconds | {seconds} | {frames}) → frames; undefined if absent. */
function durFrames(d: AudioTrack['duration'], fps: number): number | undefined {
  if (d === undefined) return undefined;
  if (typeof d === 'number') return Math.max(1, Math.round(d * fps));
  if ('frames' in d) return d.frames;
  return Math.max(1, Math.round(d.seconds * fps));
}

/**
 * Augment a lowered Scene IR with `kind:"audio"` (or the track's `kind`) cues from `story.audio[]`.
 * Returns the SAME IR object with `audio` extended + re-sorted (stable, diffable scene.json).
 */
export function applyAudioTracks(sceneIR: SceneIR, story: StoryIR, opts: AudioTracksOptions): SceneIR {
  const tracks = story.audio ?? [];
  if (tracks.length === 0) return sceneIR;

  const fps = sceneIR.config.fps;
  const total = Math.max(1, sceneIR.config.duration_frames);
  const audioDir = resolvePath(opts.assetsDir, 'audio');
  const cues: AudioCue[] = [...(sceneIR.audio ?? [])];

  tracks.forEach((t, i) => {
    // Resolve the cue src + the source length in frames (for default duration / loop tiling).
    let src: string;
    let srcFrames: number | null = null;
    if (MUSIC_NAMES.includes(t.src)) {
      const res = synthMusic(t.src, resolvePath(opts.rootDir, 'library', 'music'));
      mkdirSync(audioDir, { recursive: true });
      const dst = resolvePath(audioDir, `${t.src}.wav`);
      if (!existsSync(dst)) copyFileSync(res.libPath, dst);
      src = `audio://${res.publicRel}`;
      srcFrames = Math.max(1, Math.round(res.loopSeconds * fps));
    } else if (SFX_NAMES.includes(t.src)) {
      const res = synthSfx(t.src, resolvePath(opts.rootDir, 'library', 'sfx'), fps);
      mkdirSync(audioDir, { recursive: true });
      const dst = resolvePath(audioDir, `${t.src}.wav`);
      if (!existsSync(dst)) copyFileSync(res.libPath, dst);
      src = `audio://${res.publicRel}`;
      srcFrames = probeFrames(dst, fps);
    } else {
      // asset://… or a public-relative path — used verbatim (the project vendors it like any asset).
      src = t.src;
    }

    const at = atFrames(t.at, fps);
    const explicitDur = durFrames(t.duration, fps);
    // Default length: explicit → it; looped → fill the rest of the timeline; else the source length
    // (or the rest of the timeline if unknown).
    const duration_frames =
      explicitDur ?? (t.loop ? Math.max(1, total - at) : (srcFrames ?? Math.max(1, total - at)));

    const cue: AudioCue = {
      id: `audio-${i}-${t.src.replace(/[^A-Za-z0-9]+/g, '_')}`,
      kind: t.kind ?? 'audio',
      src,
      at,
      duration_frames,
      ...(t.volume !== undefined ? { volume: t.volume } : {}),
      ...(t.speed !== undefined ? { playback_rate: t.speed } : {}),
      ...(t.loop ? { loop: true } : {}),
      ...(t.loop && srcFrames ? { loop_frames: srcFrames } : {}),
      ...(t.fade_in !== undefined ? { fade_in: t.fade_in } : {}),
      ...(t.fade_out !== undefined ? { fade_out: t.fade_out } : {}),
      ...(t.trim?.before !== undefined ? { trim_before: t.trim.before } : {}),
      ...(t.trim?.after !== undefined ? { trim_after: t.trim.after } : {}),
    };
    cues.push(cue);
  });

  cues.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  const layered = cues.filter((c) => c.kind !== 'narration' && c.kind !== 'sfx' && c.kind !== 'music').length;
  console.log(`[audio] ${tracks.length} layered track(s) → ${layered} audio cue(s) → ${audioDir}`);
  return { ...sceneIR, audio: cues };
}
