// Rig layer (src/rig) — Pixi v8 + pixi-dragonbones-runtime canvas driven by Remotion's
// useCurrentFrame, implementing the committed determinism pattern (spike-proven; spec §8, §8.1, §14.1):
//   autoStart:false + sharedTicker:false + ticker.stop(); init ONCE (cached in refs); per frame
//   absolute-seek state.currentTime = frame/fps, advanceTime(0) to flush, StyleKit "alive" overlays
//   (spring head-bob + breathing + Poisson blink + seeded idle sway), render once, gate with
//   delayRender/continueRender until drawn. Supports full mesh deformation (FFD). M1 = single rig.
//
// Public surface: the <RigLayer> React component (compositor entry point) + the pure helpers
// (loader, clip selection, liveness overlays, animated-property evaluation) so they're unit-testable.

export { RigLayer, deriveSources, default as default } from './RigLayer.js';
export type { RigLayerProps } from './RigLayer.js';

export { loadRig, disposeRig } from './dragonbones-loader.js';
export type { RigSources, LoadedRig } from './dragonbones-loader.js';

export { selectClip } from './clips.js';
export type { ClipSeek } from './clips.js';

export {
  headBob,
  breathing,
  idleSway,
  addOffsets,
  blinkSchedule,
  isBlinking,
  ZERO_OFFSET,
} from './liveness.js';
export type { BoneOffset, BlinkEvent } from './liveness.js';

export { evalNumber, evalVec2 } from './animated-eval.js';
