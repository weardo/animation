// <GeneratorLayer> — the compositor's entry point for a Scene IR `generator` layer. Spec §7, §10.
//
// The render compositor (src/render) maps each `type:"generator"` layer to this component. It is a
// thin dispatcher: it resolves the `gen` name through the registry and hands the registered
// generator its props. The generator itself reads the frame clock via `useCurrentFrame()`, so this
// layer stays declarative and the per-frame determinism lives inside the generator (CLAUDE.md r.1).

import React from 'react';
import type { GeneratorLayer as GeneratorLayerIR, Palette } from '../ir/scene.js';
import { getGenerator } from './registry.js';

export interface GeneratorLayerProps {
  /** The Scene IR generator layer ({ gen, seed, path?, params }). */
  layer: GeneratorLayerIR;
  /** Resolved palette tokens (Scene IR `defs.palette`) for token-fill resolution. */
  palette?: Palette | undefined;
}

/**
 * Render one Scene IR generator layer. Resolves `layer.gen` → component and forwards seed/path/
 * params. `frame`/`fps`/`width`/`height` are left undefined so the generator pulls them from the
 * Remotion hooks (the host clock); callers MAY pass a wrapper that injects them for headless tests.
 */
export const GeneratorLayer: React.FC<GeneratorLayerProps> = ({ layer, palette }) => {
  const Generator = getGenerator(layer.gen);
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
