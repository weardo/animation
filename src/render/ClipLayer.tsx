// <ClipLayer> — the compositor's renderer for a Scene-IR `clip` layer: a PRE-COMPOSITION INSTANCE
// (M2 nested composition). Spec §13.3 + the clip design doc §5/§6. "Reuse over invent" (CLAUDE.md
// r.3): the local timeline is Remotion's `<Sequence>` (NEVER reimplemented — it gives the inner frame,
// reset to 0, plus the time-shift); the param override is the AE Essential-Graphics / .mogrt model;
// the shared def is the Lottie `assets` precomp. The only genuinely-ours pieces are the PURE param
// substitution (`resolveParams`) + the per-instance NAMESPACING/SEEDING (`clip.ts`).
//
// HOW IT COMPOSES (recursion with no special machinery):
//   • def = defs.clips[layer.ref]   — the SHARED def (one per ref; N instances reference it).
//   • <Sequence from durationInFrames> wraps a transform/opacity GROUP (the whole unit moves together).
//   • each def.layer TEMPLATE → resolveParams(tmpl, { ...defaults, ...layer.args }) → a concrete layer,
//     its id NAMESPACED as `<clipLayerId>/<innerId>` and (for generators) its SEED derived from a pure
//     hash of that namespaced id — so the SAME clip used twice renders DISTINCTLY yet reproducibly,
//     never baking seeds into the shared def.
//   • each concrete layer is validated (the strict Scene-IR LayerSchema) and rendered through the SAME
//     LayerView dispatch (Scene.tsx) — which itself includes the `clip` case, so a clip-in-a-clip just
//     re-enters here → arbitrary nesting, no extra code.
//
// DETERMINISM (CLAUDE.md r.1): pure function of (layer, def, frame). `<Sequence>` is frame-driven; the
// group transform resolves `{a,k}` via the shared evaluator; substitution + seed derivation are pure;
// the inner parallax offset is [0,0] (the whole clip already rode the camera/parallax at the outer
// LayerView wrapper) so there is no double-shift. CPU raster default.

import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import type { ClipDef, ClipLayer as ClipLayerIR, Defs, Easings } from '../ir/index.js';
import { validateLayer } from '../ir/index.js';
import type { Light, StyleKit } from './stylekit.js';
import { evalNumber, evalVec2 } from './eval.js';
import { LayerView } from './Scene.js';
import { resolveParams, mergeParamValues, namespaceId, deriveClipSeed } from './clip.js';

export interface ClipLayerProps {
  /** The Scene-IR clip layer (the instance: ref + args + group transform + from/duration). */
  layer: ClipLayerIR;
  /** The resolved SHARED clip definition (`defs.clips[layer.ref]`): params + duration + templates. */
  def: ClipDef;
  /** The scene `defs` the inner layers resolve against (palette/assets/rigs/clips/stylekit). */
  defs: Defs;
  /** `defs.easings` so the group transform + inner `{a,k}` channels resolve their easing names. */
  easings: Easings;
  /** The effective scene light (passed through to inner layers' §11.1 shading). */
  light: Light;
  /** The resolved stylekit (floor toggles + spring config), passed through to inner layers. */
  stylekit: StyleKit;
}

/**
 * Resolve one clip-def layer TEMPLATE into a concrete, validated, NAMESPACED Scene-IR layer for this
 * instance. Pure: substitutes params, prefixes the id with the clip-layer id, and — for generator
 * layers — derives the seed from the namespaced id (so two instances differ deterministically). Throws
 * (via the strict LayerSchema) if a template substitutes to an invalid layer — a loud authoring error.
 */
function resolveInnerLayer(
  template: Record<string, unknown>,
  values: Record<string, unknown>,
  clipLayerId: string,
) {
  const resolved = resolveParams(template, values) as Record<string, unknown>;
  const innerId = typeof resolved['id'] === 'string' ? (resolved['id'] as string) : 'layer';
  const nsId = namespaceId(clipLayerId, innerId);
  resolved['id'] = nsId;
  // A nested generator's seed derives from the per-instance namespaced id (never the shared def), so
  // the same clip used twice scatters distinctly yet reproducibly. A nested `clip` layer's own inner
  // seeds derive recursively from ITS namespaced id when it renders (this function runs again there).
  if (resolved['type'] === 'generator') {
    resolved['seed'] = deriveClipSeed(nsId);
  }
  // Validate the substituted layer at the boundary (the strict union now accepts it; templates were
  // loose only because of the un-substituted references). Returns a typed Scene-IR Layer.
  return validateLayer(resolved);
}

/**
 * Render one clip instance: a `<Sequence>` (local timeline) wrapping a transform/opacity GROUP that
 * contains the def's layers, each substituted + namespaced + dispatched through the shared LayerView.
 */
export const ClipLayer: React.FC<ClipLayerProps> = ({ layer, def, defs, easings, light, stylekit }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  // Merged param values: def defaults overridden by the instance args (the Essential-Graphics rule).
  const values = mergeParamValues(def.params, layer.args);

  // The local-timeline window: `from` shifts + resets the inner frame to 0; the window length defaults
  // to the def's own duration. Remotion's <Sequence> owns this (reuse over invent).
  const from = layer.from ?? 0;
  const durationInFrames = layer.duration_frames ?? def.duration_frames;

  // The group transform moves the WHOLE unit as one object (the AE precomp transform):
  //   • POSITION  — the clip's placement (anchor → `transform.position`, resolved by the layout pass);
  //     it becomes the clip's LOCAL ORIGIN, so an inner layer authored at `[0,0]` sits at the clip
  //     placement and other inner positions are offsets from it (the precomp's local coordinate space).
  //   • SCALE/ROTATION/OPACITY — applied about that origin so the unit scales/rotates/fades together.
  // Evaluated at the parent frame (the group rides the parent timeline); inner motion resets via the
  // <Sequence> local frame.
  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easings, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easings, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easings, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easings, 100);

  const groupStyle: React.CSSProperties = {
    opacity: opacityPct / 100,
    transform: `translate(${px}px, ${py}px) rotate(${rotationDeg}deg) scale(${scalePct / 100})`,
    transformOrigin: 'top left',
  };

  return (
    <Sequence from={from} durationInFrames={durationInFrames} layout="none" name={`clip:${layer.id}`}>
      <AbsoluteFill style={groupStyle} data-clip-layer={layer.id}>
        {def.layers.map((template, i) => {
          const inner = resolveInnerLayer(template, values, layer.id);
          return (
            <LayerView
              key={inner.id || i}
              layer={inner}
              defs={defs}
              easings={easings}
              // Inner parallax is [0,0]: the whole clip already received the camera/parallax shift at
              // the outer wrapper; an inner layer must not double-shift (there is no camera here).
              parallaxOffset={[0, 0]}
              light={light}
              stylekit={stylekit}
            />
          );
        })}
      </AbsoluteFill>
    </Sequence>
  );
};

export default ClipLayer;
