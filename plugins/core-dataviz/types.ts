// core-dataviz — per-chart params CONTRACTS (the chart-specific Zod schemas). ADR-007: these are
// domain CODE and live in the plugin, NOT in core. The generic socket — `GeneratorComponentProps` /
// `GeneratorComponent` + the `resolveFill` palette helper — lives in engine core (engine/generator.ts)
// and is re-exported here so the chart modules import everything from one local place (mirrors
// plugins/core-generators/types.ts).
//
// A Scene IR `generator` layer carries `{ gen, seed, path?, params }` with `params` loose
// (z.record(unknown)) at the IR boundary so adding a chart needs NO IR/pipeline change (CLAUDE.md
// rule 5). Each chart narrows its own `params` HERE via its own Zod schema, parsed at render time.
//
// All three charts share a `chart` gen name and DISPATCH on a `kind` discriminant (bar/line/pie) — one
// registry entry, three presentations — so the renderer stays a single pure function of (params, frame).

import { z } from 'zod';

// Re-export the engine's generic generator contract so local chart modules import from one place.
export {
  resolveFill,
  type GeneratorComponent,
  type GeneratorComponentProps,
} from '../../src/engine/index.js';

/** Hard upper bound on series/datapoint count (mirrors core-generators' shape budget; §10.1). */
export const CHART_POINT_BUDGET = 500;

/** A single labelled datum. `label` is optional (only drawn when `axes`/`legend` ask for it). */
export const DatumSchema = z
  .object({
    /** The numeric value (bar height / line y / pie slice magnitude). */
    value: z.number(),
    /** Optional category label (x-axis tick / pie legend). */
    label: z.string().optional(),
    /** Optional explicit color (CSS color OR a `defs.palette` token); else picked from `colors`. */
    color: z.string().optional(),
  })
  .strip();

export type Datum = z.infer<typeof DatumSchema>;

/** Inset of the plotting area inside the layer box (leaves room for axes/labels). */
export const PlotInsetSchema = z
  .object({
    top: z.number().min(0).default(24),
    right: z.number().min(0).default(24),
    bottom: z.number().min(0).default(40),
    left: z.number().min(0).default(48),
  })
  .strip();

/**
 * Shared draw-on animation contract. The chart "grows in" over [delay, delay+duration] frames driven
 * PURELY by `frame` (deterministic, no clock). `stagger` offsets each element (bar/slice/point) so
 * they cascade. `easing` shapes the 0→1 progress.
 */
export const DrawOnSchema = z
  .object({
    /** Frames to wait before the first element starts. */
    delay: z.number().min(0).default(0),
    /** Frames each element takes to fully draw in. */
    duration: z.number().min(0).default(24),
    /** Per-element start offset in frames (cascade). */
    stagger: z.number().min(0).default(4),
    /** Progress easing applied to the per-element 0→1 ramp. */
    easing: z.enum(['linear', 'easeOut', 'easeInOut', 'spring']).default('easeOut'),
  })
  .strip();

export type DrawOn = z.infer<typeof DrawOnSchema>;

/** Fields common to every chart kind: the data, palette, plotting box, draw-on, axes/legend toggles. */
const ChartBaseShape = {
  /** The dataset. Clamped to CHART_POINT_BUDGET with a warn (no silent truncation; CLAUDE.md). */
  data: z.array(DatumSchema).default([]),
  /** Color cycle (CSS colors OR `defs.palette` tokens); used when a datum has no explicit color. */
  colors: z.array(z.string()).default(['#4dd0e1', '#ffcf4d', '#ff7d7d', '#9d7dff', '#7dffb0']),
  /** Plotting-area inset inside the layer box. */
  inset: PlotInsetSchema.default({}),
  /** Draw-on growth animation. */
  draw_on: DrawOnSchema.default({}),
  /** Draw x/y axis lines + ticks (bar/line). Pie ignores. */
  axes: z.boolean().default(true),
  /** Draw value/label text on elements. */
  labels: z.boolean().default(false),
  /** Layer opacity 0..1. */
  opacity: z.number().min(0).max(1).default(1),
};

// --- bar chart --------------------------------------------------------------------------------

export const BarChartParamsSchema = z
  .object({
    kind: z.literal('bar'),
    ...ChartBaseShape,
    /** Gap between bars as a fraction of the band [0..1). */
    gap: z.number().min(0).max(0.95).default(0.25),
    /** Corner radius of bars in px. */
    radius: z.number().min(0).default(4),
    /** Orientation: vertical (grow up) or horizontal (grow right). */
    orientation: z.enum(['vertical', 'horizontal']).default('vertical'),
    /** Baseline value the bars grow FROM (usually 0). */
    baseline: z.number().default(0),
  })
  .strip();

export type BarChartParams = z.infer<typeof BarChartParamsSchema>;

// --- line chart -------------------------------------------------------------------------------

export const LineChartParamsSchema = z
  .object({
    kind: z.literal('line'),
    ...ChartBaseShape,
    /** Curve interpolation between points. */
    curve: z.enum(['linear', 'monotone', 'catmull-rom', 'step']).default('monotone'),
    /** Stroke width of the line in px. */
    stroke_width: z.number().positive().default(3),
    /** Draw a filled area under the line. */
    area: z.boolean().default(false),
    /** Area fill opacity 0..1 (only used when `area`). */
    area_opacity: z.number().min(0).max(1).default(0.18),
    /** Draw a dot at each datapoint. */
    dots: z.boolean().default(true),
    /** Dot radius in px. */
    dot_radius: z.number().min(0).default(4),
  })
  .strip();

