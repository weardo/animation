// `map` generator — deterministic, animatable geographic maps. Adopts d3-geo (projections +
// `geoPath` SVG path generator) and topojson-client (`feature` to mesh TopoJSON → GeoJSON) — we do
// NOT reimplement projection math or topology decoding (CLAUDE.md rule 3 "reuse over invent").
//
// The GEOMETRY is DATA (an inline TopoJSON `topology`+`object`, or an inline GeoJSON
// `geojson` FeatureCollection) carried in `params` — exactly like the `chart` generator carries its
// `data`. The plugin logic is DOMAIN-CLEAN: it knows how to PROJECT and DRAW arbitrary GeoJSON; it
// hardcodes NO country/region. Which map (world / a region) is selected by naming a generator-preset
// whose params hold the topology (`library/generators/<name>.preset.json` → `library/maps/*.json`).
//
// FEATURES: a selectable projection (geoNaturalEarth1 / geoMercator / geoEqualEarth / …), auto-`fit`
// of the projection to the layer box, optional choropleth fill from a `{ key: color }` data map keyed
// by a feature `key_field` (a property name or the feature `id`), and a frame-driven draw-on
// (stroke-dashoffset reveal + fill fade) reusing the shared scale.ts ramp.
//
// DETERMINISM (golden rule #1): a PURE function of (params, frame). geoPath emits identical path
// strings for identical inputs; the draw-on is frame-driven; there is no RNG and no clock. `seed` is
// accepted (generator contract) but unused — a map is data, not procedural noise. The frame is read
// from `useCurrentFrame()` only in the thin mounted wrapper; all geometry lives in the pure renderer.

import React from 'react';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import {
  geoPath,
  geoNaturalEarth1,
  geoMercator,
  geoEqualEarth,
  geoEquirectangular,
  geoOrthographic,
  geoAzimuthalEqualArea,
  type GeoProjection,
  type GeoPermissibleObjects,
} from 'd3-geo';
import { feature as topoFeature } from 'topojson-client';
import {
  MapParamsSchema,
  resolveFill,
  type GeneratorComponentProps,
  type MapParams,
} from './types.js';
import { drawProgress, ease } from './scale.js';

/** A minimal GeoJSON Feature shape (we only touch geometry + properties + id). */
interface GeoFeature {
  type: 'Feature';
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry: unknown;
}
interface FeatureCollection {
  type: 'FeatureCollection';
  features: GeoFeature[];
}

/** Map the `projection` enum → a fresh d3-geo projection factory result. */
function makeProjection(kind: MapParams['projection']): GeoProjection {
  switch (kind) {
    case 'mercator':
      return geoMercator();
    case 'equal-earth':
      return geoEqualEarth();
    case 'equirectangular':
      return geoEquirectangular();
    case 'orthographic':
      return geoOrthographic();
    case 'azimuthal-equal-area':
      return geoAzimuthalEqualArea();
    case 'natural-earth':
    default:
      return geoNaturalEarth1();
  }
}

/**
 * Resolve the params' geometry DATA into a GeoJSON FeatureCollection. Accepts either an inline
 * TopoJSON `topology` (decoded via topojson-client `feature` on the named `object`) or an inline
 * GeoJSON `geojson` FeatureCollection. Pure — no I/O, no clock. Returns an empty collection when
 * neither is present (a minimally-authored layer renders nothing rather than throwing).
 */
function resolveFeatures(p: MapParams): FeatureCollection {
  if (p.geojson && typeof p.geojson === 'object') {
    const gj = p.geojson as { type?: string; features?: GeoFeature[] };
    if (gj.type === 'FeatureCollection' && Array.isArray(gj.features)) {
      return { type: 'FeatureCollection', features: gj.features };
    }
    // A bare Feature/Geometry: wrap it so the renderer is uniform.
    return { type: 'FeatureCollection', features: [gj as unknown as GeoFeature] };
  }
  if (p.topology && typeof p.topology === 'object') {
    const topo = p.topology as { objects?: Record<string, unknown> };
    const objects = topo.objects ?? {};
    const objName = p.object ?? Object.keys(objects)[0];
    if (objName && objects[objName]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fc = topoFeature(p.topology as any, objects[objName] as any) as unknown;
      const f = fc as { type?: string; features?: GeoFeature[] };
      if (f.type === 'FeatureCollection' && Array.isArray(f.features)) {
        return { type: 'FeatureCollection', features: f.features };
      }
      return { type: 'FeatureCollection', features: [f as unknown as GeoFeature] };
    }
  }
  return { type: 'FeatureCollection', features: [] };
}

