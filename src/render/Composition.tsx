// <SceneIRComposition> — the top-level Remotion composition body. Spec §3 ("The Scene IR *is* a
// Remotion composition's inputProps — no translation layer"), §6.2, §15.
//
// The whole Scene IR arrives as `inputProps`. This component lays each `scene` onto the global
// timeline with a Remotion <Sequence> at `scene.at` for `scene.duration_frames`, and renders each
// via the <Scene> compositor. M1 has exactly one scene, but the <Sequence> placement is the general
// contract so multi-scene IRs (and later transitions) drop in without changing the renderer.
//
// DETERMINISM: a pure function of `inputProps`; all per-frame motion lives in <Scene> and the
// sub-renderers, driven by `useCurrentFrame()` (CLAUDE.md r.1).

import React from 'react';
import { AbsoluteFill, Sequence } from 'remotion';
import type { SceneIR } from '../ir/index.js';
import { Scene } from './Scene.js';

export type SceneIRCompositionProps = SceneIR;

/**
 * Render a full Scene IR: a background fill (so out-of-bounds parallax never shows transparency)
 * plus one <Sequence>-placed <Scene> per scene. The background colour is the palette `bg` token
 * when present (spec §6.2 `defs.palette.bg`), else transparent.
 */
export const SceneIRComposition: React.FC<SceneIRCompositionProps> = (props) => {
  const sceneIR = props;
  const bg = sceneIR.defs.palette?.['bg'];

  return (
    <AbsoluteFill style={bg ? { backgroundColor: bg } : undefined}>
      {sceneIR.scenes.map((scene) => (
        <Sequence
          key={scene.id}
          from={scene.at}
          durationInFrames={scene.duration_frames}
          name={scene.id}
          layout="none"
        >
          <Scene scene={scene} defs={sceneIR.defs} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export default SceneIRComposition;
