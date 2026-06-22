// `particles` generator — a flowing PARTICLE field (drifting motes / rising bubbles / floating
// sparks). Spec §10, §10.1.
//
// N particles, each with a LOOPING, CLOSED-FORM lifecycle so the field reads as a continuous,
// never-ending stream while staying byte-reproducible:
//   • LIFECYCLE: each particle's progress along its loop is `phase = ((frame*speed + index*offset)
//     mod lifespan) / lifespan ∈ [0,1)`. The per-index `offset` staggers particles so they don't
//     all spawn/fade together. NOTHING is accumulated/integrated across frames — every particle's
//     full state is a pure function of (frame, index, seed). (Remotion renders frames out of order
//     across workers; any cross-frame accumulation would diverge → CLAUDE.md determinism rule.)
//   • POSITION: a fixed seeded "lane" x (and a base y/x along the travel axis), then the particle is
//     translated along the flow `direction` (up/down/drift) by `phase`. Wrapping is handled by the
//     `mod lifespan` above, so a particle leaving one edge is the same particle re-entering (cheap,
//     seamless loop).
//   • SWAY: a small lateral wobble from seeded `simplex-noise` sampled at (lane, phase) — coherent,
//     organic horizontal drift (bubbles bobbing, motes wafting). Pure (seeded), frame-driven.
//   • OPACITY: fades in over the first slice of the loop and out over the last slice (a raised-cosine
//     window) so particles are never popped in/out — they bloom and dissolve at the loop seam.
//   • SIZE/COLOR: drawn once per particle from its own seeded sub-stream (size range + color list).
//   • SHAPE BUDGET (§10.1): `count` is CLAMPED to PARTICLES_SHAPE_BUDGET and the drop is
//     console.warn-ed — never silently truncated (CLAUDE.md "no silent caps").
//
// DETERMINISM (golden rule #1): a PURE function of (params, seed, frame). It reads `frame` from
// Remotion's `useCurrentFrame()` when mounted, but all math lives in the pure `renderParticles`.
// No `Date.now`, no `Math.random`.

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { resolveFill, type GeneratorComponentProps } from './types.js';
import { mulberry32, mixSeed } from './rng.js';
import { createNoise2D } from 'simplex-noise';

// --- particles params --------------------------------------------------------------------------

/**
 * Hard upper bound on particle count (spec §10.1 shape budget). Counts above this are CLAMPED and
 * the drop is `console.warn`-ed — never silently truncated (CLAUDE.md "no silent caps" rule).
 */
export const PARTICLES_SHAPE_BUDGET = 2000;

/**
 * The particles generator params contract. Loose at the IR boundary, strict here; every field is
 * defaulted so a minimally-authored layer still renders. Defined INSIDE this file (NOT in types.ts).
 */
export const ParticlesParamsSchema = z
  .object({
    /** Number of particles requested (clamped to PARTICLES_SHAPE_BUDGET with a warning). */
    count: z.number().int().positive().default(120),
    /**
     * Flow direction of the field:
     *  - 'up'    motes/bubbles/sparks rising (base case: bubbles, embers).
     *  - 'down'  falling (dust, snow, rain of sparks).
     *  - 'drift' no net travel axis — particles hold their lane and only sway (floating dust).
     */
    direction: z.enum(['up', 'down', 'drift']).default('up'),
    /**
     * Travel speed in fraction-of-screen per second along the flow axis. Combined with `lifespan`
     * this sets how fast the loop turns over; with 'drift' it gently modulates the sway phase only.
     */
    speed: z.number().positive().default(0.12),
    /** Particle radius range in px, picked per-particle by seed: [min, max]. */
    size: z.tuple([z.number().positive(), z.number().positive()]).default([2, 6]),
    /** Palette tokens OR hex colors; one is picked per-particle by seed. */
    color: z.array(z.string()).default(['#ffffff']),
    /**
     * Loop length in seconds: a particle's full fade-in → travel → fade-out cycle. Larger ⇒ slower,
     * longer-lived particles. The per-index spawn offset is spread across this lifespan.
     */
    lifespan: z.number().positive().default(6),
    /** Lateral sway amplitude in px (seeded simplex wobble across the travel axis). 0 = straight. */
    sway: z.number().min(0).default(14),
    /** Sway frequency (cycles over one lifespan) — higher ⇒ tighter, busier wobble. */
    sway_speed: z.number().positive().default(1.2),
    /** Soft emissive glow (SVG gaussian-blur halo) behind the particles (good for sparks/bubbles). */
    glow: z.boolean().default(false),
    /** Base layer opacity 0..1. */
    opacity: z.number().min(0).max(1).default(1),
  })
  .strip();

export type ParticlesParams = z.infer<typeof ParticlesParamsSchema>;

/** A single particle's static (per-loop) draw + lane attributes, resolved once from its sub-stream. */
interface Particle {
  /** Fixed lane coordinate: x for up/down flows, y for drift (the axis NOT travelled). */
  lane: number;
  /** Base coordinate on the travel axis the loop starts from (0..1 of screen). */
  base: number;
  size: number;
  color: string;
  /** Per-particle spawn offset across the lifespan, so particles are out of step. [0,1). */
  offset: number;
  /** Per-particle sway phase so wobbles are decorrelated. */
  swayPhase: number;
}

