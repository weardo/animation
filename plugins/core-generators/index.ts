// core-generators — the built-in generators shipped AS A CORE PLUGIN (ADR-005 "Built-ins ship as
// core plugins"). It contributes every M1/M2 generator (bead-string/scatter/water/particles/fire/
// crowd) into the engine's `generators` extension point via `api.registerGenerator`. This is the
// dogfooding of the plugin system: the old hardcoded name→component map in src/generators/registry.ts
// is now POPULATED by this plugin (registry.ts delegates to the engine registry — no parallel system).
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring (it only names→component-binds). Each
// generator is itself a pure function of (params + seed + frame) — unchanged by this migration, so
// the demos render byte-identically.

import type { EngineAPI, Plugin } from '../../src/engine/index.js';
import { BeadString } from '../../src/generators/bead-string.js';
import { Scatter } from '../../src/generators/scatter.js';
import { Water } from '../../src/generators/water.js';
import { Particles } from '../../src/generators/particles.js';
import { Fire } from '../../src/generators/fire.js';
import { Crowd } from '../../src/generators/crowd.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/** The core-generators plugin: registers all built-in generators under their Scene-IR `gen` names. */
export const coreGeneratorsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    // Keys MUST match the Scene-IR `generator.gen` field (mirrors the former static REGISTRY).
    api.registerGenerator('bead-string', BeadString);
    api.registerGenerator('scatter', Scatter);
    api.registerGenerator('water', Water);
    api.registerGenerator('particles', Particles);
    api.registerGenerator('fire', Fire);
    api.registerGenerator('crowd', Crowd);
  },
};

export default coreGeneratorsPlugin;
