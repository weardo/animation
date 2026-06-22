// `crowd` generator — a stadium of tiny silhouette creatures. Spec §10, §10.1.
//
// The "many tiny simple characters" density: a packed crowd of mini-creatures, each drawn as a
// HEAD circle + a rounded BODY blob in 2–3 palette colors, scattered across a region. Every
// character is instancing-cheap (two SVG primitives) and its full state is a CLOSED-FORM function
// of (index, seed, frame):
//   • PLACEMENT: a jittered even GRID (default, poisson-disc-like even coverage) or seeded uniform
//     RANDOM. One dedicated placement sub-stream so it never correlates with per-character look.
//   • PER-CHARACTER VARIATION: scale, body color, head color, a per-character phase offset and a
//     blink schedule offset are each drawn from mulberry32(mixSeed(seed, index)) — an independent
//     sub-stream per character, so neighbours look and move out of step.
//   • IDLE BOB: a vertical sinusoid `dy = bob_amp * cos(t + phase)` — a gentle stadium-of-breathing
//     motion. PURELY a function of (frame, phase): NO accumulation across frames.
//   • BLINK-LIKE SCALE: an occasional brief vertical squash. We map the looping clock through a
//     per-character phase to a short pulse window (a narrow raised-cosine spike), so each creature
//     "blinks"/bobs-down at its own offset. Closed-form, looping, frame-order-independent.
//   • SHAPE BUDGET (§10.1): count is CLAMPED to CROWD_SHAPE_BUDGET and the drop is console.warn-ed
//     — never silently truncated (CLAUDE.md "no silent caps").
//
// DETERMINISM (golden rule #1): a PURE function of (params, seed, frame). It reads `frame` from
// Remotion's `useCurrentFrame()` when mounted, but all math lives in the pure `renderCrowd`. No
// `Date.now`, no `Math.random`, and — critically for a "flowing" generator — no integration /
// accumulation across frames (Remotion renders frames out-of-order across workers).

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';
import { resolveFill, type GeneratorComponentProps } from './types.js';
import { mulberry32, mixSeed } from './rng.js';

// --- crowd params -----------------------------------------------------------------------------

/**
 * Rectangular region the crowd fills. Defaults to the full composition (resolved in the renderer
 * because width/height are not known here). All fields optional → a layer can omit `region` and get
 * the whole frame, or specify any subset to bound a sub-area (e.g. the lower third = "the stands").
 */
const CrowdRegionSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
  })
  .strip();

/**
 * Hard upper bound on character count (spec §10.1 shape budget). Counts above this are CLAMPED and
 * the drop is `console.warn`-ed — never silently truncated (CLAUDE.md "no silent caps" rule).
 * Each character is two SVG nodes, so the budget is half the scatter budget.
 */
export const CROWD_SHAPE_BUDGET = 1000;

/**
 * The crowd generator params contract. Loose at the IR boundary, strict here; every field defaulted
 * so a minimally-authored `{ gen: "crowd" }` layer still renders a full crowd.
 */
export const CrowdParamsSchema = z
  .object({
    /** Number of characters requested (clamped to CROWD_SHAPE_BUDGET with a warning). */
    count: z.number().int().positive().default(120),
    /** Region to fill; omitted fields fall back to the full composition (resolved at render time). */
    region: CrowdRegionSchema.default({}),
    /** Palette tokens OR hex colors for the BODY blob; one is picked per-character by seed. */
    colors: z.array(z.string()).default(['#5b8def', '#f06a6a', '#4dd6a8']),
    /** Optional palette tokens OR hex colors for the HEAD circle; falls back to `colors`. */
    head_colors: z.array(z.string()).default([]),
    /** Base body width in px (a character's overall size scales around this). */
    size: z.number().positive().default(16),
    /** Per-character size jitter as a fraction of `size`, 0..1 (0 = uniform, 0.5 = ±50%). */
    size_jitter: z.number().min(0).max(1).default(0.4),
    /** Idle vertical bob amplitude in px (the stadium "breathing"). */
    bob_amp: z.number().min(0).default(4),
    /** Idle bob speed in cycles/second (sampled at frame/fps). */
    bob_speed: z.number().positive().default(0.5),
    /** Blink/squash speed in cycles/second; each character blinks at its own phase offset. */
    blink_speed: z.number().positive().default(0.35),
    /** Vertical squash at the blink crest, 0..1 (0 = no blink, 0.35 = squash to 65% height). */
    blink_amount: z.number().min(0).max(1).default(0.3),
    /** Placement: jittered even grid (default) or seeded uniform random. */
    distribution: z.enum(['grid', 'random']).default('grid'),
    /** Grid jitter strength 0..1 (fraction of a cell). Ignored for `random`. */
    jitter: z.number().min(0).max(1).default(0.5),
    /** Base layer opacity 0..1. */
    opacity: z.number().min(0).max(1).default(1),
  })
  .strip();

