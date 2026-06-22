// `bead-string` generator — a neuron chain. Spec §10, §15 (M1).
//
// Renders N beads placed along a path with:
//   • a TRAVELLING PULSE: `phase = frame*speed − index*phase_step` drives each bead's scale, so a
//     bright swell visibly runs down the chain (spec §10 "pulse propagation is one line").
//   • WAVY CONNECTOR BENDING: the chain's baseline is bent per-frame by seeded simplex noise and
//     smoothed with a d3-shape Catmull-Rom curve (the "axon" undulates organically).
//   • BLOBBY WOBBLE: each bead is a seeded simplex-perturbed closed blob, not a perfect circle.
//   • optional GLOW: an SVG gaussian-blur halo behind the beads.
//   • optional GOOEY merge: an SVG goo filter so close beads/the connector visually fuse.
//
// DETERMINISM: the component is a PURE function of (resolved props + frame). It reads `frame` from
// Remotion's `useCurrentFrame()` when mounted in the host, but all math lives in pure helpers
// (path.ts) seeded from the layer `seed`. No `Date.now`, no `Math.random`. (CLAUDE.md rule 1.)

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  BeadStringParamsSchema,
  resolveFill,
  type GeneratorComponentProps,
} from './types.js';
import { mixSeed } from './rng.js';
import {
  defaultBaseline,
  bendPoints,
  smoothPath,
  blobPath,
  type Point,
} from './path.js';

/**
 * Per-bead travelling-pulse scale. `phase = frame*speed − index*phase_step`; a raised cosine maps
 * the phase to a 0→1 swell so each bead pulses in turn as the wave passes. Pure.
 */
function pulseScale(
  frame: number,
  index: number,
  amp: number,
  speed: number,
  phaseStep: number,
): number {
  const phase = frame * speed - index * phaseStep;
  // (1+cos)/2 ∈ [0,1]; scale = 1 + amp * swell. cos so a crest is a clean swell, not a sharp spike.
  const swell = (1 + Math.cos(phase)) * 0.5;
  return 1 + amp * swell;
}

/**
 * Pure renderer: given fully-resolved primitive props (no hooks), produce the SVG. Split out from
 * the hook-using wrapper so it is trivially unit-testable as a pure function of (props, frame).
 */
export function renderBeadString(props: {
  seed: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  params: unknown;
  fill: string;
}): React.JSX.Element {
  const { seed, frame, fps, width, height, fill } = props;
  const p = BeadStringParamsSchema.parse(props.params);

  // 1. Build + bend the chain baseline → control points for THIS frame.
  const baseline = defaultBaseline(width, height, p.beads);
  const points = bendPoints(baseline, seed, frame, fps, {
    count: p.beads,
    bendAmp: p.wave.amp,
    bendSpeedHz: p.wave.speed,
  });

  // 2. Smooth connector path through the (bent) points — the "axon".
  const connectorD = smoothPath(points);

  // 3. Per-bead blob paths, scaled by the travelling pulse.
  const beads = points.map((pt: Point, i: number) => {
    const scale = pulseScale(
      frame,
      i,
      p.pulse.amp,
      p.pulse.speed,
      p.pulse.phase_step,
    );
    const r = p.bead_radius * scale;
    // Each bead gets its own deterministic sub-seed so wobble phases differ but reproduce.
    const beadSeed = mixSeed(seed, i + 1);
    const d = blobPath(pt.x, pt.y, r, p.blobbiness, beadSeed, frame, fps);
    return { d, scale, key: i };
  });

  // Stable, seed-namespaced filter ids so multiple bead-string layers don't collide in one SVG.
  const uid = `bead-${(seed >>> 0).toString(36)}`;
  const glowId = `${uid}-glow`;
  const gooId = `${uid}-goo`;

  // The connector + beads share the goo filter group so close shapes visually fuse (gooey merge).
  const beadGroup = (
    <g
      filter={p.gooey ? `url(#${gooId})` : undefined}
      fill={fill}
      stroke="none"
    >
      <path d={connectorD} fill="none" stroke={fill} strokeWidth={p.connector_width} strokeLinecap="round" />
      {beads.map((b) => (
        <path key={b.key} d={b.d} />
      ))}
    </g>
  );

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
    >
      <defs>
        {p.glow && (
          <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={p.bead_radius * 0.6} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
        {p.gooey && (
          // Classic SVG "gooey" filter: blur, then ramp alpha hard, then re-composite the source.
          <filter id={gooId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={p.bead_radius * 0.5} result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        )}
      </defs>
      {p.glow ? <g filter={`url(#${glowId})`}>{beadGroup}</g> : beadGroup}
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, resolves the palette-token fill, then delegates to the pure renderer.
 */
export const BeadString: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  // Allow an explicit frame/size override (for tests/headless) but default to the Remotion clock.
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = BeadStringParamsSchema.parse(props.params ?? {});
  const fill = resolveFill(parsed.fill, props.palette, '#ffcf4d');

  return renderBeadString({
    seed: props.seed,
    frame,
    fps,
    width,
    height,
    params: props.params ?? {},
    fill,
  });
};

export default BeadString;
