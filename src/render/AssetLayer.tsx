// <AssetLayer> — the compositor's entry point for a Scene-IR `asset` layer. Spec §7 (asset family),
// §15 (M1: one parallax background).
//
// An asset layer is FIXED art (icon / logo / prop / background) whose only motion is its transform
// plus camera-driven parallax. Identity is immutable (spec §2): the art is never re-synthesized, so
// it is byte-stable across frames by construction. M1 needs exactly one of these — a background with
// a `parallax` value that proves 2.5D depth.
//
// PARALLAX (spec §6.2, §9): the compositor applies the camera as a parent transform to all layers;
// a layer additionally shifts by `cameraPosition * (1 - parallax)` so far layers (low parallax) move
// LESS than the camera and near layers (parallax→1) move WITH it. The parallax offset is computed by
// the parent <Scene> and passed in here as `parallaxOffset` so this component stays presentational.
//
// DETERMINISM (CLAUDE.md r.1): no clock; a pure function of (resolved props + evaluated transform).

import React from 'react';
import { AbsoluteFill, Img, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { AssetDef, AssetLayer as AssetLayerIR, Easings } from '../ir/index.js';
import { evalNumber, evalVec2 } from './eval.js';

export interface AssetLayerProps {
  /** The Scene-IR asset layer ({ ref, parallax, transform? }). */
  layer: AssetLayerIR;
  /** The resolved asset definition (defs.assets[layer.ref]). */
  assetDef: AssetDef;
  /** Scene `defs.easings` so transform keyframes resolve their `e` names (never linear). */
  easings?: Easings | undefined;
  /**
   * The pre-computed parallax shift `[dx,dy]` (camera-driven) the parent <Scene> applies to this
   * layer ON TOP of its own transform. Far layers receive a smaller shift than the camera move.
   */
  parallaxOffset?: readonly [number, number] | undefined;
}

/**
 * Resolve an `asset://…` (or bare) URI to a Remotion `staticFile` URL under `public/`.
 * A `scheme://` prefix is stripped; anything else is treated as a path relative to `public/`.
 */
function resolveAssetUrl(uri: string): string {
  const path = uri.includes('://') ? uri.slice(uri.indexOf('://') + 3) : uri;
  return staticFile(path);
}

/**
 * Render one Scene-IR asset layer: its (animated) transform composed with the camera-driven parallax
 * offset, wrapping the immutable art. `svg`/`image` assets render as an <Img>; the art fills the
 * composition by default (a background) and is positioned by its transform when one is authored.
 */
export const AssetLayer: React.FC<AssetLayerProps> = ({
  layer,
  assetDef,
  easings,
  parallaxOffset,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  // Evaluate the layer's own `{a,k}` transform at this frame (all optional → identity defaults).
  const t = layer.transform;
  // Default position is the composition center; a background simply fills, so [0,0] translation
  // results when no transform is authored (handled by the center-relative translate below).
  const [tx, ty] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const [pdx, pdy] = parallaxOffset ?? [0, 0];

  // When a transform position is authored we translate to it (center-relative); otherwise the art
  // stays full-frame. The parallax offset is always added.
  const hasPosition = t?.position !== undefined;
  const translateX = (hasPosition ? tx - width / 2 : 0) + pdx;
  const translateY = (hasPosition ? ty - height / 2 : 0) + pdy;

  const url = resolveAssetUrl(assetDef.uri);

  const wrapperStyle: React.CSSProperties = {
    opacity: opacityPct / 100,
    transform: [
      `translate(${translateX}px, ${translateY}px)`,
      `rotate(${rotationDeg}deg)`,
      `scale(${scalePct / 100})`,
    ].join(' '),
    transformOrigin: 'center center',
  };

  return (
    <AbsoluteFill data-asset-layer={layer.id} style={wrapperStyle}>
      <Img
        src={url}
        style={{ width: '100%', height: '100%', objectFit: layer.fit ?? 'cover', display: 'block' }}
      />
    </AbsoluteFill>
  );
};

export default AssetLayer;
