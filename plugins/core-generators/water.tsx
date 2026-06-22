// `water` generator — a flat-vector WATER surface. Spec §10 (`wave`/water surfaces), §10.1.
//
// The Kurzgesagt flat-design ocean: 2-3 stacked translucent wavy BANDS that scroll horizontally over
// time, building a sense of layered depth and gentle motion. Each band is:
//   • a CREST as a closed SVG polygon: its top edge is a sampled wave curve (a base sine + seeded
//     simplex undulation) and its bottom edge is the frame floor, so the band reads as a solid sheet
//     of water filled with a translucent palette token.
//   • SCROLLING horizontally: the wave phase advances with `frame` (a per-band horizontal offset), so
//     the whole surface drifts sideways. Back bands scroll slower than front bands (parallax-ish).
//   • optional FOAM dots sprinkled along the crest of the front band, bobbing on the surface.
//
// DETERMINISM (golden rule #1 / CLAUDE.md): the wave height at any (x, frame) is a CLOSED-FORM
// function — `sin(x*k − frame*speed) + simplex(x, band, frame)` — with NO accumulation/integration
// across frames. Remotion renders frames out-of-order across workers, so any per-frame state carry
// would diverge; here every band's crest and every foam dot's position is computed from scratch from
// (frame, index, seed). Seeded RNG only (mulberry32 + simplex from `seed`), never Math.random/Date.now.
//
// The math lives in the pure `renderWater(props)`; the exported `Water` component is the thin
// Remotion wrapper that reads the frame clock from `useCurrentFrame()` / `useVideoConfig()`.

import React from 'react';
import { z } from 'zod';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { resolveFill, type GeneratorComponentProps } from './types.js';
import { mulberry32, mixSeed } from './rng.js';
import { createNoise2D } from 'simplex-noise';

// --- water params -----------------------------------------------------------------------------

/**
 * Hard upper bound on foam-dot count (spec §10.1 shape budget). Counts above this are CLAMPED and the
 * drop is `console.warn`-ed — never silently truncated (CLAUDE.md "no silent caps").
 */
export const WATER_FOAM_BUDGET = 2000;

/**
 * The water generator params contract. Loose at the IR boundary (`z.record(unknown)` there), strict
 * here; every field is defaulted so a minimally-authored layer still renders a sensible ocean.
 */
export const WaterParamsSchema = z
  .object({
    /** Number of stacked translucent bands (back→front). Clamped to a sane 1..6. */
    bands: z.number().int().min(1).max(6).default(3),
    /** Peak vertical wave amplitude in px (the crest's rise/fall). Modulated per band. */
    amplitude: z.number().min(0).default(28),
    /** Wavelength in px (distance between sine crests). Smaller ⇒ choppier surface. */
    wavelength: z.number().positive().default(420),
    /** Horizontal scroll speed in px/second of the FRONT band (back bands scroll slower). */
    speed: z.number().default(60),
    /** Seeded simplex undulation strength as a fraction of `amplitude` (0 = pure sine). */
    chop: z.number().min(0).default(0.5),
    /**
     * Fill colors (palette tokens OR hex), back→front. If fewer than `bands`, the list cycles. Each
     * band is rendered translucent (see `opacity`) so overlaps deepen the color like layered water.
     */
    colors: z.array(z.string()).default(['#1b4965', '#2a6f97', '#468faf']),
    /** Per-band fill opacity 0..1 (kept translucent so stacked bands blend). */
    opacity: z.number().min(0).max(1).default(0.7),
    /**
     * Surface line: the front band's resting waterline as a fraction of height (0 = top, 1 = bottom).
     * Bands behind it sit progressively higher so their crests peek above the front band.
     */
    surface: z.number().min(0).max(1).default(0.55),
    /** Vertical gap between successive bands' resting waterlines, as a fraction of height. */
    band_gap: z.number().min(0).default(0.08),
    /** Sprinkle foam dots along the front band's crest. */
    foam: z.boolean().default(true),
    /** Number of foam dots requested (clamped to WATER_FOAM_BUDGET with a warning). */
    foam_count: z.number().int().min(0).default(60),
    /** Foam dot radius range in px, picked per-dot by seed: [min, max]. */
    foam_size: z.tuple([z.number().positive(), z.number().positive()]).default([1.5, 4]),
    /** Foam color (palette token OR hex). */
    foam_color: z.string().default('#eaf4f4'),
    /**
     * Horizontal sampling resolution of each crest curve, in px between sample points. Smaller =
     * smoother curve, more polygon points. Acts as the per-crest detail knob.
     */
    resolution: z.number().positive().default(24),
  })
  .strip();

