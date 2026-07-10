// `chart` generator — deterministic, animatable data-viz (bar / line / pie+donut). Adopts d3-shape
// (arc/pie/line/area + curve factories) for geometry — we do NOT reimplement curve/arc math (CLAUDE.md
// rule 3 "reuse over invent"). A linear axis scale is a trivial pure helper (scale.ts); d3-scale is NOT
// a dependency.
//
// One registry entry `chart` dispatches on a `kind` discriminant (bar/line/pie). Each kind grows in via
// the shared draw-on ramp (scale.ts) driven PURELY by `frame` — bars rise from a baseline, the line
// strokes on via stroke-dash, slices sweep open. No motion is linear by default (easeOut/spring;
// CLAUDE.md rule 7).
//
// DETERMINISM (golden rule #1): a PURE function of (params, frame). All draw-on math is frame-driven;
// there is no RNG and no clock. `seed` is accepted (generator contract) but unused — charts are data,
// not procedural noise. It reads `frame` from `useCurrentFrame()` only in the thin mounted wrapper;
// all geometry lives in the pure `renderChart`.

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  arc as d3arc,
  pie as d3pie,
  line as d3line,
  area as d3area,
  curveLinear,
  curveMonotoneX,
  curveCatmullRom,
  curveStepAfter,
  type CurveFactory,
} from 'd3-shape';
import {
  ChartParamsSchema,
  CHART_POINT_BUDGET,
  resolveFill,
  type GeneratorComponentProps,
  type ChartParams,
  type Datum,
} from './types.js';
import { linearScale, drawProgress, ease } from './scale.js';

/** Map the line `curve` enum → a d3-shape curve factory. */
function curveFactory(kind: 'linear' | 'monotone' | 'catmull-rom' | 'step'): CurveFactory {
  switch (kind) {
    case 'linear':
      return curveLinear;
    case 'monotone':
      return curveMonotoneX;
    case 'catmull-rom':
      return curveCatmullRom;
    case 'step':
      return curveStepAfter;
    default:
      return curveMonotoneX;
  }
}

/** Clamp the dataset to the point budget (warn, never silent-truncate; §10.1 / CLAUDE.md). */
function clampData(data: Datum[], kind: string): Datum[] {
  if (data.length <= CHART_POINT_BUDGET) return data;
  // eslint-disable-next-line no-console
  console.warn(
    `[chart:${kind}] data length ${data.length} exceeds point budget ${CHART_POINT_BUDGET}; ` +
      `clamping and dropping ${data.length - CHART_POINT_BUDGET} points.`,
  );
  return data.slice(0, CHART_POINT_BUDGET);
}

interface RenderCtx {
  frame: number;
  width: number;
  height: number;
  colorFor: (d: Datum, i: number) => string;
}

/** Resolve the plotting box (inside the inset) in absolute layer coordinates. */
function plotBox(p: ChartParams, width: number, height: number) {
  const { top, right, bottom, left } = p.inset;
  return {
    x: left,
    y: top,
    w: Math.max(0, width - left - right),
    h: Math.max(0, height - top - bottom),
  };
}

// --- BAR ---------------------------------------------------------------------------------------

/** Format a datum value for the on-bar label: integers get thousands separators (1,045); a fractional
 *  index keeps 2 decimals (8.57). Deterministic (no locale API). */
function fmtVal(v: number): string {
  const neg = v < 0;
  const a = Math.abs(v);
  const s = Number.isInteger(a) ? String(a) : a.toFixed(a < 100 ? 2 : 0);
  const [int, dec] = s.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped + (dec ? '.' + dec : '');
}