export type CrowdParams = z.infer<typeof CrowdParamsSchema>;

// --- placement --------------------------------------------------------------------------------

/**
 * Place `count` points over the rectangular region [x, x+w] × [y, y+h]. Mirrors scatter's layout so
 * crowds and scatters distribute identically.
 *
 * `grid`   — a near-square jittered grid: pick cols/rows ≈ √(count·aspect), walk cells row-major,
 *            offset each point inside its cell by a seeded jitter (fraction of the cell).
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
  // One dedicated sub-stream for placement so it never correlates with per-character variation.
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

// --- per-character animation ------------------------------------------------------------------

/**
 * Closed-form per-character motion → { dy, squash }. Driven PURELY by `frame + per-character phase`
 * so it is deterministic, looping, and frame-order-independent (no accumulation):
 *
 *  - dy:     a gentle vertical bob, `bobAmp * cos(t_bob + phase)`.
 *  - squash: an occasional vertical squash ("blink"). We take the looping blink clock through this
 *            character's phase and raise a NARROW spike: ((1+cos)/2)^k concentrates the pulse near
 *            the crest, so most of the cycle the character is upright and it briefly squashes. The
 *            returned squash is a vertical-scale multiplier in [1 − blinkAmount, 1].
 */
function animateCharacter(
  frame: number,
  fps: number,
  phase: number,
  bobAmp: number,
  bobSpeedHz: number,
  blinkSpeedHz: number,
  blinkAmount: number,
): { dy: number; squash: number } {
  const tBob = (frame / fps) * bobSpeedHz * Math.PI * 2 + phase;
  const dy = bobAmp * Math.cos(tBob);

  // Blink: a sharp, brief pulse. ((1+cos)/2) ∈ [0,1]; raising to a high power keeps it ~0 for most
  // of the cycle and spikes to 1 near the crest → a quick squash, not a constant pulse.
  const tBlink = (frame / fps) * blinkSpeedHz * Math.PI * 2 + phase;
  const base = (1 + Math.cos(tBlink)) * 0.5;
  const spike = Math.pow(base, 8);
  const squash = 1 - blinkAmount * spike;

  return { dy, squash };
}

// --- render -----------------------------------------------------------------------------------

/** A single placed character after layout + per-character variation are resolved. */
interface Character {
  cx: number;
  cy: number;
  scale: number; // multiplier on the base size
  bodyColor: string;
  headColor: string;
  phase: number; // [0, 2π) per-character animation phase
}

/**
 * Pure renderer: given fully-resolved primitive props (no hooks), produce the SVG. Split from the
 * hook-using wrapper so it is trivially unit-testable as a pure function of (props, seed, frame).
 */