export type WaterParams = z.infer<typeof WaterParamsSchema>;

/**
 * Closed-form wave height (vertical displacement, +down) at a given x for a band, AT a frame.
 *
 *   base sine:  sin(x·k − frame·ω)            — the scrolling primary swell
 *   + simplex:  noise(x·nk + bandOffset, t)   — seeded organic undulation that also travels in time
 *
 * Both terms are pure functions of (x, frame) — NO accumulation across frames. `noise2D` is built
 * once from the layer seed by the caller and shared across bands (band index decorrelates them via
 * a spatial offset so each band undulates differently but reproducibly).
 */
function waveHeight(
  x: number,
  frame: number,
  fps: number,
  band: number,
  amplitude: number,
  wavelength: number,
  speed: number,
  chop: number,
  noise2D: (x: number, y: number) => number,
): number {
  const k = (Math.PI * 2) / wavelength; // angular wavenumber
  // Time-based phase: speed is px/sec → convert to a phase advance via k. Pure in `frame`.
  const t = frame / fps;
  const phase = x * k - speed * t * k;
  const sine = Math.sin(phase);
  // Simplex sampled along x (scaled) + travelling time; band offset decorrelates bands.
  const noiseX = x / Math.max(1, wavelength * 0.5) + band * 7.13;
  const undulation = noise2D(noiseX, t * 0.35 + band * 3.7); // [-1, 1]
  return amplitude * (sine + chop * undulation);
}

/**
 * Pure renderer: given fully-resolved primitive props (no hooks), produce the SVG. Split from the
 * hook-using wrapper so it is trivially unit-testable as a pure function of (props, seed, frame).
 */
