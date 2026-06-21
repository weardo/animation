// Deterministic seeded RNG for the generator library. Spec §2/§10, CLAUDE.md rule 1:
// seeded RNG only — NEVER `Math.random`. Everything a pure function of (seed, frame, params).
//
// `simplex-noise` (createNoise2D/3D) needs a `() => number` random source to build its permutation
// table; we feed it a seeded mulberry32 so the noise field is a pure function of the layer `seed`.
// The same RNG also drives per-bead static jitter (so each bead's wobble phase/size differs but is
// reproducible). No wall-clock, no global state — each call site constructs its own generator.

/**
 * mulberry32 — a tiny, fast, well-distributed 32-bit PRNG. Pure: a given 32-bit `seed` yields a
 * fixed, reproducible stream of numbers in [0, 1). Used both as the seed source for simplex-noise
 * and for one-time deterministic jitter. (Chosen over hand-rolling: it is the de-facto standard
 * small seedable PRNG and avoids `Math.random`.)
 */
export function mulberry32(seed: number): () => number {
  // Force to an unsigned 32-bit integer so the stream is identical across platforms.
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Mix two integers into one 32-bit seed deterministically. Lets a single layer `seed` fan out into
 * independent, reproducible sub-streams (e.g. one per channel: bending vs per-bead jitter) without
 * them correlating. Pure function of its inputs.
 */
export function mixSeed(seed: number, salt: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (salt >>> 0), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}
