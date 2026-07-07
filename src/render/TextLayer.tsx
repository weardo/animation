// <TextLayer> — the compositor's renderer for a Scene-IR `text` layer. TYPOGRAPHY as a GENERIC core
// primitive (the taxonomy lists asset/text), built as a THIN ADAPTER over the Remotion ecosystem
// (ADR-003: never reimplement a Remotion primitive). "Families are sockets; libraries are plugs":
// this socket adopts free libraries instead of hand-rolling text —
//
//   • A VENDORED LOCAL FONT — loaded via a CSS `@font-face` from `staticFile()` + the browser
//     `FontFace` API, gated by Remotion `delayRender`/`continueRender` so the glyphs are READY
//     BEFORE PAINT. No `@remotion/google-fonts` CDN (network + non-deterministic). This is the main
//     determinism risk: if the font is not ready when a frame paints, the metrics/glyphs differ
//     run-to-run. We hold the render until `document.fonts` reports the family loaded.
//   • @remotion/layout-utils (`fitText`) — box-fit + measurement. When the layer carries a `box`,
//     fitText computes the font size that fits the text within `box.w` (we never hand-roll metrics).
//   • Remotion `interpolate`/`spring` + StyleKit easing (eval.ts / stylekit.ts) — the kinetic
//     presets (fade/rise/stagger/typewriter/count_up). NO segment is ever accidentally linear unless
//     `floor.nonLinearMotion=false` (then motion is intentionally linear, per the selected stylekit).
//
// COLOR reuses the fill/color convention: a `defs.palette` token OR a hex string, resolved via the
// engine's shared `resolveFill`. TRANSFORM is the standard `{a,k}` position/scale/rotation/opacity,
// evaluated with the same StyleKit easing (eval.ts) as every other layer. Parallax + §11.1 shading
// are applied by the parent <Scene> via the same wrappers as asset/shape/rig/generator — this stays
// presentational and honors the `defs.stylekit` floor toggles read upstream in Scene.tsx.
//
// DETERMINISM (CLAUDE.md r.1): a pure function of (layer, palette, easings, frame, stylekit) once the
// font is loaded. No Date.now / Math.random; the font is vendored + local; the load gate guarantees
// glyphs are present before the first paint.

