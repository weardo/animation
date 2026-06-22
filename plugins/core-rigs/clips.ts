// Clip selection — lower a Scene-IR `rig_state.clips` list to a per-frame DragonBones seek.
//
// `rig_state` is a THIN POINTER (spec §6.2, §8): it selects/sequences a rig's own internal named
// animations; it never re-describes bones. Each clip is `{ anim, loop?, at? }`:
//   • `at`   — scene-relative frame the clip starts (default 0).
//   • `loop` — if true the clip wraps; if false it holds its last pose after one play-through.
//
// For M1 we drive a SINGLE active clip per frame (the spike's pattern): pick the latest clip whose
// `at <= frame`, then compute the absolute time to seek that clip's AnimationState to. The
// DragonBones `currentTime` setter wraps looping internally, so we hand it the raw elapsed seconds
// and let it wrap — this is the order-independent absolute-seek the spike proved.
//
// PURE / DETERMINISTIC: a function of (clips, frame, fps) only. No clock, no random.

import type { RigClip } from '../../src/ir/index.js';

/** What to seek this frame: which animation, and to what absolute time (seconds). */
export interface ClipSeek {
  /** DragonBones animation name to drive. */
  readonly anim: string;
  /** Absolute time (seconds) to set on the animation state's `currentTime`. */
  readonly time: number;
  /** Whether this clip loops (informs how we treat times past the clip's duration). */
  readonly loop: boolean;
}

/**
 * Select the active clip for `frame` and compute its seek time.
 *
 * Selection: the clip with the greatest `at` that is `<= frame`. (Clips with `at` in the future are
 * not yet active; if several share the same `at`, the last in the array wins — author order.)
 * Falls back to the first clip if none has started yet (so frame 0 always has something to play).
 *
 * @param clips  the rig layer's `rig_state.clips` (non-empty per schema).
 * @param frame  scene-relative frame.
 * @param fps    composition fps.
 */
export function selectClip(
  clips: readonly RigClip[],
  frame: number,
  fps: number,
): ClipSeek {
  let active: RigClip = clips[0]!;
  let activeAt = active.at ?? 0;
  for (const clip of clips) {
    const at = clip.at ?? 0;
    if (at <= frame && at >= activeAt) {
      active = clip;
      activeAt = at;
    }
  }
  const elapsedFrames = Math.max(0, frame - (active.at ?? 0));
  const time = elapsedFrames / fps;
  return { anim: active.anim, time, loop: active.loop ?? false };
}