function renderBar(p: Extract<ChartParams, { kind: 'bar' }>, ctx: RenderCtx): React.JSX.Element {
  const data = clampData(p.data, 'bar');
  const box = plotBox(p, ctx.width, ctx.height);
  const vertical = p.orientation === 'vertical';

  const values = data.map((d) => d.value);
  const lo = Math.min(p.baseline, ...values, 0);
  const hi = Math.max(p.baseline, ...values, 0);
  const n = data.length;

  // Band layout along the category axis.
  const along = vertical ? box.w : box.h;
  const band = n > 0 ? along / n : 0;
  const barThick = band * (1 - p.gap);
  // A readable label size scaled to the bar band (12px was illegible at full-frame layer scale).
  const labelFS = Math.max(16, Math.min(band * 0.34, 42));
  // Value axis: vertical bars map value→y (inverted), horizontal map value→x.
  const valScale = vertical
    ? linearScale(lo, hi, box.y + box.h, box.y) // value→y (top is small)
    : linearScale(lo, hi, box.x, box.x + box.w); // value→x

  const baselinePix = valScale(p.baseline);

  const bars = data.map((d, i) => {
    const prog = drawProgress(p.draw_on, ctx.frame, i);
    const fullValPix = valScale(d.value);
    // Animate from baseline → full value pixel.
    const valPix = baselinePix + (fullValPix - baselinePix) * prog;
    const fill = ctx.colorFor(d, i);
    const alongStart = (vertical ? box.x : box.y) + i * band + (band - barThick) / 2;

    let x: number, y: number, w: number, h: number;
    if (vertical) {
      x = alongStart;
      w = barThick;
      y = Math.min(valPix, baselinePix);
      h = Math.abs(valPix - baselinePix);
    } else {
      y = alongStart;
      h = barThick;
      x = Math.min(valPix, baselinePix);
      w = Math.abs(valPix - baselinePix);
    }
    const r = Math.min(p.radius, w / 2, h / 2);
    return (
      <g key={i}>
        <rect x={x} y={y} width={w} height={h} rx={r} ry={r} fill={fill} />
        {p.labels && d.label !== undefined && (
          <text
            x={vertical ? x + w / 2 : box.x - 12}
            y={vertical ? box.y + box.h + labelFS : y + h / 2}
            fontSize={labelFS}
            fill="currentColor"
            textAnchor={vertical ? 'middle' : 'end'}
            dominantBaseline="middle"
            opacity={0.9}
          >
            {d.label}
          </text>
        )}
        {p.labels && prog > 0.05 && (
          // The VALUE — the number is the hero. Vertical: above the bar tip. Horizontal: just INSIDE the
          // bar's tip (right-aligned) so it never clips at the frame edge even on the longest bar.
          <text
            x={vertical ? x + w / 2 : valPix + (valPix >= baselinePix ? -10 : 10)}
            y={vertical ? valPix - labelFS * 0.5 : y + h / 2}
            fontSize={labelFS}
            fontWeight={700}
            fill={vertical ? 'currentColor' : '#ffffff'}
            textAnchor={vertical ? 'middle' : valPix >= baselinePix ? 'end' : 'start'}
            dominantBaseline="middle"
            opacity={prog}
          >
            {fmtVal(d.value)}
          </text>
        )}
      </g>
    );
  });

  return (
    <g>
      {p.axes && (
        <g stroke="currentColor" strokeOpacity={0.25} strokeWidth={1}>
          <line x1={box.x} y1={box.y + box.h} x2={box.x + box.w} y2={box.y + box.h} />
          <line x1={box.x} y1={box.y} x2={box.x} y2={box.y + box.h} />
        </g>
      )}
      {bars}
    </g>
  );
}

// --- LINE --------------------------------------------------------------------------------------

function renderLine(p: Extract<ChartParams, { kind: 'line' }>, ctx: RenderCtx): React.JSX.Element {
  const data = clampData(p.data, 'line');
  const box = plotBox(p, ctx.width, ctx.height);
  const values = data.map((d) => d.value);
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 0);
  const n = data.length;

  const xAt = (i: number): number => (n <= 1 ? box.x + box.w / 2 : box.x + (i / (n - 1)) * box.w);
  const yScale = linearScale(lo, hi, box.y + box.h, box.y);
  const points: Array<[number, number]> = data.map((d, i) => [xAt(i), yScale(d.value)]);

  const curve = curveFactory(p.curve);
  const lineGen = d3line<[number, number]>()
    .x((pt) => pt[0])
    .y((pt) => pt[1])
    .curve(curve);
  const pathD = lineGen(points) ?? '';

  // Draw-on: a single global ramp (index 0) reveals the stroke via stroke-dash, area fades in.
  const prog = drawProgress(p.draw_on, ctx.frame, 0);
  const lineColor = ctx.colorFor(data[0] ?? { value: 0 }, 0);

  let areaEl: React.JSX.Element | null = null;
  if (p.area && pathD) {
    const baseY = yScale(Math.max(lo, 0));
    const areaGen = d3area<[number, number]>()
      .x((pt) => pt[0])
      .y0(baseY)
      .y1((pt) => pt[1])
      .curve(curve);
    const areaD = areaGen(points) ?? '';
    areaEl = <path d={areaD} fill={lineColor} opacity={p.area_opacity * prog} />;
  }

  // stroke-dash reveal: dasharray ≈ full path length (a generous bound), dashoffset shrinks to 0.
  const dashLen = box.w + box.h + 1000;

  const dots = p.dots
    ? data.map((d, i) => {
        const dotProg = drawProgress(p.draw_on, ctx.frame, i);
        const [cx, cy] = points[i]!;
        return (
          <circle
            key={i}
            cx={cx}
            cy={cy}
            r={p.dot_radius * ease('easeOut', dotProg)}
            fill={ctx.colorFor(d, i)}
          />
        );
      })
    : null;

  return (
    <g>
      {p.axes && (
        <g stroke="currentColor" strokeOpacity={0.25} strokeWidth={1}>
          <line x1={box.x} y1={box.y + box.h} x2={box.x + box.w} y2={box.y + box.h} />
          <line x1={box.x} y1={box.y} x2={box.x} y2={box.y + box.h} />
        </g>
      )}
      {areaEl}
      {pathD && (
        <path
          d={pathD}
          fill="none"
          stroke={lineColor}
          strokeWidth={p.stroke_width}
          strokeLinejoin="round"
          strokeLinecap="round"
          strokeDasharray={dashLen}
          strokeDashoffset={dashLen * (1 - prog)}
        />
      )}
      {dots}
    </g>
  );
}