import React, { useState } from 'react';
import {
  AbsoluteFill,
  cancelRender,
  continueRender,
  delayRender,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { fitText } from '@remotion/layout-utils';
import type { Easings, Palette, TextLayer as TextLayerIR } from '../ir/index.js';
import { resolveFill } from '../engine/index.js';
import { evalNumber, evalVec2 } from './eval.js';
import { easingFn, NEUTRAL_STYLEKIT, type EasingFunction, type StyleKit } from './stylekit.js';

export interface TextLayerProps {
  /** The Scene-IR text layer ({ content, font?, size?, color?, align?, box?, anim?, transform? }). */
  layer: TextLayerIR;
  /** `defs.palette` for resolving token colors (shared with the shape/generator families). */
  palette?: Palette | undefined;
  /** `defs.easings` so transform + kinetic presets resolve their easing names (never linear). */
  easings?: Easings | undefined;
  /** The resolved stylekit — drives the `floor.nonLinearMotion` toggle + the spring config. */
  stylekit?: StyleKit | undefined;
}

/** A param off the loose `anim` channel, with a numeric default. */
function animNum(anim: Record<string, unknown> | undefined, key: string, fallback: number): number {
  const v = anim?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Resolve an `asset://…` (or bare) font URI to a Remotion `staticFile` URL under the render publicDir.
 * Mirrors AssetLayer's `resolveAssetUrl`: a `scheme://` prefix is stripped; the rest is a public path.
 */
export function resolveFontUrl(uri: string): string {
  const path = uri.includes('://') ? uri.slice(uri.indexOf('://') + 3) : uri;
  return staticFile(path);
}

/**
 * Inject a document-level CSS `@font-face` for (family,url) EXACTLY ONCE per document. A CSS
 * `@font-face` (vs a per-component `FontFace` object) lets the browser dedupe + cache the font fetch
 * across every text layer + every concurrent render tab, so high-concurrency video renders don't each
 * re-fetch the file (which exhausts socket/resource limits → `ERR_INSUFFICIENT_RESOURCES`). Keyed on
 * `family|url` so re-registration is a no-op. Returns the registered family name.
 */
const injectedFaces = new Set<string>();
function ensureFontFace(family: string, url: string): void {
  if (typeof document === 'undefined') return;
  const key = `${family}|${url}`;
  if (injectedFaces.has(key)) return;
  injectedFaces.add(key);
  const style = document.createElement('style');
  style.setAttribute('data-text-font', key);
  // `font-display: block` keeps glyphs hidden (never a fallback face) until the local font loads —
  // combined with the delayRender gate below, a frame never paints with the wrong metrics.
  style.textContent = `@font-face{font-family:${JSON.stringify(family)};src:url(${JSON.stringify(
    url,
  )});font-display:block;}`;
  document.head.appendChild(style);
}

/**
 * Load the vendored font DETERMINISTICALLY before paint. Registers the CSS `@font-face` once, then
 * holds a Remotion `delayRender` handle until `document.fonts.load()` reports the family ready — so
 * glyphs + metrics are present when the frame paints (the core determinism guarantee). The browser
 * caches the underlying fetch per document, so this is safe under high render concurrency. Returns
 * once the font is ready; surfaces a genuine load failure via cancelRender (never a silent fallback).
 */
export function useVendoredFont(family: string, url: string): boolean {
  const [ready, setReady] = useState(false);
  const [handle] = useState(() => delayRender(`TextLayer:font:${family}`));
  React.useEffect(() => {
    let cancelled = false;
    if (typeof document === 'undefined' || !document.fonts) {
      setReady(true);
      continueRender(handle);
      return;
    }
    ensureFontFace(family, url);
    // `document.fonts.load` resolves when the matching face is downloaded + parsed (or already cached).
    document.fonts
      .load(`1em ${JSON.stringify(family)}`)
      .then(() => {
        if (cancelled) return;
        setReady(true);
        continueRender(handle);
      })
      .catch((err: unknown) => {
        // Fail loud rather than hang on the delayRender or silently paint a fallback face.
        cancelRender(err instanceof Error ? err : new Error(String(err)));
      });
    return () => {
      cancelled = true;
    };
    // The font identity is fixed for the layer's lifetime; load exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [family, url]);
  return ready;
}

/**
 * Render one Scene-IR text layer. Geometry is laid out by the browser (DOM text); we only compute the
 * per-frame kinetic transforms + reveal via Remotion `interpolate`/`spring` + StyleKit easing. The
 * layer transform + parallax + §11.1 shading are applied by the parent <Scene> via the same wrappers
 * as other layers (this component is presentational).
 */
export const TextLayer: React.FC<TextLayerProps> = ({ layer, palette, easings, stylekit }) => {
  const frame = useCurrentFrame();
  const { width, fps } = useVideoConfig();
  const easingTable: Easings = easings ?? {};
  const sk: StyleKit = stylekit ?? NEUTRAL_STYLEKIT;
  // Floor toggle (ADR-008 I3): when nonLinearMotion is OFF the selected stylekit WANTS linear motion,
  // so the presets interpolate without an easing curve; otherwise they use the StyleKit "smooth" curve.
  const nonLinear = sk.floor.nonLinearMotion;
  const ease: EasingFunction | undefined = nonLinear ? easingFn('smooth', easingTable) : undefined;

  // --- font: vendor a LOCAL face, held until ready (deterministic, offline) ---
  const family = layer.font ?? 'DejaVu Sans';
  const fontUrl = resolveFontUrl(layer.fontUri ?? 'asset://fonts/DejaVuSans.ttf');
  const fontReady = useVendoredFont(family, fontUrl);

  // --- transform (evaluated at this frame); position defaults to composition centre ---
  const t = layer.transform;
  const { height } = useVideoConfig();
  const [tx, ty] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const baseOpacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const color = resolveFill(layer.color ?? 'ink', palette, '#ffffff');
  const align = layer.align ?? 'center';
  const weight = layer.weight ?? 400;
  const lineHeight = layer.lineHeight ?? 1.2;
  const tracking = layer.tracking ?? 0;

  // Don't lay out text until the font is ready, so fitText metrics + the painted glyphs match.
  if (!fontReady) return <AbsoluteFill data-text-layer={layer.id} />;

  // --- font size: a `box` drives fit-to-box via @remotion/layout-utils fitText; else `size` (default). ---
  let fontSize = layer.size ?? 64;
  const measureText = layer.anim?.preset === 'count_up' ? formatCount(layer, animNum(layer.anim, 'to', 0)) : layer.content;
  if (layer.box) {
    const fit = fitText({
      text: measureText,
      withinWidth: layer.box.w,
      fontFamily: family,
      fontWeight: weight,
      letterSpacing: tracking ? `${tracking}px` : undefined,
    });
    // Cap to the box height as well (single-line fit), so a tall string can't overflow vertically.
    fontSize = Math.min(fit.fontSize, layer.box.h / lineHeight);
  }

  // --- kinetic preset → per-frame opacity / translateY / reveal ---
  const anim = (layer.anim ?? {}) as Record<string, unknown>;
  const preset = (layer.anim?.preset ?? 'none') as string;
  let presetOpacity = 1;
  let presetTranslateY = 0;
  let visibleText = layer.content;
  // Per-unit (char/word) renders for `stagger`.
  let staggerUnits: React.ReactNode | null = null;

  // Spread the easing only when present (exactOptionalPropertyTypes: never pass `easing: undefined`).
  // When `ease` is undefined the stylekit WANTS linear motion (floor.nonLinearMotion=false).
  const easeOpt = ease ? { easing: ease } : {};
  const ramp = (from: number, to: number, t0: number, t1: number): number =>
    interpolate(frame, [t0, t1], [from, to], {
      ...easeOpt,
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });

  switch (preset) {
    case 'fade': {
      const dur = animNum(anim, 'duration', 18);
      const delay = animNum(anim, 'delay', 0);
      presetOpacity = ramp(0, 1, delay, delay + dur);
      break;
    }
    case 'rise': {
      const dur = animNum(anim, 'duration', 20);
      const delay = animNum(anim, 'delay', 0);
      const distance = animNum(anim, 'distance', 40);
      presetOpacity = ramp(0, 1, delay, delay + dur);
      presetTranslateY = ramp(distance, 0, delay, delay + dur);
      break;
    }
    case 'stagger': {
      const unit = (anim['unit'] as 'char' | 'word') ?? 'word';
      const step = animNum(anim, 'stagger', 3);
      const dur = animNum(anim, 'duration', 16);
      const delay = animNum(anim, 'delay', 0);
      const distance = animNum(anim, 'distance', 24);
      staggerUnits = renderStaggered(layer.content, unit, (i) => {
        const start = delay + i * step;
        const o = interpolate(frame, [start, start + dur], [0, 1], {
          ...easeOpt,
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        const dy = interpolate(frame, [start, start + dur], [distance, 0], {
          ...easeOpt,
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return { opacity: o, translateY: dy };
      });
      break;
    }
    case 'typewriter': {
      const cps = animNum(anim, 'cps', 24);
      const delay = animNum(anim, 'delay', 0);
      const elapsed = Math.max(0, frame - delay);
      const shown = Math.floor((elapsed / fps) * cps);
      visibleText = layer.content.slice(0, Math.max(0, Math.min(layer.content.length, shown)));
      break;
    }
    case 'count_up': {
      const from = animNum(anim, 'from', 0);
      const to = animNum(anim, 'to', 100);
      const dur = animNum(anim, 'duration', 30);
      const delay = animNum(anim, 'delay', 0);
      // Spring-eased count when nonLinear; linear ramp otherwise. spring is a pure fn of (frame,fps).
      const progress = nonLinear
        ? spring({ frame: frame - delay, fps, config: sk.motion.spring, durationInFrames: dur })
        : interpolate(frame, [delay, delay + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
      const value = from + (to - from) * progress;
      visibleText = formatCount(layer, value);
      break;
    }
    case 'none':
    default:
      break;
  }

  const opacity = (baseOpacityPct / 100) * presetOpacity;

  // The text block is centred on the evaluated transform position; the kinetic translateY + the
  // scale/rotation transform are composited via CSS (transformOrigin centre, like ShapeLayer).
  const blockStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: ty,
    width,
    transform: `translateY(${presetTranslateY}px) translateY(-50%) rotate(${rotationDeg}deg) scale(${scalePct / 100})`,
    transformOrigin: 'center center',
    opacity,
    color,
    fontFamily: `${JSON.stringify(family)}, sans-serif`,
    fontSize,
    fontWeight: weight as React.CSSProperties['fontWeight'],
    lineHeight,
    letterSpacing: tracking ? `${tracking}px` : undefined,
    textAlign: align,
    // Anchor the block horizontally on tx by offsetting the full-width block.
    paddingLeft: align === 'left' ? tx : 0,
    paddingRight: align === 'right' ? width - tx : 0,
    whiteSpace: 'pre-wrap',
    pointerEvents: 'none',
  };

  return (
    <AbsoluteFill data-text-layer={layer.id}>
      <div style={blockStyle}>{staggerUnits ?? visibleText}</div>
    </AbsoluteFill>
  );
};

/** Format a `count_up` value with the layer's `anim` decimals/prefix/suffix (DATA, loose). */
function formatCount(layer: TextLayerIR, value: number): string {
  const anim = (layer.anim ?? {}) as Record<string, unknown>;
  const decimals = animNum(anim, 'decimals', 0);
  const prefix = typeof anim['prefix'] === 'string' ? (anim['prefix'] as string) : '';
  const suffix = typeof anim['suffix'] === 'string' ? (anim['suffix'] as string) : '';
  // Deterministic, locale-independent formatting (no Intl locale variance).
  const fixed = value.toFixed(Math.max(0, Math.round(decimals)));
  return `${prefix}${fixed}${suffix}`;
}

/**
 * Render text split into per-`unit` (char|word) spans, each driven by a per-index `style` callback
 * (the stagger cascade). Whitespace between words is preserved as non-animated spans so layout holds.
 */
function renderStaggered(
  text: string,
  unit: 'char' | 'word',
  styleFor: (index: number) => { opacity: number; translateY: number },
): React.ReactNode {
  if (unit === 'char') {
    return [...text].map((ch, i) => {
      const { opacity, translateY } = styleFor(i);
      return (
        <span
          key={i}
          style={{ display: 'inline-block', opacity, transform: `translateY(${translateY}px)`, whiteSpace: 'pre' }}
        >
          {ch}
        </span>
      );
    });
  }
  // word: split on spaces, keep the separators so spacing is preserved.
  const parts = text.split(/(\s+)/);
  let wordIndex = 0;
  return parts.map((part, i) => {
    if (/^\s+$/.test(part)) return <span key={i} style={{ whiteSpace: 'pre' }}>{part}</span>;
    const { opacity, translateY } = styleFor(wordIndex++);
    return (
      <span
        key={i}
        style={{ display: 'inline-block', opacity, transform: `translateY(${translateY}px)` }}
      >
        {part}
      </span>
    );
  });
}

export default TextLayer;
