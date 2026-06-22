// <GeneratorLayer> — the compositor's entry point for a Scene IR `generator` layer. Spec §7, §10.
//
// The render compositor maps each `type:"generator"` layer to this component. It is a thin, GENERIC
// dispatcher: it resolves the `gen` name through the engine's `generators` extension point (populated
// by plugins, e.g. core-generators) and hands the registered generator its props. The generator
// itself reads the frame clock via `useCurrentFrame()`, so this layer stays declarative and the
// per-frame determinism lives inside the generator (CLAUDE.md r.1). Core knows no generator by name —
// only "a generator layer → a `gen` id → the registry resolves it".

import React from 'react';
import type { GeneratorLayer as GeneratorLayerIR, Palette } from '../ir/scene.js';
import { generators } from '../engine/index.js';

export interface GeneratorLayerProps {
  /** The Scene IR generator layer ({ gen, seed, path?, params }). */
  layer: GeneratorLayerIR;
  /** Resolved palette tokens (Scene IR `defs.palette`) for token-fill resolution. */
  palette?: Palette | undefined;
}

/**
 * Render one Scene IR generator layer. Resolves `layer.gen` → component (via the engine registry; a
 * missing/typo'd name fails loudly there) and forwards seed/path/params. `frame`/`fps`/`width`/
 * `height` are left undefined so the generator pulls them from the Remotion hooks (the host clock);
 * callers MAY pass a wrapper that injects them for headless tests.
 */
export const GeneratorLayer: React.FC<GeneratorLayerProps> = ({ layer, palette }) => {
  const Generator = generators.get(layer.gen);
  // frame/fps/width/height omitted → the generator falls back to useCurrentFrame()/useVideoConfig().
  return (
    <Generator
      seed={layer.seed}
      path={layer.path}
      palette={palette}
      params={layer.params}
    />
  );
};

export default GeneratorLayer;
