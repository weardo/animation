// core-effects — the built-in `effects[]` channel ops, shipped AS A PLUGIN (ADR-003 #2, ADR-005
// "families/registries are sockets; plugins are plugs"). It contributes a composable, animatable
// per-layer effect stack into the engine's generic `effects` extension point via `api.registerEffect`.
// The ENGINE owns only the generic registry + the EffectImpl/EffectContribution contract (no domain
// knowledge of any specific effect); EVERY specific effect (blur/glow/grade/turbulence/…) lives HERE.
//
// "Our families are sockets; free libraries are plugs" (ADR-003): instead of inventing an effects
// engine we adopt the Tier-A, deterministic, disk-safe catalogs —
//   • native SVG <filter> primitives (feGaussianBlur / feColorMatrix / feTurbulence + feDisplacementMap
//     / feComponentTransfer) for blur, color-grade, displacement, vignette, grain;
//   • CSS `filter` fragments (brightness/contrast/saturate/hue-rotate, drop-shadow) for cheap ops;
//   • @remotion/motion-blur <Trail> for motion_blur.
// All are frame-deterministic on the CPU raster default (CLAUDE.md r.1) — no WebGL/GPU (that would be
// Tier-B, non-deterministic + disk-balloon; ADR-003).
//
// COMPOSITION: the compositor (src/render/effects.tsx) walks a layer's `effects[]` IN ORDER. SVG-filter
// contributions are CHAINED inside one deterministic <filter id="fx-<layer.id>"> (each effect's output
// `result` feeds the next effect's input); CSS-filter fragments are concatenated; `wrap` contributions
// (motion_blur) wrap the whole layer subtree. This stack composites cleanly ON TOP of the default-on
// §11.1 shading drop-shadow + parallax (those wrappers are untouched).
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring. Each EffectImpl.build is a pure function
// of (validated params, frame) — no clock, no RNG. The frame is passed in so animatable effect params
// resolve deterministically; turbulence/grain seed their feTurbulence with a fixed `seed` param.

import React from 'react';
import { Trail } from '@remotion/motion-blur';
import { z } from 'zod';
import type { EngineAPI, Plugin, EffectImpl, EffectContribution } from '../../src/engine/index.js';
import { parseManifest } from '../../src/engine/index.js';
import manifestJson from './plugin.json' with { type: 'json' };

const manifest = parseManifest(manifestJson);

// ---------------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------------

/**
 * Build a typed EffectImpl from an in-plugin Zod schema + a pure (params, frame) → contribution fn.
 * The schema `.strip()`s unknown keys (the loose IR carries `kind`, which the compositor removes before
 * calling parse). `build` receives the validated, defaulted params so every field is present.
 */
function defineEffect<S extends z.ZodTypeAny>(
  schema: S,
  build: (params: z.infer<S>, frame: number) => EffectContribution,
): EffectImpl {
  return {
    parse: (params) => schema.parse(params),
    build: (params, frame) => build(params as z.infer<S>, frame),
  };
}

