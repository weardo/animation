// blob-creature renderer — the PROVIDER component (ADR-006). Was core `src/render/ProceduralRig.tsx`;
// generalized to be a provider: it receives the rig layer's OPAQUE `spec` (core treats it as
// `z.record(unknown)`), validates it with the plugin's OWN CharacterSpec (parseSpec), and renders via
// the plugin's `characterMarkup`. No vendor skeleton/mesh; identity is structural (fixed shapes, only
// transforms change).
//
// The builder returns deterministic SVG markup (a pure function of spec+frame); we inject it under a
// centred <g>, then apply the layer's `{a,k}` transform exactly like the dragonbones provider so
// camera / parallax / contact-shadow line up. dangerouslySetInnerHTML is safe here: the markup is
// produced by our OWN builder from a Zod-validated spec (palette is hex-regex-checked, all else
// numeric) — never raw untrusted input. Renders on the CPU (SVG) → byte-reproducible AND fast.

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ProviderProps } from '../../src/engine/index.js';
import type { Easings } from '../../src/ir/index.js';
import { evalNumber, evalVec2 } from '../../src/render/eval.js';
import { parseSpec, BLIP_SPEC, type CharacterSpec } from './spec.js';
import { characterMarkup } from './character.js';

/** Validate the embedded opaque spec → CharacterSpec; fall back to the reference blip spec if absent/invalid. */
function resolveSpec(raw: Record<string, unknown> | undefined): CharacterSpec {
  if (!raw) return BLIP_SPEC;
  try {
    return parseSpec(raw);
  } catch {
    return BLIP_SPEC;
  }
}

/**
 * The blob-creature PROVIDER. Reads `rigDef.spec` (opaque to core), validates it as a CharacterSpec,
 * and draws the creature with `characterMarkup`. A pure function of (props + frame) — CLAUDE.md r.1.
 */
export const BlobCreatureProvider: React.FC<ProviderProps> = ({ layer, rigDef, easings }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const character = resolveSpec(rigDef.spec as Record<string, unknown> | undefined);
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

export default BlobCreatureProvider;