export function renderWater(props: {
  seed: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  params: unknown;
  /** Per-band colors, already palette-resolved by the wrapper. */
  colors: string[];
  /** Foam color, already palette-resolved by the wrapper. */
  foamColor: string;
}): React.JSX.Element {
  const { seed, frame, fps, width, height } = props;
  const p = WaterParamsSchema.parse(props.params);
  const colors = props.colors.length > 0 ? props.colors : ['#2a6f97'];

  // One seeded simplex field for the whole surface; bands decorrelate via a spatial offset.
  const noise2D = createNoise2D(mulberry32(mixSeed(seed, 0x77617665))); // "wave"

  // Sample step along x for the crest curves (smaller = smoother). Bound the point count so a tiny
  // resolution on a huge composition can't explode the polygon — honor the detail/budget intent.
  const step = Math.max(2, p.resolution);

  // Build bands back→front. Band 0 is furthest back (highest resting line, slowest scroll); the last
  // band is the front surface (lowest resting line = `surface`, fastest scroll).
  const bandCount = p.bands;
  const bandShapes: React.JSX.Element[] = [];
  // Track the front band's crest samples so foam can sit on it.
  let frontCrest: Array<{ x: number; y: number }> = [];

  for (let b = 0; b < bandCount; b++) {
    // Front band (highest index) sits at `surface`; each band behind sits `band_gap` higher.
    const fromFront = bandCount - 1 - b; // 0 for the front band
    const restY = (p.surface - fromFront * p.band_gap) * height;
    // Back bands scroll slower and undulate a touch less → a soft parallax of depth.
    const depthT = bandCount > 1 ? b / (bandCount - 1) : 1; // 0 back → 1 front
    const bandSpeed = p.speed * (0.4 + 0.6 * depthT);
    const bandAmp = p.amplitude * (0.7 + 0.3 * depthT);

    // Sample the crest curve across the full width (+ one extra step to reach the right edge).
    const crest: Array<{ x: number; y: number }> = [];
    for (let x = 0; x <= width + step; x += step) {
      const cx = Math.min(x, width);
      const y =
        restY +
        waveHeight(cx, frame, fps, b, bandAmp, p.wavelength, bandSpeed, p.chop, noise2D);
      crest.push({ x: cx, y });
    }

    // Closed polygon: crest top edge, then down the right side, along the floor, up the left side.
    const top = crest.map((pt) => `${pt.x.toFixed(2)},${pt.y.toFixed(2)}`).join(' ');
    const points = `${top} ${width.toFixed(2)},${height.toFixed(2)} 0,${height.toFixed(2)}`;
    const color = colors[b % colors.length]!;

    bandShapes.push(
      <polygon key={`band-${b}`} points={points} fill={color} opacity={p.opacity} />,
    );

    if (b === bandCount - 1) frontCrest = crest;
  }

  // Foam dots along the front crest (front band only). Each dot is anchored to a fixed x and rides
  // the crest height at THIS frame — closed-form, no carry. Per-dot size/x via a seeded sub-stream.
  const foamShapes: React.JSX.Element[] = [];
  if (p.foam && p.foam_count > 0 && frontCrest.length > 1) {
    let foamCount = p.foam_count;
    if (foamCount > WATER_FOAM_BUDGET) {
      // eslint-disable-next-line no-console
      console.warn(
        `[water] foam_count ${foamCount} exceeds shape budget ${WATER_FOAM_BUDGET}; ` +
          `clamping and dropping ${foamCount - WATER_FOAM_BUDGET} foam dots.`,
      );
      foamCount = WATER_FOAM_BUDGET;
    }

    const [fMin, fMax] = p.foam_size;
    // Front band's effective scroll (must match the front band above) so foam drifts WITH the water.
    const frontSpeed = p.speed; // front band depthT=1 → 0.4+0.6 = 1.0
    const frontAmp = p.amplitude; // front band depthT=1 → 0.7+0.3 = 1.0
    const restY = p.surface * height;
    const frontBandIndex = bandCount - 1;

    for (let i = 0; i < foamCount; i++) {
      const rng = mulberry32(mixSeed(seed, 0x666f_616d ^ (i + 1))); // "foam" ^ index
      // A fixed base-x for this dot; it then scrolls left with the front band's wave phase so the
      // foam appears to travel along the surface. Wrap with mod to keep it on-screen (looping).
      const baseX = rng() * width;
      const drift = ((frontSpeed * (frame / fps)) % width + width) % width;
      const x = ((baseX - drift) % width + width) % width;
      const y =
        restY +
        waveHeight(
          x,
          frame,
          fps,
          frontBandIndex,
          frontAmp,
          p.wavelength,
          frontSpeed,
          p.chop,
          noise2D,
        );
      const r = fMin + (fMax - fMin) * rng();
      // Gentle per-dot bob in opacity so foam shimmers (closed-form on frame + per-dot phase).
      const phase = rng() * Math.PI * 2;
      const bob = (1 + Math.cos((frame / fps) * Math.PI * 2 * 0.8 + phase)) * 0.5; // [0,1]
      foamShapes.push(
        <circle
          key={`foam-${i}`}
          cx={x.toFixed(2)}
          cy={y.toFixed(2)}
          r={r}
          fill={props.foamColor}
          opacity={(0.4 + 0.6 * bob).toFixed(3)}
        />,
      );
    }
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
    >
      {bandShapes}
      {foamShapes}
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, resolves palette-token colors, then delegates to the pure renderer.
 */
export const Water: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  // Allow explicit frame/size overrides (for tests/headless) but default to the Remotion clock.
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = WaterParamsSchema.parse(props.params ?? {});
  const colors = parsed.colors.map((c) => resolveFill(c, props.palette, '#2a6f97'));
  const foamColor = resolveFill(parsed.foam_color, props.palette, '#eaf4f4');

  return renderWater({
    seed: props.seed,
    frame,
    fps,
    width,
    height,
    params: props.params ?? {},
    colors,
    foamColor,
  });
};

export default Water;
