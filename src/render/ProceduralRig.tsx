// <ProceduralRig> — the code-only character provider (ADR-001 "procedural" rig kind). It renders a
// CharacterSpec (embedded in the Scene IR by the library loader) via the GENERALIZED, data-driven
// builder `characterMarkup` (src/factory) — so the same provider draws any factory-generated
// character. No vendor skeleton/mesh; identity is structural (fixed shapes, only transforms change).
//
// The builder returns deterministic SVG markup (a pure function of spec+frame); we inject it under a
// centred <g>, then apply the layer's `{a,k}` transform exactly like <RigLayer> so camera / parallax
// / contact-shadow line up. dangerouslySetInnerHTML is safe here: the markup is produced by our own
// builder from a Zod-validated spec (palette is hex-regex-checked, all else numeric) — never raw
// untrusted input. Renders on the CPU (SVG) → byte-reproducible AND fast (no Pixi/WebGL/swangle).

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Easings, RigLayer as RigLayerIR } from '../ir/index.js';
import { evalNumber, evalVec2 } from './eval.js';
import { characterMarkup } from '../factory/character.js';
import { parseSpec, BLIP_SPEC, type CharacterSpec } from '../factory/spec.js';

export interface ProceduralRigProps {
  layer: RigLayerIR;
  /** The CharacterSpec embedded in `defs.rigs[ref].spec` (loose-typed in the IR; validated here). */
  spec?: Record<string, unknown> | undefined;
  easings?: Easings | undefined;
}

/** Validate the embedded spec → CharacterSpec; fall back to the reference blip spec if absent/invalid. */
function resolveSpec(raw: Record<string, unknown> | undefined): CharacterSpec {
  if (!raw) return BLIP_SPEC;
  try {
    return parseSpec(raw);
  } catch {
    return BLIP_SPEC;
  }
}

export const ProceduralRig: React.FC<ProceduralRigProps> = ({ layer, spec, easings }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const character = resolveSpec(spec);
  const markup = characterMarkup(character, frame, fps, layer.rig_state.clips);

  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height,
    opacity: opacityPct / 100,
    transform: [
      `translate(${px - width / 2}px, ${py - height / 2}px)`,
      `rotate(${rotationDeg}deg)`,
      `scale(${scalePct / 100})`,
    ].join(' '),
    transformOrigin: 'center center',
  };

  return (
    <AbsoluteFill data-proc-rig={layer.id}>
      <div style={wrapperStyle}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          <g
            transform={`translate(${width / 2} ${height / 2})`}
            dangerouslySetInnerHTML={{ __html: markup }}
          />
        </svg>
      </div>
    </AbsoluteFill>
  );
};

export default ProceduralRig;
