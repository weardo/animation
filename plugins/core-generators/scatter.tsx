// `scatter` generator — procedurally distribute many small shapes over a region. Spec §10, §10.1.
//
// The Kurzgesagt "hundreds of tiny shapes" density: starfields, dust, foliage, sparkle, crowds.
// N elements are placed over a rectangular region with seeded per-element variation:
//   • PLACEMENT: a jittered even GRID (default) or seeded uniform RANDOM. The grid keeps coverage
//     even (poisson-disc-like) while jitter breaks the mechanical lattice; random is pure uniform.
//   • PER-ELEMENT VARIATION: size, color (picked from `colors`), rotation and an animation phase are
//     each drawn from mulberry32(mixSeed(seed, index)) — one independent sub-stream per element.
//   • MOTIF: 'dot' = <circle>, 'star' = a 4-point sparkle <path>, 'blob' = blobPath(...) organic.
//   • ANIMATION: per-element opacity/scale/position driven by `frame + phase` (deterministic):
//       twinkle → opacity pulses; pulse → scale pulses; drift → slow circular position wander.
//   • optional GLOW: an SVG gaussian-blur halo (good for sparkle/starfields).
//   • SHAPE BUDGET (§10.1): count is CLAMPED to SCATTER_SHAPE_BUDGET and the drop is console.warn-ed
//     — never silently truncated (CLAUDE.md "no silent caps").
//
// DETERMINISM (golden rule #1): a PURE function of (params, seed, frame). It reads `frame` from
// Remotion's `useCurrentFrame()` when mounted, but all math lives in the pure `renderScatter`. No
// `Date.now`, no `Math.random`.

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  ScatterParamsSchema,
  SCATTER_SHAPE_BUDGET,
  resolveFill,
  type GeneratorComponentProps,
} from './types.js';
import { mulberry32, mixSeed } from './rng.js';
import { blobPath } from './path.js';

/** A single placed element after layout + per-element variation are resolved. */
interface Element {
  cx: number;
  cy: number;
  size: number;
  color: string;
  rotation: number; // degrees
  phase: number; // [0, 2π) per-element animation phase
}

/**
 * Place `count` points over the rectangular region [x, x+w] × [y, y+h].
 *
 * `grid`   — a near-square jittered grid: pick cols/rows ≈ √(count·aspect), walk cells row-major,
 *            offset each point inside its cell by a seeded jitter (fraction of the cell). Even
 *            coverage without the mechanical look. Cells beyond `count` are simply not emitted.
 * `random` — seeded uniform: each point is a fresh draw inside the region.
 *
 * Pure function of (region, count, distribution, jitter, seed).
 */
function placePoints(
  region: { x: number; y: number; w: number; h: number },
  count: number,
  distribution: 'grid' | 'random',
  jitter: number,
  seed: number,
): Array<{ x: number; y: number }> {
  const { x, y, w, h } = region;
  // One dedicated sub-stream for placement so it never correlates with per-element variation.
  const rng = mulberry32(mixSeed(seed, 0x706c_6163)); // "plac"
  const pts: Array<{ x: number; y: number }> = [];

  if (distribution === 'random') {
    for (let i = 0; i < count; i++) {
      pts.push({ x: x + rng() * w, y: y + rng() * h });
    }
    return pts;
  }

  // grid: choose cols/rows that tile the region roughly squarely and hold ≥ count cells.
  const aspect = w > 0 && h > 0 ? w / h : 1;
  const cols = Math.max(1, Math.ceil(Math.sqrt(count * aspect)));
  const rows = Math.max(1, Math.ceil(count / cols));
  const cellW = w / cols;
  const cellH = h / rows;
  let placed = 0;
  for (let r = 0; r < rows && placed < count; r++) {
    for (let c = 0; c < cols && placed < count; c++) {
      // Cell centre, then jitter within the cell by up to ±0.5·cell·jitter.
      const jx = (rng() - 0.5) * cellW * jitter;
      const jy = (rng() - 0.5) * cellH * jitter;
      pts.push({
        x: x + (c + 0.5) * cellW + jx,
        y: y + (r + 0.5) * cellH + jy,
      });
      placed++;
    }
  }
  return pts;
}

/** A 4-point sparkle (star) path centred at origin with outer radius `r`, before rotation. Pure. */
function sparklePath(r: number): string {
  const inner = r * 0.28; // waist between the four spikes — small = sharp sparkle
  // Points alternate outer-spike / inner-waist around the circle, starting at the top.
  return (
    `M 0 ${-r} ` +
    `L ${inner} ${-inner} ` +
    `L ${r} 0 ` +
    `L ${inner} ${inner} ` +
    `L 0 ${r} ` +
    `L ${-inner} ${inner} ` +
    `L ${-r} 0 ` +
    `L ${-inner} ${-inner} Z`
  );
}

/**
 * Per-element animation → { opacity multiplier, scale multiplier, dx, dy }. Driven purely by
 * `frame + phase` so it is deterministic and each element is out of step with its neighbours.
 *
 *  - twinkle: opacity oscillates in [0.25, 1] (a raised cosine on the phase-shifted clock).
 *  - pulse:   scale oscillates in [0.7, 1.3].
 *  - drift:   slow circular wander of radius `driftAmount`.
 *  - none:    identity.
 */
