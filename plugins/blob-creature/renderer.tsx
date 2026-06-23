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
import type { Easings, RigLayer } from '../../src/ir/index.js';
import { evalNumber, evalVec2 } from '../../src/render/eval.js';
import { parseSpec, applyParts, BLIP_SPEC, type CharacterSpec } from './spec.js';
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
 * Sample the rig layer's M4b `mouth` track at a SCENE-LOCAL frame → openness in [0,1]. The track is
 * local-frame indexed (frame 0 = the narration's start = the scene start, by construction in the
 * narrate pass), so we index by the provider's own `useCurrentFrame()` (already scene-local). Out of
 * range (before/after the narration span) → 0 (closed). Pure + deterministic. This is the ONLY place
 * the provider interprets the otherwise-opaque track; core never reads it.
 */
function sampleMouthOpenness(mouth: RigLayer['mouth'], localFrame: number): number {
  if (!mouth || !Array.isArray(mouth.open) || mouth.open.length === 0) return 0;
  if (localFrame < 0 || localFrame >= mouth.open.length) return 0;
  const v = mouth.open[localFrame];
  return typeof v === 'number' ? v : 0;
}

/**
 * The blob-creature PROVIDER. Reads `rigDef.spec` (opaque to core), validates it as a CharacterSpec,
 * and draws the creature with `characterMarkup`. A pure function of (props + frame) — CLAUDE.md r.1.
 */
export const BlobCreatureProvider: React.FC<ProviderProps> = ({ layer, rigDef, easings, stylekit }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  // Validate the opaque spec, then apply the layer's INTRA-RIG `parts` variant selection (spec §8.1).
  // `parts` is core-opaque (a `record<string>` the engine forwards untouched); THIS provider interprets
  // it against its own `spec.variants` table — deep-merging the chosen overrides before drawing. Pure.
  const base = resolveSpec(rigDef.spec as Record<string, unknown> | undefined);
  const character = applyParts(base, layer.parts);
  // ADR-008 I3: honor the stylekit's quality-FLOOR liveness toggle. Default-alive (back-compat / no
  // stylekit). When `floor.liveness` is false, the creature holds a static neutral pose (no bob/sway/
  // breathe/blink) for a flat/technical look.
  const liveness = stylekit?.floor?.liveness ?? true;
  // M4b lip-sync: sample the optional `mouth` track (opaque to core; THIS provider interprets it) at the
  // scene-local frame → mouth openness 0..1. Absent → 0 (the resting smile, byte-identical to pre-M4b).
  const mouthOpen = sampleMouthOpenness(layer.mouth, frame);
  const markup = characterMarkup(character, frame, fps, layer.rig_state.clips, liveness, mouthOpen);

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