/**
 * Closed-form loop window → opacity. `t ∈ [0,1)` is the particle's progress through its lifespan.
 * Fades in over the first `edge` and out over the last `edge` with a raised cosine, full in between.
 * Pure; guarantees opacity is continuous at the loop seam (t→1 ≡ t→0 both ≈ 0) so loops seamlessly.
 */
function lifeOpacity(t: number, edge = 0.18): number {
  if (t < edge) return (1 - Math.cos((t / edge) * Math.PI)) * 0.5; // 0 → 1
  if (t > 1 - edge) return (1 - Math.cos(((1 - t) / edge) * Math.PI)) * 0.5; // 1 → 0
  return 1;
}

/**
 * Pure renderer: given fully-resolved primitive props (no hooks), produce the SVG. Split from the
 * hook-using wrapper so it is trivially unit-testable as a pure function of (props, seed, frame).
 */
export function renderParticles(props: {
  seed: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  params: unknown;
  /** Per-particle colors, already palette-resolved by the wrapper. */
  colors: string[];
}): React.JSX.Element {
  const { seed, frame, fps, width, height } = props;
  const p = ParticlesParamsSchema.parse(props.params);
  const colors = props.colors.length > 0 ? props.colors : ['#ffffff'];

  // Shape budget (§10.1): clamp + warn, never silent-truncate.
  let count = p.count;
  if (count > PARTICLES_SHAPE_BUDGET) {
    // eslint-disable-next-line no-console
    console.warn(
      `[particles] count ${count} exceeds shape budget ${PARTICLES_SHAPE_BUDGET}; ` +
        `clamping and dropping ${count - PARTICLES_SHAPE_BUDGET} particles.`,
    );
    count = PARTICLES_SHAPE_BUDGET;
  }

  const [sizeMin, sizeMax] = p.size;

  // One dedicated seeded noise field for the lateral sway (independent sub-stream).
  const noise2D = createNoise2D(mulberry32(mixSeed(seed, 0x7377_6179))); // "sway"

  // Per-particle static attributes: one independent sub-stream per index (lane/base/size/color…).
  const particles: Particle[] = [];
  for (let i = 0; i < count; i++) {
    const rng = mulberry32(mixSeed(seed, i + 1));
    particles.push({
      lane: rng(),
      base: rng(),
      size: sizeMin + (sizeMax - sizeMin) * rng(),
      color: colors[Math.floor(rng() * colors.length) % colors.length]!,
      offset: rng(),
      swayPhase: rng() * Math.PI * 2,
    });
  }

  // Time (seconds) drives every closed-form lifecycle; NOTHING accumulates across frames.
  const time = frame / fps;
  const distance = p.lifespan * p.speed; // fraction-of-screen travelled over one lifespan

  const shapes = particles.map((pt, i) => {
    // Closed-form loop progress t ∈ [0,1): pure function of (frame, index, seed).
    const t = (((time / p.lifespan) + pt.offset) % 1 + 1) % 1;

    // Lateral sway: coherent seeded simplex sampled at (lane, looping phase). Wraps via cos/sin of
    // the loop angle so the sway value at t→1 matches t→0 (seamless loop).
    const swayAngle = t * Math.PI * 2 * p.sway_speed + pt.swayPhase;
    const swayN = noise2D(pt.lane * 8 + Math.cos(swayAngle), Math.sin(swayAngle)); // [-1,1]
    const swayOffset = swayN * p.sway;

    let cx: number;
    let cy: number;
    if (p.direction === 'drift') {
      // No net travel: hold lane, only sway. A second slow noise term gives gentle 2D wander.
      const swayN2 = noise2D(Math.sin(swayAngle), pt.lane * 8 + Math.cos(swayAngle));
      cx = pt.base * width + swayOffset;
      cy = pt.lane * height + swayN2 * p.sway;
    } else {
      // Vertical flow: lane is x, travel is y. 'up' decreases y as t grows; 'down' increases it.
      // base + signed(distance*t), wrapped into [0,1) so leaving one edge re-enters the other.
      const dir = p.direction === 'up' ? -1 : 1;
      const travel = (((pt.base + dir * distance * t) % 1) + 1) % 1;
      cx = pt.lane * width + swayOffset;
      cy = travel * height;
    }

    const opacity = lifeOpacity(t);

    return (
      <circle
        key={i}
        cx={cx}
        cy={cy}
        r={pt.size}
        fill={pt.color}
        opacity={opacity}
      />
    );
  });

  const group = <g>{shapes}</g>;

  // Stable, seed-namespaced filter id so multiple particles layers don't collide in one SVG.
  const uid = `particles-${(seed >>> 0).toString(36)}`;
  const glowId = `${uid}-glow`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
      opacity={p.opacity}
    >
      <defs>
        {p.glow && (
          <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={Math.max(0.5, sizeMax * 0.6)} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      {p.glow ? <g filter={`url(#${glowId})`}>{group}</g> : group}
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, resolves palette-token colors, then delegates to the pure renderer.
 */
export const Particles: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  // Allow explicit frame/size overrides (for tests/headless) but default to the Remotion clock.
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = ParticlesParamsSchema.parse(props.params ?? {});
  const colors = parsed.color.map((c) => resolveFill(c, props.palette, '#ffffff'));

  return renderParticles({
    seed: props.seed,
    frame,
    fps,
    width,
    height,
    params: props.params ?? {},
    colors,
  });
};

export default Particles;
