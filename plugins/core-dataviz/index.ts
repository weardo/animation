// core-dataviz — a built-in data-viz plugin shipped AS A PLUGIN (ADR-005/007). It OWNS two generators
// (all in THIS directory + their own Zod params), contributed into the engine's `generators` extension
// point via `api.registerGenerator`:
//   • `chart` — bar / line / pie+donut via d3-shape arc/pie/line/area + a dependency-free linear
//     scale; dispatches internally on a `kind` discriminant.
//   • `map`   — geographic maps via d3-geo (projections + geoPath) + topojson-client; the GEOMETRY is
//     DATA (inline TopoJSON/GeoJSON in params, selected by a generator-preset) so the logic is
//     domain-clean (hardcodes no country/region).
//
// ADR-007: the code lives here, NOT in core — the engine owns only the generic `GeneratorComponent`
// contract (engine/generator.ts) and the `generators` registry; the dependency arrow points
// plugin→core, never core→plugin (delete-the-plugin test). It does NOT edit src/engine/enabled.ts or
// plugins/enabled.ts — wiring is done once by the Integrate phase.
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring (name→component bind). The chart is a
// pure function of (params + frame) — no RNG, no clock in the geometry; draw-on is frame-driven.

import type { EngineAPI, Plugin } from '../../src/engine/index.js';
import { Chart } from './chart.js';
import { MapGen } from './map.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/** The core-dataviz plugin: registers the `chart` generator under its Scene-IR `gen` name. */
export const coreDatavizPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    // Key MUST match the Scene-IR `generator.gen` field. `chart` dispatches bar/line/pie on `kind`.
    api.registerGenerator('chart', Chart);
    // `map` — d3-geo geographic maps (peer of `chart`). The GEOMETRY is DATA (inline TopoJSON/GeoJSON
    // in params, selected via a generator-preset); the plugin logic is domain-clean (no country names).
    api.registerGenerator('map', MapGen);
  },
};

export default coreDatavizPlugin;
