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
import type { ShapeClipGeometry } from './ShapeLayer.js';

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
    /**
     * A4: when the LAYER matte source (`matte.from`) is a SHAPE layer, its screen-space clip geometry
     * (resolved by the caller via `shapeClipGeometry`). Lets us build a REAL SVG `<clipPath>` from the
     * source shape's path — which clips reliably in headless Chromium (unlike the foreignObject `<mask>`
     * the layer matte would otherwise need). Absent → fall through to the graceful "unsupported" warn.
     */
    shapeClip?: ShapeClipGeometry | undefined;
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

  // --- LAYER matte whose SOURCE is a SHAPE → a full-frame SVG stencil applied as a CSS `mask-image` (A4) ---
  // The shape's path geometry IS the stencil: the filled outline is the reveal region. We build a
  // COMPOSITION-SIZED inline SVG (white shape on transparent) as a `data:` URI and route it through the
  // SAME CSS `mask-image` path the ASSET matte uses (above). We mirror <ShapeLayer>'s placement exactly
  // (translate to the box top-left, then rotate/scale about the box centre) so the stencil aligns
  // pixel-for-pixel with what the source shape paints. `mode` is moot for a vector stencil — the geometry
  // is the reveal. Inverted shape mattes (a HOLE) can't be expressed this way, so they fall through to
  // the graceful warn below.
  //
  // DETERMINISM (the load-bearing fix, DECISIONS 2026-06-23): we DELIBERATELY do NOT use SVG
  // `clip-path: url(#…)` here. A live vector clip-path re-rasterizes its ANTI-ALIASED edge per frame in
  // the continuous `renderMedia` VIDEO path with sub-pixel drift (~51 dB, confined to the ~1px clip
  // outline) — it was byte-identical under `renderStill` but NOT across cold `renderMedia` processes,
  // violating the byte-identical-VIDEO invariant. A `mask-image` data-URI is composited as a static
  // IMAGE layer (the proven byte-identical asset-matte path), so the shape track-matte is now
  // BYTE-IDENTICAL in the muxed video too — no perceptual-only carve-out. The SVG string is a pure
  // function of (geometry, frame), so the data-URI is identical every run.
  if (matte.from && opts.shapeClip && !invert) {
    const g = opts.shapeClip;
    // Transform from the path's LOCAL coords (viewBox `box`) to screen space, matching ShapeLayer:
    //   • the SVG is placed at (left, top) sized (width,height) with viewBox = box, so local (box.x,
    //     box.y) maps to (left, top) and one local unit = one screen px (no viewBox scaling);
    //   • then `rotate(deg) scale(s)` about the box CENTRE (transformOrigin center).
    const cx = g.left + g.width / 2;
    const cy = g.top + g.height / 2;
    const transform =
      `translate(${cx} ${cy}) rotate(${g.rotationDeg}) scale(${g.scale}) ` +
      `translate(${-g.width / 2} ${-g.height / 2}) translate(${-g.box.x} ${-g.box.y})`;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${opts.width}" height="${opts.height}" ` +
      `viewBox="0 0 ${opts.width} ${opts.height}">` +
      `<path d="${g.d}" transform="${transform}" fill="#fff"/></svg>`;
    const url = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    const maskStyle: React.CSSProperties = {
      WebkitMaskImage: `url("${url}")`,
      maskImage: `url("${url}")`,
      WebkitMaskSize: '100% 100%',
      maskSize: '100% 100%',
      WebkitMaskRepeat: 'no-repeat',
      maskRepeat: 'no-repeat',
      // luminance: white path → opaque reveal, transparent → hidden. (`alpha` would behave the same here
      // since the fill is opaque white; luminance keeps parity with the asset-matte default.)
      maskMode: 'luminance',
      WebkitMaskMode: 'luminance',
      // DETERMINISM: pin this masked subtree onto its OWN isolated stacking context so the compositor's
      // mask raster surface cannot perturb the sub-pixel rounding of SIBLING layers in the continuous
      // `renderMedia` video path. (A bare full-frame mask surface drifted whole-frame across cold renders;
      // isolation confines the masked surface to its own buffer.)
      isolation: 'isolate',
    } as React.CSSProperties;
    return (
      <AbsoluteFill data-matte={layerId} style={maskStyle}>
        {content}
      </AbsoluteFill>
    );
  }

  // --- LAYER mattes (matte.from) + INVERTED asset mattes: NOT supported on the SVG/Chromium backend ---
  // These need the stencil rendered into an SVG <mask> via <foreignObject>, but headless Chromium
  // renders foreignObject HTML into a mask as EMPTY (verified across 0×0 / full-size / luminance /
  // alpha / xmlns variants) — which would HIDE the content entirely. Degrade GRACEFULLY: show the
  // content UNMASKED + warn ONCE (never silently hide it). The reliable track matte today is a
  // NON-inverted ASSET matte (the CSS `mask-image` path above) — author the stencil as an SVG/PNG
  // asset (`matte.ref`). A proper layer matte (shape source → SVG `<clipPath>`) is a focused follow-up.
  void opts.matteSource;
  const reason = matte.from
    ? opts.shapeClip
      ? 'inverted shape-layer source'
      : 'non-shape layer source'
    : 'inverted asset';
  const why = `track-matte on "${layerId}" (${reason}) is unsupported on this backend — showing UNMASKED. Use a NON-inverted SHAPE layer source (matte.from → a shape layer) or a non-inverted asset matte (matte.ref → mask SVG/PNG).`;
  if (!_matteWarned.has(why)) {
    _matteWarned.add(why);
    console.warn('[matte] ' + why);
  }
  return content;
}
