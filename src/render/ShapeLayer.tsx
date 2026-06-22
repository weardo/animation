// <ShapeLayer> — the compositor's renderer for a Scene-IR `shape` layer. ADR-003 #1 (Tier A,
// deterministic). "Families are sockets; libraries are plugs": this socket adopts three free
// libraries instead of hand-rolling vector geometry —
//
//   • @remotion/shapes — the PRIMITIVE catalog. A `shape: { kind, ...params }` descriptor selects a
//     maker (rect/circle/ellipse/triangle/star/polygon/pie/heart); each maker returns a pure SVG
//     path `d` + intrinsic size. We center the shape on the layer origin via a viewBox offset.
//   • flubber — PATH MORPHING. When the `morph` channel is animated, we locate the active keyframe
//     segment for the current frame and interpolate the two `d` strings with flubber (it handles
//     DIFFERING point counts by resampling), eased through StyleKit like every other channel.
//   • @remotion/paths — path utilities (re-exported helpers available for draw-on / measurement;
//     getBoundingBox is used to frame morph paths).
//
// FILL is a solid (animated) color OR a linear/radial GRADIENT. Gradients lower to an SVG <defs>
// <linearGradient>/<radialGradient> whose id is derived DETERMINISTICALLY from the layer id, so two
// shape layers never collide and the markup is byte-identical every run. Palette tokens (defs.palette)
// resolve through the engine's `resolveFill` (shared with the generator family). STROKE is an optional
// color+width.
//
// TRANSFORM is the standard `{a,k}` position/scale/rotation/opacity, evaluated with the same StyleKit
// easing (`eval.ts`) as asset/rig/generator layers, so a shape rides the camera + shading wrappers
// identically. Parallax + shading/effects are applied by the parent <Scene> (this stays presentational).
//
// DETERMINISM (CLAUDE.md r.1): a pure function of (layer, palette, frame). No clock, no RNG; flubber
// is a deterministic geometric interpolator; gradient ids are content-derived from the layer id.

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, interpolateColors } from 'remotion';
import {
  makeRect,
  makeCircle,
  makeEllipse,
  makeTriangle,
  makeStar,
  makePolygon,
  makePie,
  makeHeart,
} from '@remotion/shapes';
// flubber ships a UMD build with no real ESM entry, so its `interpolate` export lands in different
// places under different loaders: webpack puts it as a namespace member, Node's CJS interop only
// exposes it via the default object. Import the whole namespace and probe both so this works under
// the Remotion webpack bundle AND tsx/Node.
import * as flubberNS from 'flubber';
const flubberMod = flubberNS as unknown as {
  interpolate?: FlubberInterpolate;
  default?: { interpolate?: FlubberInterpolate };
};
const flubberInterpolate: FlubberInterpolate =
  flubberMod.interpolate ?? flubberMod.default?.interpolate!;
import { getBoundingBox } from '@remotion/paths';
import type { Easings, Palette, ShapeLayer as ShapeLayerIR } from '../ir/index.js';
import { resolveFill } from '../engine/index.js';
import { evalNumber, evalVec2 } from './eval.js';
import { easingFn, type EasingFunction } from './stylekit.js';

/** flubber's path-string interpolator: (from, to, opts) → (t ∈ [0,1]) → SVG `d`. */
type FlubberInterpolate = (
  from: string,
  to: string,
  opts?: { maxSegmentLength?: number },
) => (t: number) => string;

export interface ShapeLayerProps {
  /** The Scene-IR shape layer ({ shape?/morph?, fill?, stroke?, transform? }). */
  layer: ShapeLayerIR;
  /** `defs.palette` for resolving token fills/strokes (shared with the generator family). */
  palette?: Palette | undefined;
  /** `defs.easings` so transform + morph keyframes resolve their `e` names (never linear). */
  easings?: Easings | undefined;
}

/** A resolved primitive: its path `d` plus the intrinsic box `@remotion/shapes` reports. */
interface ResolvedGeometry {
  d: string;
  width: number;
  height: number;
}

