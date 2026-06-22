// Generic per-layer COMPOSITING (M2 §11, ADR-003): the layer wrapper applies a BLEND MODE
// (CSS `mix-blend-mode`) and a TRACK MATTE / MASK (SVG mask / CSS mask-image) to ANY layer type,
// uniformly, on top of the §11.1 shading + the effects[] stack + parallax. "Reuse over invent"
// (CLAUDE.md r.3): these are the runtime's own compositing primitives — `mix-blend-mode`, SVG
// `<mask>`, and CSS `mask-image` — NEVER reimplemented.
//
// DETERMINISM (CLAUDE.md r.1): both are STATIC styles derived from the IR (no clock / RNG); the only
// frame dependence is the already-evaluated child content. A matte sourced from a sibling layer
// (`from`) re-renders that sibling's output INTO an SVG mask (its luma/alpha becomes the stencil); a
// matte sourced from an asset (`ref`) uses the asset image as a CSS `mask-image`.

import React from 'react';
import { AbsoluteFill, staticFile } from 'remotion';
import type { AssetDef, BlendMode, Matte } from '../ir/index.js';

/** Wrap content in a `mix-blend-mode` layer (no-op for `normal`/undefined). */
export function applyBlend(
  content: React.ReactNode,
  blend: BlendMode | undefined,
  layerId: string,
): React.ReactNode {
  if (!blend || blend === 'normal') return content;
  return (
    <AbsoluteFill data-blend={layerId} style={{ mixBlendMode: blend, isolation: 'isolate' }}>
      {content}
    </AbsoluteFill>
  );
}

/** Resolve an `asset://…` (or bare) URI to a `staticFile` URL under `public/`. */
function assetUrl(uri: string): string {
  const path = uri.includes('://') ? uri.slice(uri.indexOf('://') + 3) : uri;
  return staticFile(path);
}

/**
 * Apply a TRACK MATTE / MASK to `content`. Two source kinds:
 *   • ASSET matte (`matte.ref`): the image/SVG is a CSS `mask-image`. `luma`/`alpha`/`invert` map to
 *     `mask-mode: luminance|alpha` and an inverted compositing operator.
 *   • LAYER matte (`matte.from`): the sibling's rendered output is drawn INTO an inline SVG `<mask>`
 *     whose luminance gates the content — an AE-style track matte without baking. `matteSource` is the
 *     pre-rendered sibling node (supplied by the caller via `layersById`); when it is absent (no such
 *     sibling) the matte is a no-op so authoring errors degrade gracefully.
 * Returns `content` unchanged when there is no usable source.
 */
export function applyMatte(
  content: React.ReactNode,
  matte: Matte | undefined,
  layerId: string,
  opts: {
    /** Resolver for an ASSET matte source (`matte.ref` → its AssetDef), if any. */
    asset?: AssetDef | undefined;
    /** Pre-rendered sibling node for a LAYER matte source (`matte.from`), if any. */
    matteSource?: React.ReactNode;
    width: number;
    height: number;
  },
): React.ReactNode {
  if (!matte || (!matte.ref && !matte.from)) return content;
  const mode = matte.mode ?? 'luma';
  const invert = matte.invert ?? false;

  // --- ASSET matte: CSS mask-image (the simplest, fully-static path) ---
  if (matte.ref && opts.asset) {
    const url = assetUrl(opts.asset.uri);
    const maskMode = mode === 'luma' ? 'luminance' : 'alpha';
    // Invert via a compositing layer: an inverted mask is the source "subtract". CSS lacks a direct
    // invert, so we route an inverted ASSET matte through the SVG path below instead.
    if (!invert) {
      const maskStyle: React.CSSProperties = {
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
        WebkitMaskSize: '100% 100%',
        maskSize: '100% 100%',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        maskMode,
        WebkitMaskMode: maskMode,
      } as React.CSSProperties;
      return (
        <AbsoluteFill data-matte={layerId} style={maskStyle}>
          {content}
        </AbsoluteFill>
      );
    }
  }

  // --- SVG <mask>: handles LAYER mattes and inverted ASSET mattes ---
  // The mask source is rendered into an SVG <mask>; its luminance gates the content. For an inverted
  // matte we wrap the source in a white backdrop and `difference`-style invert via a filter.
  const maskId = `matte-${layerId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const { width, height } = opts;

  let sourceNode: React.ReactNode = null;
  if (matte.from && opts.matteSource != null) {
    sourceNode = opts.matteSource;
  } else if (matte.ref && opts.asset) {
    const url = assetUrl(opts.asset.uri);
    sourceNode = (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url} alt="" style={{ width: '100%', height: '100%', objectFit: 'fill' }} />
    );
  }
  if (sourceNode == null) return content;

  // A `luminance` mask uses pixel luminance as alpha; `alpha` uses the source alpha. We express both
  // via `maskType`. Invert: overlay a full white rect with `mix-blend-mode: difference` so bright↔dark.
  const maskType = mode === 'luma' ? 'luminance' : 'alpha';

  return (
    <AbsoluteFill data-matte={layerId}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', width: 0, height: 0 }}
        aria-hidden
      >
        <defs>
          <mask
            id={maskId}
            maskUnits="userSpaceOnUse"
            style={{ maskType } as React.CSSProperties}
          >
            {invert && <rect x={0} y={0} width={width} height={height} fill="white" />}
            <foreignObject
              x={0}
              y={0}
              width={width}
              height={height}
              style={invert ? { mixBlendMode: 'difference' } : undefined}
            >
              <div style={{ width, height }}>{sourceNode}</div>
            </foreignObject>
          </mask>
        </defs>
      </svg>
      <AbsoluteFill style={{ mask: `url(#${maskId})`, WebkitMask: `url(#${maskId})` }}>
        {content}
      </AbsoluteFill>
    </AbsoluteFill>
  );
}