export function renderCrowd(props: {
  seed: number;
  frame: number;
  fps: number;
  width: number;
  height: number;
  params: unknown;
  /** Per-character body colors, already palette-resolved by the wrapper. */
  colors: string[];
  /** Per-character head colors, already palette-resolved by the wrapper (may be empty). */
  headColors: string[];
}): React.JSX.Element {
  const { seed, frame, fps, width, height } = props;
  const p = CrowdParamsSchema.parse(props.params);
  const bodyColors = props.colors.length > 0 ? props.colors : ['#5b8def'];
  // Head defaults to the body palette when no explicit head_colors are given.
  const headColors = props.headColors.length > 0 ? props.headColors : bodyColors;

  // Resolve the region against the full composition (region fields are optional).
  const region = {
    x: p.region.x ?? 0,
    y: p.region.y ?? 0,
    w: p.region.w ?? width,
    h: p.region.h ?? height,
  };

  // Shape budget (§10.1): clamp + warn, never silent-truncate.
  let count = p.count;
  if (count > CROWD_SHAPE_BUDGET) {
    // eslint-disable-next-line no-console
    console.warn(
      `[crowd] count ${count} exceeds shape budget ${CROWD_SHAPE_BUDGET}; ` +
        `clamping and dropping ${count - CROWD_SHAPE_BUDGET} characters.`,
    );
    count = CROWD_SHAPE_BUDGET;
  }

  const points = placePoints(region, count, p.distribution, p.jitter, seed);

  // Per-character variation: one independent sub-stream per index (scale, colors, phase).
  const characters: Character[] = points.map((pt, i) => {
    const rng = mulberry32(mixSeed(seed, i + 1));
    // scale ∈ [1 − size_jitter, 1 + size_jitter]
    const scale = 1 + (rng() * 2 - 1) * p.size_jitter;
    const bodyColor = bodyColors[Math.floor(rng() * bodyColors.length) % bodyColors.length]!;
    const headColor = headColors[Math.floor(rng() * headColors.length) % headColors.length]!;
    const phase = rng() * Math.PI * 2;
    return { cx: pt.x, cy: pt.y, scale, bodyColor, headColor, phase };
  });

  const shapes = characters.map((ch, i) => {
    const a = animateCharacter(
      frame,
      fps,
      ch.phase,
      p.bob_amp,
      p.bob_speed,
      p.blink_speed,
      p.blink_amount,
    );

    // Character geometry, all proportional to base size × per-character scale.
    const s = p.size * ch.scale;
    const bodyW = s; // body footprint width
    const headR = s * 0.32; // head circle radius
    const bodyH = s * 0.9; // body blob height (before squash)
    const cx = ch.cx;
    // cy is the character's "feet" line; bob shifts the whole creature vertically.
    const feetY = ch.cy + a.dy;

    // Vertical squash ("blink"): shrink height around the feet so the creature dips/blinks.
    const sH = bodyH * a.squash;
    const bodyTop = feetY - sH;
    const bodyRx = bodyW * 0.5;
    // Body = a rounded-top blob: a vertical capsule-ish shape via a single path (cheap, exact).
    // Start bottom-left, up the left side, arc over the top, down the right side, close along base.
    const bodyD =
      `M ${cx - bodyRx} ${feetY} ` +
      `L ${cx - bodyRx} ${bodyTop + bodyRx} ` +
      `Q ${cx - bodyRx} ${bodyTop} ${cx} ${bodyTop} ` +
      `Q ${cx + bodyRx} ${bodyTop} ${cx + bodyRx} ${bodyTop + bodyRx} ` +
      `L ${cx + bodyRx} ${feetY} Z`;

    // Head sits just above the squashed body top so it rides the blink too.
    const headCy = bodyTop - headR * 0.6;

    return (
      <g key={i}>
        <path d={bodyD} fill={ch.bodyColor} />
        <circle cx={cx} cy={headCy} r={headR} fill={ch.headColor} />
      </g>
    );
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
      opacity={p.opacity}
    >
      <g>{shapes}</g>
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, resolves palette-token colors, then delegates to the pure renderer.
 */
export const Crowd: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  // Allow explicit frame/size overrides (for tests/headless) but default to the Remotion clock.
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = CrowdParamsSchema.parse(props.params ?? {});
  const colors = parsed.colors.map((c) => resolveFill(c, props.palette, '#5b8def'));
  const headColors = parsed.head_colors.map((c) => resolveFill(c, props.palette, '#5b8def'));

  return renderCrowd({
    seed: props.seed,
    frame,
    fps,
    width,
    height,
    params: props.params ?? {},
    colors,
    headColors,
  });
};

export default Crowd;
