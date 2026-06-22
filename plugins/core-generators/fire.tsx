// `fire` generator — stylized FIRE + SMOKE. Spec §10 (generators), §10.1 (shape budget).
//
// A flat, Kurzgesagt-style flame: a few LAYERED blobby teardrop shapes stacked back-to-front, each
// in a warm gradient (deep red → orange → yellow toward the core), that flicker every frame by
// per-flame seeded simplex noise wobbling the silhouette and scaling/swaying the whole tongue. Above
// the flame, optional rising SMOKE blobs fade out as they climb.
//
//   • FLAMES: `flames` teardrop tongues, drawn back (largest, reddest) → front (smallest, yellow).
//     Each tongue is a closed blob path built like path.ts::blobPath but biased into a TEARDROP
//     (narrow, pointed top; round, wide base) and pinned to a common base point. Per-frame flicker =
//     simplex noise on the vertices + a noise-driven horizontal sway + vertical scale pulse.
//   • SMOKE: rising fading blobs above the flame. Each blob's lifecycle is a CLOSED-FORM looping
//     function of (frame, index, seed): a phase that wraps with modulo, mapping to rise height, grow,
//     drift and fade. NO accumulation across frames (Remotion renders frames out of order across
//     workers — integration would diverge), so the loop is exactly reproducible at any frame.
//   • WARM GRADIENT: each flame layer fills from a radial warm gradient (core hot, edge cooler),
//     deterministic ids derived from the layer seed so multiple fire layers never collide.
//   • SHAPE BUDGET (§10.1): total drawn shapes (flames + smoke) are CLAMPED to FIRE_SHAPE_BUDGET and
//     the drop is console.warn-ed — never silently truncated (CLAUDE.md "no silent caps").
//
// DETERMINISM (golden rule #1): a PURE function of (params, seed, frame). It reads `frame` from
// Remotion's `useCurrentFrame()` when mounted, but all math lives in the pure `renderFire`. No
// `Date.now`, no `Math.random` — seeded mulberry32 + simplex-noise only, and every animated value is
// a closed-form function of (frame, index, seed) with a looping lifecycle.

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { resolveFill, type GeneratorComponentProps } from './types.js';
import { mulberry32, mixSeed } from './rng.js';
import { line as d3line, curveCatmullRomClosed } from 'd3-shape';
import { createNoise2D } from 'simplex-noise';
import type { Point } from './path.js';

// --- fire params --------------------------------------------------------------------------------

/**
 * Hard upper bound on drawn shapes (spec §10.1 shape budget). Flames + smoke above this are CLAMPED
 * and the drop is `console.warn`-ed — never silently truncated (CLAUDE.md "no silent caps" rule).
 */
export const FIRE_SHAPE_BUDGET = 200;

/** Warm-flame color stops (core → edge), one warm gradient per layer, hottest at the inner core. */
const SmokeParamsSchema = z
  .object({
    /** Number of rising smoke puffs (looping closed-form lifecycle). */
    puffs: z.number().int().min(0).default(6),
    /** Smoke blob base radius in px (grows as it rises). */
    radius: z.number().positive().default(28),
    /** How high (px) a puff rises over one lifecycle before looping. */
    rise: z.number().positive().default(420),
    /** Lifecycle length in frames; the looping period of each puff. */
    lifespan: z.number().positive().default(150),
    /** Sideways drift amplitude in px as the puff climbs. */
    drift: z.number().min(0).default(40),
    /** Peak opacity of a puff at the brightest part of its life. */
    opacity: z.number().min(0).max(1).default(0.28),
    /** Smoke color: a CSS color OR a `defs.palette` token name. */
    color: z.string().default('#6b6b76'),
  })
  .strip();

/**
 * The full fire params contract (spec §10). Loose at the IR boundary, strict here; every field has a
 * default so a minimally-authored layer still renders a believable flame.
 */