// --- PIE / DONUT -------------------------------------------------------------------------------

function renderPie(p: Extract<ChartParams, { kind: 'pie' }>, ctx: RenderCtx): React.JSX.Element {
  const data = clampData(p.data, 'pie');
  const box = plotBox(p, ctx.width, ctx.height);
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const outer = Math.max(0, Math.min(box.w, box.h) / 2);
  const inner = outer * p.inner_radius;
  const startRad = (p.start_angle * Math.PI) / 180;

  // d3.pie lays out the angular extents from the magnitudes (preserve input order; no re-sort).
  const layout = d3pie<Datum>()
    .value((d) => Math.max(0, d.value))
    .sort(null)
    .startAngle(startRad)
    .endAngle(startRad + Math.PI * 2)
    .padAngle(p.pad_angle);
  const arcs = layout(data);

  const slices = arcs.map((a, i) => {
    // Draw-on: each slice sweeps open from its own startAngle → endAngle.
    const prog = drawProgress(p.draw_on, ctx.frame, i);
    const end = a.startAngle + (a.endAngle - a.startAngle) * prog;
    const arcGen = d3arc<unknown>()
      .innerRadius(inner)
      .outerRadius(outer)
      .cornerRadius(p.corner_radius)
      .padAngle(p.pad_angle)
      .startAngle(a.startAngle)
      .endAngle(end);
    const d = arcGen(null) ?? '';
    return <path key={i} d={d} fill={ctx.colorFor(a.data, i)} />;
  });

  const labels = p.labels
    ? arcs.map((a, i) => {
        const d = a.data;
        if (d.label === undefined) return null;
        const centroidArc = d3arc<unknown>()
          .innerRadius((inner + outer) / 2)
          .outerRadius((inner + outer) / 2)
          .startAngle(a.startAngle)
          .endAngle(a.endAngle);
        const [lx, ly] = centroidArc.centroid(null);
        return (
          <text
            key={`l${i}`}
            x={cx + lx}
            y={cy + ly}
            fontSize={12}
            fill="#ffffff"
            textAnchor="middle"
            dominantBaseline="middle"
            opacity={drawProgress(p.draw_on, ctx.frame, i)}
          >
            {d.label}
          </text>
        );
      })
    : null;

  return (
    <g transform={`translate(${cx} ${cy})`}>
      {slices}
      {labels && <g transform={`translate(${-cx} ${-cy})`}>{labels}</g>}
    </g>
  );
}

/**
 * Pure renderer: fully-resolved primitive props (no hooks) → SVG. Split from the hook-using wrapper so
 * it is trivially unit-testable as a pure function of (params, frame). Dispatches on `kind`.
 */
export function renderChart(props: {
  frame: number;
  width: number;
  height: number;
  params: unknown;
  /** Color cycle, already palette-resolved by the wrapper. */
  colors: string[];
  /** Per-datum explicit colors (palette-resolved), aligned by index; undefined → use the cycle. */
  datumColors: Array<string | undefined>;
}): React.JSX.Element {
  const p = ChartParamsSchema.parse(props.params);
  const cycle = props.colors.length > 0 ? props.colors : ['#4dd0e1'];

  const colorFor = (_d: Datum, i: number): string =>
    props.datumColors[i] ?? cycle[i % cycle.length]!;

  const ctx: RenderCtx = {
    frame: props.frame,
    width: props.width,
    height: props.height,
    colorFor,
  };

  let body: React.JSX.Element;
  if (p.kind === 'bar') body = renderBar(p, ctx);
  else if (p.kind === 'line') body = renderLine(p, ctx);
  else body = renderPie(p, ctx);

  return (
    <svg
      width={props.width}
      height={props.height}
      viewBox={`0 0 ${props.width} ${props.height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', color: '#9fb0c0' }}
      opacity={p.opacity}
    >
      {body}
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, resolves palette-token colors, then delegates to the pure renderer.
 */
export const Chart: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  const frame = props.frame ?? hookFrame;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = ChartParamsSchema.parse(props.params ?? { kind: 'bar' });
  const colors = parsed.colors.map((c) => resolveFill(c, props.palette, '#4dd0e1'));
  const datumColors = parsed.data.map((d) =>
    d.color === undefined ? undefined : resolveFill(d.color, props.palette, d.color),
  );

  return renderChart({
    frame,
    width,
    height,
    params: props.params ?? { kind: 'bar' },
    colors,
    datumColors,
  });
};

export default Chart;
