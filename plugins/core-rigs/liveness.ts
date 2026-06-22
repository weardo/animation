// Liveness overlays — the StyleKit "alive" defaults, as PURE DETERMINISTIC functions of frame.
//
// Spec §8 / §9: every character runs idle + breathing + Poisson blink + spring follow-through by
// default, so even a static shot feels alive. These overlays are layered ON TOP of the rig's seeked
// DragonBones pose (a small bone-offset nudge + slot visibility), never replacing it.
//
// DETERMINISM (CLAUDE.md golden rule 1): every function here is a pure function of
// `(frame, fps, seed, …constants)`. No Date.now, no Math.random. Randomness uses Remotion's seeded
// `random(seedString)` and noise uses `simplex-noise` seeded from the same seed. Two renders of the
// same frame produce byte-identical overlays.
//
// Liveness TUNING is a later task (per the goal); this module just wires the hooks so motion EXISTS
// and is correct/deterministic, drawing all magnitudes from the shared StyleKit constants.

import { spring, random } from 'remotion';
import { createNoise2D } from 'simplex-noise';
import {
  IDLE_DEFAULTS,
  BREATHING_DEFAULTS,
  BLINK_DEFAULTS,
  SPRING_BOUNCY,
} from '../../src/render/stylekit.js';

/** A small additive offset applied to a DragonBones bone's `offset` transform for one frame. */
export interface BoneOffset {
  /** X translation, px (armature space). */
  readonly x: number;
  /** Y translation, px. */
  readonly y: number;
  /** Rotation, radians (DragonBones `Transform.rotation` is radians). */
  readonly rotation: number;
}

const ZERO_OFFSET: BoneOffset = { x: 0, y: 0, rotation: 0 };
const DEG2RAD = Math.PI / 180;

/**
 * A seeded 2D simplex-noise sampler built from a string seed. Cached per seed so repeated frames of
 * the same rig reuse one noise function (the function itself is pure; caching only avoids re-seeding
 * cost and is itself deterministic).
 */
const noiseCache = new Map<string, ReturnType<typeof createNoise2D>>();
function seededNoise(seed: string): ReturnType<typeof createNoise2D> {
  const existing = noiseCache.get(seed);
  if (existing) return existing;
  // simplex-noise wants a () => number in [0,1); make it deterministic from the seed via Remotion
  // `random`. We derive a short pseudo-stream by salting the seed with a counter.
  let i = 0;
  const rng = () => random(`${seed}:noise:${i++}`);
  const noise = createNoise2D(rng);
  noiseCache.set(seed, noise);
  return noise;
}

/**
 * Head-bob: a damped-spring vertical follow-through that gives the head gentle secondary motion.
 * Built on Remotion `spring()` so it's frame-exact and deterministic. We drive a slow oscillating
 * "target" (via seeded noise) through the spring, so the head eases toward a wandering point rather
 * than snapping — the Kurzgesagt "alive" read.
 *
 * Returns a bone offset (mostly Y translation + a touch of rotation) to add to the head bone.
 */
export function headBob(frame: number, fps: number, seed: string): BoneOffset {
  const noise = seededNoise(`${seed}:headbob`);
  // Slow wandering target in [-1,1], sampled along the time axis.
  const t = (frame / fps) * IDLE_DEFAULTS.swaySpeedHz;
  const target = noise(t, 0);
  // Spring the response so motion has follow-through (under-damped, bouncy appendage feel).
  const s = spring({
    frame,
    fps,
    config: SPRING_BOUNCY,
    // Re-target continuously by treating the spring as a smoother of the noise target: scale the
    // settled spring value (→1) by the current target. This is deterministic per frame.
  });
  const amp = IDLE_DEFAULTS.driftAmplitudePx * 1.5;
  const y = target * amp * s;
  const rotation = target * IDLE_DEFAULTS.swayAmplitudeDeg * DEG2RAD * s;
  return { x: 0, y, rotation };
}