/** A numeric param off the loose primitive descriptor, with a default. */
function num(params: Record<string, unknown>, key: string, fallback: number): number {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Build a primitive's geometry from its `@remotion/shapes` maker. Per-kind defaults keep a minimally
 * authored layer renderable. Pure (the makers are pure path math).
 */
function geometryForPrimitive(kind: string, params: Record<string, unknown>): ResolvedGeometry {
  switch (kind) {
    case 'rect': {
      const r = makeRect({
        width: num(params, 'width', 200),
        height: num(params, 'height', 120),
        cornerRadius: num(params, 'cornerRadius', 0),
      });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'circle': {
      const r = makeCircle({ radius: num(params, 'radius', 100) });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'ellipse': {
      const r = makeEllipse({ rx: num(params, 'rx', 120), ry: num(params, 'ry', 70) });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'triangle': {
      const dir = (params['direction'] as 'up' | 'down' | 'left' | 'right') ?? 'up';
      const r = makeTriangle({ length: num(params, 'length', 180), direction: dir });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'star': {
      const r = makeStar({
        points: Math.max(2, Math.round(num(params, 'points', 5))),
        innerRadius: num(params, 'innerRadius', 50),
        outerRadius: num(params, 'outerRadius', 110),
      });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'polygon': {
      const r = makePolygon({
        points: Math.max(3, Math.round(num(params, 'points', 6))),
        radius: num(params, 'radius', 100),
      });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'pie': {
      const r = makePie({
        radius: num(params, 'radius', 100),
        progress: num(params, 'progress', 0.5),
        closePath: (params['closePath'] as boolean) ?? true,
        counterClockwise: (params['counterClockwise'] as boolean) ?? false,
      });
      return { d: r.path, width: r.width, height: r.height };
    }
    case 'heart': {
      const r = makeHeart({ height: num(params, 'height', 180) });
      return { d: r.path, width: r.width, height: r.height };
    }
    default:
      // Unknown kind → a sane default box (keeps the layer visible rather than throwing mid-render).
      return geometryForPrimitive('rect', params);
  }
}

/** A keyframe of the morph channel (a path `d` string at frame `t`, eased by `e`). */
interface MorphKeyframe {
  t: number;
  s: string;
  e?: string | undefined;
}

/** Resolve an easing reference (defs.easings name → curve, else direct StyleKit name). Never linear. */
function resolveEasing(name: string | undefined, easings: Easings): EasingFunction {
  if (!name) return easingFn('smooth');
  const def = easings[name];
  if (def === undefined) return easingFn(name);
  return easingFn(def);
}

/**
 * Evaluate the morph channel at `frame` → a single path `d` string. Static (`a:0`) returns the path
 * verbatim. Animated (`a:1`) locates the active `[a,b]` keyframe segment and MORPHS between the two
 * `d` strings with flubber, parameterised by the StyleKit-eased segment progress. flubber resamples
 * so the endpoints can have different point counts. Out-of-range frames hold the boundary path.
 * Pure + deterministic (flubber is a deterministic geometric interpolator).
 */
function evalMorph(
  morph: { a: 0 | 1; k: string | MorphKeyframe[] },
  frame: number,
  easings: Easings,
): string {
  if (morph.a === 0) return morph.k as string;
  const kfs = morph.k as MorphKeyframe[];
  if (kfs.length === 0) return '';
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  if (kfs.length === 1 || frame <= first.t) return first.s;
  if (frame >= last.t) return last.s;
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame >= a.t && frame <= b.t) {
      if (a.t === b.t) return a.s;
      // Eased segment progress 0→1 (never accidentally linear).
      const tt = interpolate(frame, [a.t, b.t], [0, 1], {
        easing: resolveEasing(a.e, easings),
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
      const morpher = flubberInterpolate(a.s, b.s, { maxSegmentLength: 10 });
      return morpher(tt);
    }
  }
  return last.s;
}

/** Whether a fill is the gradient form (`{ gradient: … }`) vs an animated color. */
function isGradientFill(fill: unknown): fill is { gradient: import('../ir/index.js').GradientFill } {
  return typeof fill === 'object' && fill !== null && 'gradient' in (fill as object);
}

/**
 * Evaluate a solid (animated) color fill at `frame`. Static returns the (palette-resolved) color;
 * animated interpolates between the two keyframe colors with Remotion's `interpolateColors` (eased).
 */
function evalColorFill(
  fill: { a: 0 | 1; k: string | MorphKeyframe[] },
  frame: number,
  easings: Easings,
  palette: Palette | undefined,
): string {
  if (fill.a === 0) return resolveFill(fill.k as string, palette, '#ffffff');
  const kfs = fill.k as MorphKeyframe[];
  if (kfs.length === 0) return '#ffffff';
  const first = kfs[0]!;
  const last = kfs[kfs.length - 1]!;
  const resolve = (c: string) => resolveFill(c, palette, '#ffffff');
  if (kfs.length === 1 || frame <= first.t) return resolve(first.s);
  if (frame >= last.t) return resolve(last.s);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]!;
    const b = kfs[i + 1]!;
    if (frame >= a.t && frame <= b.t) {
      if (a.t === b.t) return resolve(a.s);
      const tt = interpolate(frame, [a.t, b.t], [0, 1], {
        easing: resolveEasing(a.e, easings),
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });
      return interpolateColors(tt, [0, 1], [resolve(a.s), resolve(b.s)]);
    }
  }
  return resolve(last.s);
}

/**
 * Render one Scene-IR shape layer to an SVG. Geometry comes from EITHER the morph channel (animated
 * path, flubber-interpolated) — which takes precedence — OR a `@remotion/shapes` primitive. Fill is
 * solid or a deterministic-id gradient; stroke is optional. The layer transform + parallax + shading
 * are applied by the parent <Scene> via the same wrappers as other layers.
 */
export const ShapeLayer: React.FC<ShapeLayerProps> = ({ layer, palette, easings }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  // --- geometry: morph wins; else primitive; else nothing to draw ---
  let d: string;
  // The local SVG box the path draws into: origin (x,y) + size. @remotion/shapes paths start at 0,0;
  // morph paths can start anywhere, so we read their bounding box for the viewBox.
  let box: { x: number; y: number; width: number; height: number };
  if (layer.morph) {
    d = evalMorph(layer.morph, frame, easingTable);
    if (d) {
      const bb = getBoundingBox(d);
      box = { x: bb.x1, y: bb.y1, width: bb.width, height: bb.height };
    } else {
      box = { x: 0, y: 0, width: 0, height: 0 };
    }
  } else if (layer.shape) {
    const { kind, ...rest } = layer.shape as { kind: string } & Record<string, unknown>;
    const geo = geometryForPrimitive(kind, rest);
    d = geo.d;
    box = { x: 0, y: 0, width: geo.width, height: geo.height };
  } else {
    // Neither geometry source authored → render nothing (but keep the z-slot/key stable).
    return <AbsoluteFill data-shape-layer={layer.id} />;
  }

  // --- transform (evaluated at this frame); position defaults to composition centre ---
  const t = layer.transform;
  const [tx, ty] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  // --- fill: solid color OR gradient (deterministic <defs> id from the layer id) ---
  const gradId = `shape-grad-${layer.id}`;
  let fillValue = '#ffffff';
  let gradientDef: React.ReactNode = null;
  const fill = layer.fill;
  if (fill === undefined) {
    fillValue = '#ffffff';
  } else if (isGradientFill(fill)) {
    const g = fill.gradient;
    const stops = g.stops.map(([color, offset], i) => (
      <stop key={i} offset={`${(offset * 100).toFixed(2)}%`} stopColor={resolveFill(color, palette, '#ffffff')} />
    ));
    if (g.type === 'linear') {
      // angle (deg, default 0 = left→right) → unit-vector gradient endpoints in objectBoundingBox space.
      const rad = ((g.angle ?? 0) * Math.PI) / 180;
      const dx = Math.cos(rad);
      const dy = Math.sin(rad);
      const x1 = 0.5 - dx / 2;
      const y1 = 0.5 - dy / 2;
      const x2 = 0.5 + dx / 2;
      const y2 = 0.5 + dy / 2;
      gradientDef = (
        <linearGradient id={gradId} x1={x1} y1={y1} x2={x2} y2={y2}>
          {stops}
        </linearGradient>
      );
    } else {
      gradientDef = (
        <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
          {stops}
        </radialGradient>
      );
    }
    fillValue = `url(#${gradId})`;
  } else {
    fillValue = evalColorFill(fill as { a: 0 | 1; k: string | MorphKeyframe[] }, frame, easingTable, palette);
  }

  // --- stroke (optional) ---
  const strokeColor = layer.stroke?.color ? resolveFill(layer.stroke.color, palette, '#000000') : 'none';
  const strokeWidth = layer.stroke?.width ?? 0;

  // The SVG viewBox is the geometry's own box (the path coordinates are local to it). We center the
  // whole SVG on the evaluated transform position and apply scale/rotation about its centre.
  const vbW = box.width || 1;
  const vbH = box.height || 1;
  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    left: tx - vbW / 2,
    top: ty - vbH / 2,
    width: vbW,
    height: vbH,
    opacity: opacityPct / 100,
    transform: `rotate(${rotationDeg}deg) scale(${scalePct / 100})`,
    transformOrigin: 'center center',
  };

  return (
    <AbsoluteFill data-shape-layer={layer.id} style={{ pointerEvents: 'none' }}>
      <svg
        viewBox={`${box.x} ${box.y} ${vbW} ${vbH}`}
        style={wrapperStyle}
        xmlns="http://www.w3.org/2000/svg"
      >
        {gradientDef ? <defs>{gradientDef}</defs> : null}
        <path d={d} fill={fillValue} stroke={strokeColor} strokeWidth={strokeWidth} />
      </svg>
    </AbsoluteFill>
  );
};

export default ShapeLayer;
