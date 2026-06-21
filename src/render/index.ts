// Render layer — Remotion host + compositor (spec §3, §7, §15). The Scene IR is fed in as
// `inputProps`; this module registers the Remotion root and re-exports the compositor surface.
//
//   • Root.tsx           — registerRoot target: one <Composition> ("SceneIR") whose size/fps/
//                          duration derive from the Scene IR `config` via calculateMetadata.
//   • Composition.tsx    — <SceneIRComposition>: lays each scene on the timeline via <Sequence>.
//   • Scene.tsx          — <Scene>: the per-frame compositor (camera parent transform + per-layer
//                          parallax + z-order + dispatch to asset/generator/rig sub-renderers).
//   • AssetLayer.tsx     — <AssetLayer>: fixed art with parallax (M1 background).
//   • eval.ts            — `{a,k}` property evaluator with StyleKit easing (camera + transforms).
//   • stylekit.ts        — the Kurzgesagt "house style" constants/easings (consumed throughout).
//
// This file is the import target for Remotion's entry (`remotion studio src/render/index.ts` and
// `renderMedia({ entryPoint: 'src/render/index.ts', composition: 'SceneIR' })`).

import { registerRoot } from 'remotion';
import { RemotionRoot } from './Root.js';

registerRoot(RemotionRoot);

// Public compositor surface (for the CLI renderer, tests, and downstream agents).
export { RemotionRoot, COMPOSITION_ID } from './Root.js';
export { SceneIRComposition } from './Composition.js';
export type { SceneIRCompositionProps } from './Composition.js';
export { Scene } from './Scene.js';
export type { SceneProps } from './Scene.js';
export { AssetLayer } from './AssetLayer.js';
export type { AssetLayerProps } from './AssetLayer.js';
export { evalNumber, evalVec2 } from './eval.js';

// Re-export StyleKit (lives in src/render) so consumers import the house style from one place.
export * from './stylekit.js';
