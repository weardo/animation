// Remotion root — registers the composition whose `inputProps` ARE the Scene IR (spec §3, §6.2).
//
// The composition's frame size / fps / duration are NOT hard-coded: they are derived from the Scene
// IR `config` via `calculateMetadata`, so the same registered composition renders any Scene IR. The
// static defaults below are only the Studio preview placeholders (overridden the moment real
// inputProps are supplied by `renderMedia` or Studio's props panel).
//
// DETERMINISM: `calculateMetadata` is a pure function of `inputProps`; no clock. (CLAUDE.md r.1.)

import React from 'react';
import { Composition } from 'remotion';
import type { SceneIR } from '../ir/index.js';
import { SceneIRComposition } from './Composition.js';

/** The id `renderMedia` / the CLI selects. */
export const COMPOSITION_ID = 'SceneIR';

// Minimal placeholder Scene IR for Studio when no inputProps are provided. Real renders always pass
// a validated Scene IR through `inputProps`; this just lets the Studio open without a crash.
const PLACEHOLDER_SCENE_IR: SceneIR = {
  scene_ir_version: '1.0',
  config: { w: 1920, h: 1080, fps: 30, duration_frames: 150 },
  defs: { palette: { bg: '#1b2a4a' }, easings: {}, assets: {}, rigs: {} },
  audio: [],
  scenes: [
    {
      id: 'placeholder',
      at: 0,
      duration_frames: 150,
      labels: {},
      camera: {
        position: { a: 0, k: [0, 0] },
        zoom: { a: 0, k: 1 },
      },
      layers: [],
    },
  ],
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id={COMPOSITION_ID}
      component={SceneIRComposition}
      defaultProps={PLACEHOLDER_SCENE_IR}
      // Placeholder dimensions; the real values come from `calculateMetadata` below.
      width={PLACEHOLDER_SCENE_IR.config.w}
      height={PLACEHOLDER_SCENE_IR.config.h}
      fps={PLACEHOLDER_SCENE_IR.config.fps}
      durationInFrames={PLACEHOLDER_SCENE_IR.config.duration_frames}
      calculateMetadata={({ props }: { props: SceneIR }) => {
        const { w, h, fps, duration_frames } = props.config;
        return {
          width: w,
          height: h,
          fps,
          durationInFrames: duration_frames,
        };
      }}
    />
  );
};

export default RemotionRoot;