export const FireParamsSchema = z
  .object({
    /** Number of layered flame tongues (back→front, largest/reddest→smallest/yellow). */
    flames: z.number().int().positive().default(4),
    /** Flame height in px (base → tip of the tallest, backmost tongue). */
    height: z.number().positive().default(260),
    /** Flame base width in px (the widest tongue's footprint). */
    width: z.number().positive().default(150),
    /** Flicker speed (cycles/second of the silhouette wobble + sway + pulse). */
    flicker_speed: z.number().positive().default(1.6),
    /** Flicker intensity 0..1: how strongly the silhouette wobbles and the tongue sways/pulses. */
    flicker: z.number().min(0).max(1).default(0.5),
    /** Warm gradient stops, core→edge. First = hottest (innermost). Palette tokens OR hex. */
    colors: z
      .array(z.string())
      .default(['#fff3a0', '#ffb028', '#f5641e', '#c01e1e']),
    /** Toggle the rising smoke above the flame. */
    smoke: z.boolean().default(true),
    /** Smoke sub-params (only used when `smoke` is true). */
    smoke_params: SmokeParamsSchema.default({}),
    /** Soft emissive glow (SVG gaussian-blur halo) behind the flame. */
    glow: z.boolean().default(true),
    /** Base layer opacity 0..1. */
    opacity: z.number().min(0).max(1).default(1),
  })
  .strip();

export type FireParams = z.infer<typeof FireParamsSchema>;

/**
 * Build one TEARDROP flame-tongue closed path: pointed at the top, round + wide at the base, pinned
 * to (baseX, baseY). Vertices are sampled around a parametric teardrop and perturbed per-frame by
 * seeded simplex noise (the flicker). A CLOSED Catmull-Rom curve smooths it into an organic tongue.
 *
 * Pure function of all arguments. The teardrop profile: radius widens from the tip (top) down to the
 * base, with a `taper` that pinches the top to a point and rounds the bottom.
 */
function teardropPath(
  baseX: number,
  baseY: number,
  flameW: number,
  flameH: number,
  flickerAmt: number,
  noise2D: (x: number, y: number) => number,
  noiseTime: number,
): string {
  const segments = 16; // enough vertices for a smooth, lively tongue, still cheap
  const pts: Point[] = [];
  for (let i = 0; i < segments; i++) {
    // t around the closed silhouette in [0,1). We parametrize by height-fraction up one side and
    // back down the other so the tip is sharp and the base is round.
    const t = i / segments;
    // Map t∈[0,1) to a vertical fraction v∈[0,1] (0 = base, 1 = tip), going up the right side
    // (t∈[0,0.5]) and down the left side (t∈[0.5,1]).
    const up = t < 0.5;
    const v = up ? t * 2 : (1 - t) * 2; // 0 at base, 1 at tip, on both sides
    // Half-width profile: a flame tongue is widest a bit above the base then pinches to the tip.
    // sin(pi*v)^0.7 gives a round base, broad belly, sharp tip. Pinch hard near the tip.
    const profile = Math.pow(Math.sin(Math.PI * v * 0.5), 0.6) * (1 - v * 0.85);
    const halfW = (flameW * 0.5) * profile;
    const side = up ? 1 : -1;
    // Flicker: noise on (angle-ish, height, time) wobbles the silhouette edge. Stronger up high
    // (the tip dances more than the base).
    const wob =
      noise2D(side * 1.3 + v * 2.2, noiseTime) * flickerAmt * flameW * 0.18 * v;
    const x = baseX + side * halfW + wob;
    const y = baseY - flameH * v;
    pts.push({ x, y });
  }
  const gen = d3line<Point>()
    .x((q) => q.x)
    .y((q) => q.y)
    .curve(curveCatmullRomClosed.alpha(0.5));
  const d = gen(pts);
  return d ? `${d}Z` : '';
}

/**
 * Pure renderer: given fully-resolved primitive props (no hooks), produce the SVG. Split out from the
 * hook-using wrapper so it is trivially unit-testable as a pure function of (props, seed, frame).
 */