/** #rrggbb (or #rgb) → {r,g,b} 0–1 floats for feColorMatrix / flood. Pure; tolerant of leading '#'. */
function hexRgb01(hex: string): { r: number; g: number; b: number } {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

// ---------------------------------------------------------------------------------------------------
// Effect implementations (each = its own narrow Zod + a deterministic contribution)
// ---------------------------------------------------------------------------------------------------

/** blur — gaussian blur (feGaussianBlur). `radius` in px (stdDeviation). */
const blur = defineEffect(
  z.object({ radius: z.number().nonnegative().default(4) }).strip(),
  (p) => ({
    filterPrimitives: [
      (inR, outR) =>
        React.createElement('feGaussianBlur', { in: inR, stdDeviation: p.radius, result: outR }),
    ],
  }),
);

/**
 * glow — an emissive bloom around the layer's silhouette. A blurred, color-flooded copy of the source
 * is laid UNDER the source. Implemented as SVG-filter primitives so it composes in the chain; `color`
 * tints the bloom, `radius` is its spread, `intensity` its opacity.
 */
const glow = defineEffect(
  z
    .object({
      color: z.string().default('#ffd27f'),
      radius: z.number().nonnegative().default(8),
      intensity: z.number().min(0).max(1).default(0.8),
    })
    .strip(),
  (p) => {
    const { r, g, b } = hexRgb01(p.color);
    return {
      filterPrimitives: [
        // blur the source alpha → bloom shape
        (inR, outR) =>
          React.createElement('feGaussianBlur', { in: inR, stdDeviation: p.radius, result: `${outR}-b` }),
        // flood the bloom with the glow color, masked to the blurred alpha
        (inR, outR) =>
          React.createElement(
            React.Fragment,
            null,
            React.createElement('feColorMatrix', {
              in: `${inR}-b`,
              type: 'matrix',
              // zero RGB, write flat color scaled by intensity into RGB, keep alpha
              values: [0, 0, 0, r, 0, 0, 0, 0, g, 0, 0, 0, 0, b, 0, 0, 0, 0, p.intensity, 0].join(' '),
              result: `${outR}-c`,
            }),
            // composite the original source OVER the colored bloom
            React.createElement('feMerge', { result: outR }, [
              React.createElement('feMergeNode', { key: 'glow', in: `${outR}-c` }),
              React.createElement('feMergeNode', { key: 'src', in: inR }),
            ]),
          ),
      ],
    };
  },
);

/**
 * drop_shadow — a cast shadow offset from the layer. Uses the CSS `drop-shadow` filter (silhouette-
 * following, works on SVG content AND the rig canvas alike, exactly like §11.1's objectFilter). `dx`/
 * `dy` offset px, `blur` px, `color`+`opacity` the shadow tint.
 */
const drop_shadow = defineEffect(
  z
    .object({
      dx: z.number().default(0),
      dy: z.number().default(6),
      blur: z.number().nonnegative().default(8),
      color: z.string().default('#0a0e18'),
      opacity: z.number().min(0).max(1).default(0.45),
    })
    .strip(),
  (p) => {
    const { r, g, b } = hexRgb01(p.color);
    const rgba = `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${p.opacity})`;
    return { cssFilter: `drop-shadow(${p.dx}px ${p.dy}px ${p.blur}px ${rgba})` };
  },
);

/**
 * color_grade — brightness / contrast / saturate / hue rotation. Lowered to a CSS `filter` chain
 * (brightness/contrast/saturate/hue-rotate) — all four are native, deterministic CSS filter functions.
 */
const color_grade = defineEffect(
  z
    .object({
      brightness: z.number().nonnegative().default(1),
      contrast: z.number().nonnegative().default(1),
      saturate: z.number().nonnegative().default(1),
      hue: z.number().default(0), // degrees
    })
    .strip(),
  (p) => {
    const parts: string[] = [];
    if (p.brightness !== 1) parts.push(`brightness(${p.brightness})`);
    if (p.contrast !== 1) parts.push(`contrast(${p.contrast})`);
    if (p.saturate !== 1) parts.push(`saturate(${p.saturate})`);
    if (p.hue !== 0) parts.push(`hue-rotate(${p.hue}deg)`);
    return parts.length ? { cssFilter: parts.join(' ') } : {};
  },
);

/**
 * turbulence — a displacement ripple/flow/heat-haze (feTurbulence + feDisplacementMap). `frequency`
 * is the noise base frequency, `scale` the displacement magnitude (px), `octaves` the fractal detail,
 * `seed` the deterministic noise seed (fixed per layer → byte-identical every run). `animate` shifts
 * the noise phase by frame for a flowing ripple (still deterministic: a pure function of `frame`).
 */
const turbulence = defineEffect(
  z
    .object({
      frequency: z.number().positive().default(0.02),
      scale: z.number().nonnegative().default(12),
      octaves: z.number().int().min(1).max(6).default(2),
      seed: z.number().int().default(0),
      animate: z.number().default(0), // phase units per frame; 0 = static
    })
    .strip(),
  (p, frame) => {
    // Animated flow: nudge the base frequency in y by a tiny frame-driven delta (pure fn of frame).
    const fy = p.animate !== 0 ? p.frequency + (frame * p.animate) / 10000 : p.frequency;
    return {
      filterPrimitives: [
        (_inR, outR) =>
          React.createElement('feTurbulence', {
            type: 'fractalNoise',
            baseFrequency: `${p.frequency} ${fy}`,
            numOctaves: p.octaves,
            seed: p.seed,
            stitchTiles: 'stitch',
            result: `${outR}-noise`,
          }),
        (inR, outR) =>
          React.createElement('feDisplacementMap', {
            in: inR,
            in2: `${outR}-noise`,
            scale: p.scale,
            xChannelSelector: 'R',
            yChannelSelector: 'G',
            result: outR,
          }),
      ],
    };
  },
);

/** displace — alias name for the raw displacement op (same impl as turbulence; ADR task lists both). */
const displace = turbulence;

/**
 * vignette — darkened corners. A radial gradient overlay is hard in a per-object filter, so this uses
 * a feComponentTransfer alpha-independent darkening combined with the source; we approximate a vignette
 * as a CSS radial via `wrap` so it tracks the layer box. `amount` 0–1 darkness at the corners.
 */
const vignette = defineEffect(
  z.object({ amount: z.number().min(0).max(1).default(0.4), softness: z.number().min(0).max(1).default(0.5) }).strip(),
  (p) => {
    const inner = `${(40 + p.softness * 30).toFixed(0)}%`;
    return {
      wrap: (node) =>
        React.createElement(
          'div',
          { style: { position: 'absolute', inset: 0, pointerEvents: 'none' } },
          node,
          React.createElement('div', {
            key: 'vignette',
            style: {
              position: 'absolute',
              inset: 0,
              pointerEvents: 'none',
              background: `radial-gradient(ellipse at center, rgba(0,0,0,0) ${inner}, rgba(4,6,12,${p.amount}) 100%)`,
            },
          }),
        ),
    };
  },
);

/**
 * grain — film grain via feTurbulence noise blended over the layer. Deterministic (fixed `seed`); a
 * `feColorMatrix` desaturates the noise to monochrome and `feComponentTransfer` sets its opacity, then
 * it is composited over the source. `amount` is the grain opacity, `size` the noise frequency.
 */
const grain = defineEffect(
  z
    .object({
      amount: z.number().min(0).max(1).default(0.12),
      size: z.number().positive().default(0.9),
      seed: z.number().int().default(0),
    })
    .strip(),
  (p) => ({
    filterPrimitives: [
      (_inR, outR) =>
        React.createElement(
          React.Fragment,
          null,
          React.createElement('feTurbulence', {
            type: 'fractalNoise',
            baseFrequency: p.size,
            numOctaves: 2,
            seed: p.seed,
            stitchTiles: 'stitch',
            result: `${outR}-n`,
          }),
          // desaturate noise to gray
          React.createElement('feColorMatrix', {
            in: `${outR}-n`,
            type: 'matrix',
            values: [0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0.5, 0, 0, 0, p.amount, 0].join(' '),
            result: `${outR}-g`,
          }),
        ),
      (inR, outR) =>
        React.createElement(
          React.Fragment,
          null,
          // clip the grain to the source silhouette, then overlay it
          React.createElement('feComposite', {
            in: `${outR}-g`,
            in2: inR,
            operator: 'in',
            result: `${outR}-gi`,
          }),
          React.createElement('feBlend', { in: inR, in2: `${outR}-gi`, mode: 'overlay', result: outR }),
        ),
    ],
  }),
);

/**
 * motion_blur — directional/temporal motion blur via @remotion/motion-blur <Trail>. Wraps the layer
 * subtree; renders `layers` lagged copies fading by `trailOpacity` over `lagInFrames`. Frame-
 * deterministic (Trail samples prior frames, no clock/RNG).
 */
const motion_blur = defineEffect(
  z
    .object({
      layers: z.number().int().min(1).max(20).default(5),
      lagInFrames: z.number().nonnegative().default(1),
      trailOpacity: z.number().min(0).max(1).default(0.5),
    })
    .strip(),
  (p) => ({
    wrap: (node) =>
      React.createElement(Trail, {
        layers: p.layers,
        lagInFrames: p.lagInFrames,
        trailOpacity: p.trailOpacity,
        children: node,
      }),
  }),
);

// ---------------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------------

/**
 * raw — the DECLARATIVE PASSTHROUGH (ADR-003 "use the declarative language, don't pre-define every
 * effect"): expose the CSS `filter` property directly. CSS filter IS the web's declarative effect
 * language — blur() brightness() contrast() saturate() hue-rotate() sepia() invert() opacity()
 * grayscale() drop-shadow() url(#…) — so this one op covers dozens of effects with ZERO per-effect
 * code. The named effects above are just ergonomic, validated, animatable sugar over the same thing.
 * Deterministic: a static CSS string applied on the CPU raster.
 */
const raw = defineEffect(
  z.object({ css: z.string().min(1) }).strip(),
  (p) => ({ cssFilter: p.css }),
);

/** The kind→impl table this plugin contributes (keys MUST match Scene-IR `effects[].kind`). */
export const CORE_EFFECTS: Readonly<Record<string, EffectImpl>> = {
  raw, // declarative CSS-filter passthrough — any web filter, no per-effect code
  blur,
  glow,
  drop_shadow,
  color_grade,
  turbulence,
  displace,
  vignette,
  grain,
  motion_blur,
};

/** The core-effects plugin: registers every built-in effect under its Scene-IR `kind`. */
export const coreEffectsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    for (const [kind, impl] of Object.entries(CORE_EFFECTS)) {
      api.registerEffect(kind, impl);
    }
  },
};

export default coreEffectsPlugin;
