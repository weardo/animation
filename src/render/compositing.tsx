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

/** Dedup the "unsupported layer matte" warning to once per message per process (no render impact). */
const _matteWarned = new Set<string>();

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

  // --- LAYER mattes (matte.from) + INVERTED asset mattes: NOT supported on the SVG/Chromium backend ---
  // These need the stencil rendered into an SVG <mask> via <foreignObject>, but headless Chromium
  // renders foreignObject HTML into a mask as EMPTY (verified across 0×0 / full-size / luminance /
  // alpha / xmlns variants) — which would HIDE the content entirely. Degrade GRACEFULLY: show the
  // content UNMASKED + warn ONCE (never silently hide it). The reliable track matte today is a
  // NON-inverted ASSET matte (the CSS `mask-image` path above) — author the stencil as an SVG/PNG
  // asset (`matte.ref`). A proper layer matte (shape source → SVG `<clipPath>`) is a focused follow-up.
  void opts.matteSource;
  const why = `track-matte on "${layerId}" (${matte.from ? 'layer source' : 'inverted asset'}) is unsupported on this backend — showing UNMASKED. Use a non-inverted asset matte (matte.ref → mask SVG/PNG).`;
  if (!_matteWarned.has(why)) {
    _matteWarned.add(why);
    console.warn('[matte] ' + why);
  }
  return content;
}
