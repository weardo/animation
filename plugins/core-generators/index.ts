// core-generators — the built-in generators shipped AS A CORE PLUGIN (ADR-005/007). It OWNS the
// generator implementations (bead-string/scatter/water/particles/fire/crowd + their geometry/RNG/Zod
// params — all in THIS directory) and contributes them into the engine's `generators` extension point
// via `api.registerGenerator`. ADR-007: the code lives here, NOT in core — the engine owns only the
// generic `GeneratorComponent` contract (engine/generator.ts) and the `generators` registry; the
// dependency arrow points plugin→core, never core→plugin (delete-the-plugin test).
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring (it only names→component-binds). Each
// generator is itself a pure function of (params + seed + frame) — unchanged by this relocation.

import type { EngineAPI, Plugin } from '../../src/engine/index.js';
import { BeadString } from './bead-string.js';
import { Scatter } from './scatter.js';
import { Water } from './water.js';
import { Particles } from './particles.js';
import { Fire } from './fire.js';
import { Crowd } from './crowd.js';

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