function animateElement(
  anim: 'none' | 'twinkle' | 'drift' | 'pulse',
  frame: number,
  fps: number,
  speedHz: number,
  phase: number,
  driftAmount: number,
): { opacity: number; scale: number; dx: number; dy: number } {
  if (anim === 'none') return { opacity: 1, scale: 1, dx: 0, dy: 0 };
  const t = (frame / fps) * speedHz * Math.PI * 2 + phase;
  switch (anim) {
    case 'twinkle': {
      const s = (1 + Math.cos(t)) * 0.5; // [0,1]
      return { opacity: 0.25 + 0.75 * s, scale: 1, dx: 0, dy: 0 };
    }
    case 'pulse': {
      const s = (1 + Math.cos(t)) * 0.5; // [0,1]
      return { opacity: 1, scale: 0.7 + 0.6 * s, dx: 0, dy: 0 };
    }
    case 'drift': {
      // Two phase-offset trig terms → a smooth, non-circular Lissajous wander.
      return {
        opacity: 1,
        scale: 1,
        dx: Math.cos(t) * driftAmount,
        dy: Math.sin(t * 0.9 + phase) * driftAmount,
      };
    }
    default:
      return { opacity: 1, scale: 1, dx: 0, dy: 0 };
  }
}

/**
 * Pure renderer: given fully-resolved primitive props (no hooks), produce the SVG. Split from the
 * hook-using wrapper so it is trivially unit-testable as a pure function of (props, seed, frame).
 */
export function renderScatter(props: {
  seed: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  params: unknown;
  /** Per-element colors, already palette-resolved by the wrapper. */
  colors: string[];
}): React.JSX.Element {
  const { seed, frame, fps, width, height } = props;
  const p = ScatterParamsSchema.parse(props.params);
  const colors = props.colors.length > 0 ? props.colors : ['#ffffff'];

  // Resolve the region against the full composition (region fields are optional).
  const region = {
    x: p.region.x ?? 0,
    y: p.region.y ?? 0,
    w: p.region.w ?? width,
    h: p.region.h ?? height,
  };

  // Shape budget (§10.1): clamp + warn, never silent-truncate.
  let count = p.count;
  if (count > SCATTER_SHAPE_BUDGET) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scatter] count ${count} exceeds shape budget ${SCATTER_SHAPE_BUDGET}; ` +
        `clamping and dropping ${count - SCATTER_SHAPE_BUDGET} elements.`,
    );
    count = SCATTER_SHAPE_BUDGET;
  }

  const [sizeMin, sizeMax] = p.size;
  const points = placePoints(region, count, p.distribution, p.jitter, seed);

  // Per-element variation: one independent sub-stream per index (size, color, rotation, phase).
  const elements: Element[] = points.map((pt, i) => {
    const rng = mulberry32(mixSeed(seed, i + 1));
    const size = sizeMin + (sizeMax - sizeMin) * rng();
    const color = colors[Math.floor(rng() * colors.length) % colors.length]!;
    const rotation = rng() * 360;
    const phase = rng() * Math.PI * 2;
    return { cx: pt.x, cy: pt.y, size, color, rotation, phase };
  });

  // Stable, seed-namespaced filter id so multiple scatter layers don't collide in one SVG.
  const uid = `scatter-${(seed >>> 0).toString(36)}`;
  const glowId = `${uid}-glow`;

  const shapes = elements.map((el, i) => {
    const a = animateElement(
      p.anim,
      frame,
      fps,
      p.anim_speed,
      el.phase,
      p.drift_amount,
    );
    const r = el.size * a.scale;
    const cx = el.cx + a.dx;
    const cy = el.cy + a.dy;

    if (p.motif === 'dot') {
      return (
        <circle
          key={i}
          cx={cx}
          cy={cy}
          r={r}
          fill={el.color}
          opacity={a.opacity}
        />
      );
    }
    if (p.motif === 'star') {
      // Build the sparkle at the origin then translate+rotate into place (cheap, exact).
      return (
        <path
          key={i}
          d={sparklePath(r)}
          fill={el.color}
          opacity={a.opacity}
          transform={`translate(${cx} ${cy}) rotate(${el.rotation})`}
        />
      );
    }
    // blob — organic closed path (reuses path.ts blobPath; its own seeded wobble).
    const blobSeed = mixSeed(seed, i + 1);
    return (
      <path
        key={i}
        d={blobPath(cx, cy, r, p.blobbiness, blobSeed, frame, fps)}
        fill={el.color}
        opacity={a.opacity}
      />
    );
  });

  const group = <g>{shapes}</g>;

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
            <feGaussianBlur stdDeviation={Math.max(0.5, sizeMax * 0.5)} result="blur" />
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
export const Scatter: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  // Allow explicit frame/size overrides (for tests/headless) but default to the Remotion clock.
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = ScatterParamsSchema.parse(props.params ?? {});
  const colors = parsed.colors.map((c) => resolveFill(c, props.palette, '#ffffff'));

  return renderScatter({
    seed: props.seed,
    frame,
    fps,
    width,
    height,
    params: props.params ?? {},
    colors,
  });
};

export default Scatter;