/** Read a feature's choropleth key: a named property, else the feature `id`. Stringified for lookup. */
function featureKey(f: GeoFeature, keyField: string): string | undefined {
  if (keyField === 'id' || keyField === '@id') {
    return f.id === undefined || f.id === null ? undefined : String(f.id);
  }
  const props = f.properties ?? {};
  const v = (props as Record<string, unknown>)[keyField];
  return v === undefined || v === null ? undefined : String(v);
}

interface RenderCtx {
  frame: number;
  width: number;
  height: number;
  resolveColor: (value: string | undefined, fallback: string) => string;
}

/**
 * Pure renderer: fully-resolved primitive props (no hooks) → SVG. Split from the hook-using wrapper so
 * it is trivially unit-testable as a pure function of (params, frame).
 */
export function renderMap(props: {
  frame: number;
  width: number;
  height: number;
  params: unknown;
  /** Resolve a CSS color OR a `defs.palette` token; supplied by the wrapper. */
  resolveColor: (value: string | undefined, fallback: string) => string;
}): React.JSX.Element {
  const p = MapParamsSchema.parse(props.params);
  const ctx: RenderCtx = {
    frame: props.frame,
    width: props.width,
    height: props.height,
    resolveColor: props.resolveColor,
  };

  const fc = resolveFeatures(p);

  // Projection. `fit` auto-scales+translates the projection so the WHOLE collection fits the box
  // inset (d3-geo fitExtent — exact, deterministic). Otherwise the raw projection (with optional
  // scale/center/rotate) is used. Either way geoPath turns each feature into an SVG path string.
  const projection = makeProjection(p.projection);
  if (p.rotate) projection.rotate(p.rotate as [number, number, number]);
  if (p.center) projection.center(p.center as [number, number]);

  if (p.fit) {
    const m = p.inset;
    projection.fitExtent(
      [
        [m.left, m.top],
        [Math.max(m.left, ctx.width - m.right), Math.max(m.top, ctx.height - m.bottom)],
      ],
      fc as unknown as GeoPermissibleObjects,
    );
  } else {
    if (typeof p.scale === 'number') projection.scale(p.scale);
    projection.translate([ctx.width / 2, ctx.height / 2]);
  }

  const path = geoPath(projection);

  const landColor = ctx.resolveColor(p.fill, '#3a4a60');
  const strokeColor = ctx.resolveColor(p.stroke, '#1a2230');

  // A generous dash-length bound so the stroke-dash reveal covers any feature outline.
  const dashLen = ctx.width + ctx.height + 4000;

  const paths = fc.features.map((f, i) => {
    const d = path(f as unknown as GeoPermissibleObjects) ?? '';
    if (!d) return null;
    const prog = drawProgress(p.draw_on, ctx.frame, i);

    // Choropleth: a per-feature fill from the data map keyed by `key_field`; falls back to the base
    // land fill. `no_data_fill` colors features the data map omits (when choropleth is active).
    let fill = landColor;
    if (p.choropleth && Object.keys(p.choropleth).length > 0) {
      const key = featureKey(f, p.key_field);
      const dv = key === undefined ? undefined : p.choropleth[key];
      fill = dv !== undefined ? ctx.resolveColor(dv, landColor) : ctx.resolveColor(p.no_data_fill, landColor);
    }

    // Draw-on: the outline strokes on (dashoffset → 0) then the fill fades in behind it.
    const strokeReveal = p.draw_on_stroke ? prog : 1;
    const fillReveal = p.draw_on_fill ? ease('easeOut', prog) : 1;

    return (
      <path
        key={i}
        d={d}
        fill={fill}
        fillOpacity={p.fill_opacity * fillReveal}
        stroke={strokeColor}
        strokeWidth={p.stroke_width}
        strokeLinejoin="round"
        strokeLinecap="round"
        {...(p.draw_on_stroke
          ? { strokeDasharray: dashLen, strokeDashoffset: dashLen * (1 - strokeReveal) }
          : {})}
      />
    );
  });

  return (
    <svg
      width={props.width}
      height={props.height}
      viewBox={`0 0 ${props.width} ${props.height}`}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}
      opacity={p.opacity}
    >
      {paths}
    </svg>
  );
}

/**
 * The Remotion-mounted component. Reads the frame clock from `useCurrentFrame()` and the size from
 * `useVideoConfig()`, then delegates to the pure renderer. Palette-token resolution is deferred into
 * the renderer via a closure over `props.palette` so per-feature choropleth colors resolve tokens too.
 */
export const MapGen: React.FC<GeneratorComponentProps> = (props) => {
  const hookFrame = useCurrentFrame();
  const cfg = useVideoConfig();
  const frame = props.frame ?? hookFrame;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const resolveColor = (value: string | undefined, fallback: string): string =>
    resolveFill(value, props.palette, fallback);

  return renderMap({
    frame,
    width,
    height,
    params: props.params ?? {},
    resolveColor,
  });
};

export default MapGen;