/**
 * Breathing: a slow vertical oscillation (chest/body rise-fall) as a small Y offset. Pure sine of
 * `frame/fps`, period from StyleKit. Applied to a body/torso bone.
 */
export function breathing(frame: number, fps: number): BoneOffset {
  const phase = (frame / fps) * (2 * Math.PI) / BREATHING_DEFAULTS.periodSeconds;
  // amplitude is a scale-delta in StyleKit; reuse it as a few px of body lift for the bone overlay.
  const y = Math.sin(phase) * BREATHING_DEFAULTS.amplitude * 60;
  return { x: 0, y, rotation: 0 };
}

/**
 * Idle micro-sway: seeded simplex sway (rotation) + positional drift on the whole armature, so the
 * character is never perfectly still. Pure function of frame + seed.
 */
export function idleSway(frame: number, fps: number, seed: string): BoneOffset {
  const noise = seededNoise(`${seed}:idle`);
  const ts = (frame / fps) * IDLE_DEFAULTS.swaySpeedHz;
  const td = (frame / fps) * IDLE_DEFAULTS.driftSpeedHz;
  const rotation = noise(ts, 0) * IDLE_DEFAULTS.swayAmplitudeDeg * DEG2RAD;
  const x = noise(0, td) * IDLE_DEFAULTS.driftAmplitudePx;
  const y = noise(td, 100) * IDLE_DEFAULTS.driftAmplitudePx;
  return { x, y, rotation };
}

/** Add two bone offsets (overlays compose additively). */
export function addOffsets(a: BoneOffset, b: BoneOffset): BoneOffset {
  return { x: a.x + b.x, y: a.y + b.y, rotation: a.rotation + b.rotation };
}

export { ZERO_OFFSET };

// ----------------------------------------------------------------------------------------------
// Poisson blink — a seeded blink schedule, so blinks feel natural (never metronomic) yet are
// byte-deterministic. We model inter-blink gaps as an exponential distribution (the Poisson
// process's gap law): gap = -ln(1-U)/λ, with U a seeded uniform. We unroll the schedule across the
// scene's frame span ONCE and then ask "is the eye closed at frame F?".
// ----------------------------------------------------------------------------------------------

/** A single blink: the eye is closed for `[startFrame, startFrame + closeFrames)`. */
export interface BlinkEvent {
  readonly startFrame: number;
}

/**
 * Build the deterministic blink schedule for `[0, durationFrames)`.
 * λ (mean blinks/sec) and close duration come from StyleKit BLINK_DEFAULTS.
 *
 * Pure: depends only on (durationFrames, fps, seed). Same inputs ⇒ same schedule.
 */
export function blinkSchedule(
  durationFrames: number,
  fps: number,
  seed: string,
): BlinkEvent[] {
  const lambdaPerFrame = BLINK_DEFAULTS.rateHz / fps; // expected blinks per frame
  if (lambdaPerFrame <= 0) return [];
  const events: BlinkEvent[] = [];
  let frame = 0;
  let i = 0;
  // Cap iterations defensively (1 per frame is the theoretical max we'd ever emit).
  while (frame < durationFrames && i < durationFrames + 1) {
    const u = random(`${seed}:blink:${i}`); // seeded uniform in [0,1)
    i++;
    // Exponential inter-arrival gap (in frames). Clamp u away from 1 to keep ln finite.
    const gapFrames = -Math.log(1 - Math.min(u, 0.999999)) / lambdaPerFrame;
    frame += Math.max(1, Math.round(gapFrames));
    if (frame < durationFrames) {
      events.push({ startFrame: frame });
    }
  }
  return events;
}

/** True if a blink (eye-closed) is active at `frame`, given the schedule. */
export function isBlinking(schedule: readonly BlinkEvent[], frame: number): boolean {
  const close = BLINK_DEFAULTS.closeFrames;
  for (const ev of schedule) {
    if (frame >= ev.startFrame && frame < ev.startFrame + close) return true;
    if (ev.startFrame > frame) break; // schedule is sorted ascending
  }
  return false;
}