export type LineChartParams = z.infer<typeof LineChartParamsSchema>;

// --- pie / donut chart ------------------------------------------------------------------------

export const PieChartParamsSchema = z
  .object({
    kind: z.literal('pie'),
    ...ChartBaseShape,
    /** Inner radius as a fraction of the outer radius (0 = pie, >0 = donut). */
    inner_radius: z.number().min(0).max(0.95).default(0),
    /** Gap between slices in radians (the d3 padAngle). */
    pad_angle: z.number().min(0).default(0.0),
    /** Corner radius of slices in px (d3 cornerRadius). */
    corner_radius: z.number().min(0).default(0),
    /** Start angle of the whole pie in degrees (0 = 12 o'clock, clockwise). */
    start_angle: z.number().default(0),
  })
  .strip();

export type PieChartParams = z.infer<typeof PieChartParamsSchema>;

// --- discriminated union ----------------------------------------------------------------------

/**
 * The full `chart` generator params contract: a discriminated union on `kind`. Loose at the IR
 * boundary, strict here; every field defaulted so a minimally-authored layer still renders.
 */
export const ChartParamsSchema = z.discriminatedUnion('kind', [
  BarChartParamsSchema,
  LineChartParamsSchema,
  PieChartParamsSchema,
]);

export type ChartParams = z.infer<typeof ChartParamsSchema>;

// --- map (geographic) -------------------------------------------------------------------------

/**
 * The `map` generator params contract — a SECOND data-viz generator (peer of `chart`), registered
 * under its own `gen` name. Reuses the shared `DrawOnSchema` ramp.
 *
 * GEOMETRY IS DATA (DOMAIN-CLEAN): the map carries an inline `topology` (TopoJSON) or `geojson`
 * (GeoJSON FeatureCollection) in `params` — NO country/region hardcoded in the plugin; which map is
 * selected by naming a generator-preset whose params hold the geometry. Both are opaque
 * `z.record(z.unknown())` here (decoded/validated structurally by d3-geo/topojson at render).
 */
export const MapParamsSchema = z
  .object({
    /** Inline TopoJSON Topology (e.g. `library/maps/world-110m.json`). Decoded via topojson-client. */
    topology: z.record(z.unknown()).optional(),
    /** Which TopoJSON `objects` key to mesh (e.g. "countries"); defaults to the first object. */
    object: z.string().optional(),
    /** Inline GeoJSON FeatureCollection (alternative to `topology`). */
    geojson: z.record(z.unknown()).optional(),

    /** The map projection. */
    projection: z
      .enum([
        'natural-earth',
        'mercator',
        'equal-earth',
        'equirectangular',
        'orthographic',
        'azimuthal-equal-area',
      ])
      .default('natural-earth'),
    /** Auto-fit the projection to the layer box (inset-aware). When false, use scale/center/translate. */
    fit: z.boolean().default(true),
    /** Explicit projection scale (only when `fit` is false). */
    scale: z.number().positive().optional(),
    /** Projection geographic center [lon, lat] (when `fit` is false). */
    center: z.tuple([z.number(), z.number()]).optional(),
    /** Projection rotation [lambda, phi, gamma] degrees (e.g. to spin an orthographic globe). */
    rotate: z.tuple([z.number(), z.number(), z.number()]).optional(),
    /** Plotting-area inset inside the layer box (room for a frame/labels), used by `fit`. */
    inset: PlotInsetSchema.default({ top: 24, right: 24, bottom: 24, left: 24 }),

    /** Base land fill (CSS color OR a `defs.palette` token). Generic neutral default. */
    fill: z.string().default('#3a4a60'),
    /** Land fill opacity 0..1. */
    fill_opacity: z.number().min(0).max(1).default(1),
    /** Feature outline stroke (CSS color OR a `defs.palette` token). Generic neutral default. */
    stroke: z.string().default('#1a2230'),
    /** Outline stroke width in px. */
    stroke_width: z.number().min(0).default(0.75),

    /**
     * Choropleth fill: a `{ featureKey: color }` map. `featureKey` is read from each feature's
     * `key_field` (a property name, or "id" for the GeoJSON feature id). Color = CSS or palette token.
     */
    choropleth: z.record(z.string()).optional(),
    /** Which feature field to key the choropleth by ("id" → the feature id; else a property name). */
    key_field: z.string().default('name'),
    /** Fill for features the choropleth map omits (when choropleth is active). */
    no_data_fill: z.string().default('#2a3340'),

    /** Draw-on growth animation (shared ramp; staggers per feature). */
    draw_on: DrawOnSchema.default({ duration: 0, stagger: 0 }),
    /** Reveal each outline via stroke-dashoffset over the draw-on ramp. */
    draw_on_stroke: z.boolean().default(false),
    /** Fade each fill in over the draw-on ramp. */
    draw_on_fill: z.boolean().default(false),

    /** Layer opacity 0..1. */
    opacity: z.number().min(0).max(1).default(1),
  })
  .strip();

export type MapParams = z.infer<typeof MapParamsSchema>;