export function renderFire(props: {
  seed: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  params: unknown;
  /** Flame gradient stops (core→edge), already palette-resolved by the wrapper. */
  colors: string[];
  /** Smoke color, already palette-resolved by the wrapper. */
  smokeColor: string;
}): React.JSX.Element {
  const { seed, frame, fps, width, height } = props;
  const p = FireParamsSchema.parse(props.params);
  const colors =
    props.colors.length > 0 ? props.colors : ['#fff3a0', '#ffb028', '#f5641e', '#c01e1e'];

  // Base point: the flame sits on the bottom-centre of the composition (typical hearth/torch spot).
  const baseX = width * 0.5;
  const baseY = height * 0.92;

  // Shape budget (§10.1): clamp flames + smoke together; clamp + warn, never silent-truncate.
  let flameCount = p.flames;
  const smokeCount = p.smoke ? p.smoke_params.puffs : 0;
  let smokeDrawn = smokeCount;
  const requested = flameCount + smokeCount;
  if (requested > FIRE_SHAPE_BUDGET) {
    // Flames are the subject — keep them, then fill the remaining budget with smoke.
    flameCount = Math.min(flameCount, FIRE_SHAPE_BUDGET);
    smokeDrawn = Math.max(0, FIRE_SHAPE_BUDGET - flameCount);
    // eslint-disable-next-line no-console
    console.warn(
      `[fire] shape count ${requested} exceeds shape budget ${FIRE_SHAPE_BUDGET}; ` +
        `clamping and dropping ${requested - FIRE_SHAPE_BUDGET} shapes ` +
        `(drawing ${flameCount} flames + ${smokeDrawn} smoke puffs).`,
    );
  }

  // Stable, seed-namespaced ids so multiple fire layers don't collide in one SVG.
  const uid = `fire-${(seed >>> 0).toString(36)}`;
  const glowId = `${uid}-glow`;

  // --- flame tongues: back (i=0, largest/reddest) → front (smallest, yellow) -------------------
  const flickerHz = p.flicker_speed;
  const flameShapes: React.JSX.Element[] = [];
  const gradientDefs: React.JSX.Element[] = [];
  for (let i = 0; i < flameCount; i++) {
    // Each tongue gets its own deterministic sub-seed → independent flicker phase, reproducible.
    const flameSeed = mixSeed(seed, i + 1);
    const noise2D = createNoise2D(mulberry32(mixSeed(flameSeed, 0x666c_616d))); // "flam"
    const noiseTime = (frame / fps) * flickerHz + i * 0.7;

    // Front tongues are smaller and warmer. Scale from 1.0 (back) down to ~0.45 (front).
    const layerT = flameCount > 1 ? i / (flameCount - 1) : 0;
    const sizeScale = 1 - layerT * 0.55;

    // Vertical "breathing" pulse — a closed-form cosine of (frame, layer), looping.
    const pulsePhase = (frame / fps) * flickerHz * Math.PI * 2 + i * 1.3;
    const pulse = 1 + Math.cos(pulsePhase) * 0.08 * p.flicker;
    // Horizontal sway — noise-driven lean of the whole tongue (more for front, lighter tongues).
    const sway =
      noise2D(7.0 + i, noiseTime * 0.8) * p.flicker * p.width * 0.06 * (0.5 + layerT);

    const flameW = p.width * sizeScale;
    const flameH = p.height * sizeScale * pulse;

    const d = teardropPath(
      baseX + sway,
      baseY,
      flameW,
      flameH,
      p.flicker,
      noise2D,
      noiseTime,
    );

    // Warm radial gradient for this tongue: hottest (first color) at the core near the base, cooler
    // (last color) at the edges. Front tongues bias toward the hotter inner colors.
    const gradId = `${uid}-grad-${i}`;
    const stopCount = colors.length;
    // Front layers (high layerT) start partway into the color list so they read hotter/yellower.
    const startIdx = Math.min(stopCount - 1, Math.floor(layerT * (stopCount - 1) * 0.6));
    const usable = colors.slice(startIdx);
    const stops = (usable.length > 0 ? usable : colors).map((c, si, arr) => (
      <stop
        key={si}
        offset={arr.length > 1 ? si / (arr.length - 1) : 0}
        stopColor={c}
      />
    ));
    gradientDefs.push(
      <radialGradient
        key={gradId}
        id={gradId}
        cx="50%"
        cy="78%"
        r="75%"
        gradientUnits="objectBoundingBox"
      >
        {stops}
      </radialGradient>,
    );

    flameShapes.push(<path key={`flame-${i}`} d={d} fill={`url(#${gradId})`} />);
  }

  // --- rising smoke: closed-form looping lifecycle per puff ------------------------------------
  const smokeShapes: React.JSX.Element[] = [];
  if (p.smoke && smokeDrawn > 0) {
    const s = p.smoke_params;
    const smokeNoise = createNoise2D(mulberry32(mixSeed(seed, 0x736d_6f6b))); // "smok"
    // Smoke starts just above the flame tip.
    const smokeBaseY = baseY - p.height * 0.85;
    for (let i = 0; i < smokeDrawn; i++) {
      const puffSeed = mulberry32(mixSeed(seed, 0x70750000 ^ (i + 1)));
      const phaseOffset = puffSeed() * s.lifespan; // static per-puff stagger
      const sizeRng = 0.7 + puffSeed() * 0.6; // per-puff base-size variation
      const driftDir = puffSeed() < 0.5 ? -1 : 1;

      // CLOSED-FORM looping phase ∈ [0,1): NO accumulation across frames.
      const phase = (((frame + phaseOffset) % s.lifespan) + s.lifespan) % s.lifespan / s.lifespan;

      const y = smokeBaseY - phase * s.rise;
      // Sway via noise sampled on (puff index, phase) — coherent, deterministic per frame.
      const dx =
        driftDir * Math.sin(phase * Math.PI) * s.drift +
        smokeNoise(i * 1.7, phase * 3.0) * s.drift * 0.5;
      const x = baseX + dx;
      // Grow as it rises; fade in then out (raised sine over the life).
      const r = s.radius * sizeRng * (0.6 + phase * 0.9);
      const fade = Math.sin(phase * Math.PI); // 0 at birth/death, 1 mid-life
      const opacity = s.opacity * fade;
      if (opacity <= 0.001) continue;

      // A blobby puff: reuse the teardrop builder is overkill — a wobbling round blob reads as smoke.
      const blobNoise = createNoise2D(mulberry32(mixSeed(seed, 0x736b0000 ^ (i + 1))));
      const segs = 10;
      const pts: Point[] = [];
      const wobbleTime = (frame / fps) * 0.5 + i;
      for (let k = 0; k < segs; k++) {
        const a = (k / segs) * Math.PI * 2;
        const nx = Math.cos(a);
        const ny = Math.sin(a);
        const w = blobNoise(nx + wobbleTime, ny - wobbleTime);
        const rr = r * (1 + w * 0.35);
        pts.push({ x: x + nx * rr, y: y + ny * rr });
      }
      const gen = d3line<Point>()
        .x((q) => q.x)
        .y((q) => q.y)
        .curve(curveCatmullRomClosed.alpha(0.5));
      const d = gen(pts);
      smokeShapes.push(
        <path key={`smoke-${i}`} d={d ? `${d}Z` : ''} fill={props.smokeColor} opacity={opacity} />,
      );
    }
  }

  const flameGroup = <g>{flameShapes}</g>;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
      opacity={p.opacity}
    >
      <defs>
        {gradientDefs}
        {p.glow && (
          <filter id={glowId} x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={Math.max(2, p.width * 0.08)} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        )}
      </defs>
      {/* Smoke sits BEHIND/above the flame, drawn first so the flame reads in front. */}
      {smokeShapes.length > 0 && <g>{smokeShapes}</g>}
      {p.glow ? <g filter={`url(#${glowId})`}>{flameGroup}</g> : flameGroup}
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, resolves palette-token colors, then delegates to the pure renderer.
 */
export const Fire: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  // Allow explicit frame/size overrides (for tests/headless) but default to the Remotion clock.
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = FireParamsSchema.parse(props.params ?? {});
  const colors = parsed.colors.map((c) => resolveFill(c, props.palette, '#ffb028'));
  const smokeColor = resolveFill(parsed.smoke_params.color, props.palette, '#6b6b76');

  return renderFire({
    seed: props.seed,
    frame,
    fps,
    width,
    height,
    params: props.params ?? {},
    colors,
    smokeColor,
  });
};

export default Fire;
