// core-objects renderer — the PROVIDER component (peer of blob-creature's BlobCreatureProvider,
// ADR-006). It receives the rig layer's OPAQUE `spec` (core treats it as `z.record(unknown)`),
// validates it with the plugin's OWN ObjectSpec (parseSpec), and renders via the plugin's
// `objectMarkup`. No vendor skeleton/mesh; identity is structural (fixed shapes, only transforms
// change). The layer's `{a,k}` transform is applied exactly like blob-creature / dragonbones so
// camera / parallax / attach line up.
//
// `parts` (the rig layer's intra-rig variant selection, M2) is folded into the spec the provider
// interprets: core hands `layer.parts` through and the provider merges it over `spec.parts` so the
// reserved IR field becomes functional for props (the provider chooses which part/skin to draw).
//
// dangerouslySetInnerHTML is safe here: the markup is produced by our OWN builder from a Zod-validated
// spec (palette is hex-regex-checked; size/stroke are numeric; kind/parts are enum/discriminator-only,
// never injected raw) — never raw untrusted input. Renders on the CPU (SVG) → byte-reproducible + fast.

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ProviderProps } from '../../src/engine/index.js';
import type { Easings } from '../../src/ir/index.js';
import { evalNumber, evalVec2 } from '../../src/render/eval.js';
import { parseSpec, STAR_SPEC, type ObjectSpec } from './spec.js';
import { objectMarkup } from './objects.js';

/** Validate the embedded opaque spec → ObjectSpec; fall back to the reference star spec if absent/invalid. */
function resolveSpec(raw: Record<string, unknown> | undefined): ObjectSpec {
  if (!raw) return STAR_SPEC;
  try {
    return parseSpec(raw);
  } catch {
    return STAR_SPEC;
  }
}

/**
 * The core-objects PROVIDER. Reads `rigDef.spec` (opaque to core), validates it as an ObjectSpec,
 * merges the rig layer's `parts` selection over the spec's, and draws the prop with `objectMarkup`.
 * A pure function of (props + frame) — CLAUDE.md r.1.
 */
export const ObjectProvider: React.FC<ProviderProps> = ({ layer, rigDef, easings, stylekit }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const base = resolveSpec(rigDef.spec as Record<string, unknown> | undefined);
  // M2 intra-rig part selection: the rig layer's `parts` map overrides the spec's own `parts`.
  const object: ObjectSpec = layer.parts
    ? { ...base, parts: { ...base.parts, ...layer.parts } }
    : base;

  const liveness = stylekit?.floor?.liveness ?? true;
  const markup = objectMarkup(object, frame, fps, liveness);

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
    <AbsoluteFill data-object-rig={layer.id}>
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

export default ObjectProvider;
