// Generators layer: parametric procedural components — pure functions of (params + seed + frame)
// emitting an animated SVG sub-tree, driven by Remotion's useCurrentFrame. Deterministic; adding a
// generator = one registered module, no IR/pipeline changes. See spec §10 and the add-generator skill.
//
// M1 ships `bead-string` (neuron chain: travelling pulse + wavy bending + blobby beads + glow/goo).
// Reuse: d3-shape (smooth curves), simplex-noise (organic motion), seeded mulberry32 RNG.

// Public component entry points.
export { GeneratorLayer, type GeneratorLayerProps } from './GeneratorLayer.js';
export { BeadString, renderBeadString } from './bead-string.js';

// Registry (how the compositor resolves `gen` → component; how to add more).
export {
  getGenerator,
  hasGenerator,
  generatorNames,
  registerGenerator,
} from './registry.js';

// Types + per-generator params contracts.
export {
  type GeneratorComponent,
  type GeneratorComponentProps,
  resolveFill,
  BeadStringParamsSchema,
  type BeadStringParams,
  PulseParamsSchema,
  WaveParamsSchema,
} from './types.js';

// Geometry helpers (reusable by future path-following generators).
export {
  type Point,
  type ChainGeometryParams,
  defaultBaseline,
  bendPoints,
  smoothPath,
  blobPath,
  circlePath,
} from './path.js';

// Seeded RNG primitives.
export { mulberry32, mixSeed } from './rng.js';
