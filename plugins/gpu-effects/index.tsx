// gpu-effects — the Tier-B GPU effects + transition, shipped AS A PLUGIN (ADR-005 "families are
// sockets; plugins are plugs"). It contributes WebGL/Pixi-backed look ops into the engine's generic
// `effects` and `transitions` extension points. These are the ONE non-byte-exact tier (M6): they run
// on a GL backend (gl:"angle", the Iris Xe iGPU) and are verified PERCEPTUALLY (VMAF/SSIM), never `cmp`.
//
// GATING (CLAUDE.md r.1 — the CPU raster default stays byte-identical):
//   • LOAD gate: this plugin is appended to the enabled list ONLY when the bundle was built for the GPU
//     tier (`render.ts --gpu` → a webpack DefinePlugin sets `process.env.GPU_TIER`; render-entry reads
//     it). On the CPU tier the plugin is never registered → none of this code runs → byte-identical.
//   • RUNTIME self-gate: every contribution funnels through PixiHost.gpuActive() (pixi-host.tsx), which
//     also requires a REAL hardware WebGL context (software-WebGL fallback rejected). Belt-and-braces.
//
// "Reuse over invent" (CLAUDE.md r.3): we do NOT write shaders by hand — we adopt the maintained
// `pixi-filters` GPU catalog (CRT / AdvancedBloom / Shockwave / Godray / Glitch) running on `pixi.js`
// v8's WebGL renderer, exactly as core-effects adopts SVG filters and core-transitions adopts
// @remotion/transitions. The engine owns ONLY the generic registries + the EffectImpl/TransitionImpl
// contracts — every concrete GPU op lives HERE.
//
// COMPOSITION: each GPU effect contributes a `wrap(node)` — it renders the layer subtree, then overlays
// a Pixi WebGL <canvas> (PixiHost) carrying the GPU-shaded content with a CSS blend mode. So a GPU effect
// composes on top of the same §11.1 shading + parallax + Tier-A effects[] stack as any other effect.
//
// DETERMINISM (honest, M6): each draw is a PURE function of `frame` (no clock/RNG); the GPU itself is
// the only non-determinism, which the perceptual tier accepts. See pixi-host.tsx.

import React from 'react';
import { z } from 'zod';
import { Container, Graphics, Sprite, Texture, Color } from 'pixi.js';
import { AdvancedBloomFilter, CRTFilter, ShockwaveFilter, GodrayFilter, GlitchFilter } from 'pixi-filters';
import type {
  EngineAPI,
  Plugin,
  EffectImpl,
  EffectContribution,
  TransitionImpl,
  TransitionBuildContext,
} from '../../src/engine/index.js';
import { parseManifest } from '../../src/engine/index.js';
import { PixiHost, type PixiDraw } from './pixi-host.js';
import { glDissolvePresentation } from './gl-transition.js';
import manifestJson from './plugin.json' with { type: 'json' };

const manifest = parseManifest(manifestJson);

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** A monotonically-rising id so concurrent GPU overlays get distinct delayRender labels. Pure-ish: it
 * only affects the React key / delayRender label, never a pixel — so it does not break determinism. */
let hostSeq = 0;

/** Build a typed EffectImpl from a Zod schema + a (params, frame) → {draw, blend, opacity} GPU spec. */
function defineGpuEffect<S extends z.ZodTypeAny>(
  schema: S,
  build: (
    params: z.infer<S>,
    frame: number,
  ) => { draw: PixiDraw; blend?: React.CSSProperties['mixBlendMode']; opacity?: number },
): EffectImpl {
  return {
    parse: (params) => schema.parse(params),
    build: (params, frame): EffectContribution => {
      const spec = build(params as z.infer<S>, frame);
      const id = `gfx-${hostSeq++}`;
      return {
        // wrap the subtree: render children, then overlay the GPU-shaded Pixi canvas on top.
        wrap: (node) =>
          React.createElement(
            React.Fragment,
            null,
            node,
            React.createElement(GpuOverlay, { key: id, id, ...spec }),
          ),
      };
    },
  };
}

/** A self-sizing GPU overlay: reads the composition size and mounts a PixiHost with the effect's draw. */
const GpuOverlay: React.FC<{
  draw: PixiDraw;
  blend?: React.CSSProperties['mixBlendMode'];
  opacity?: number;
  id: string;
}> = (props) => {
  // The layer wrapper is absolutely-filled to the composition box; sample that via the video config.
  const cfg = useComposition();
  return React.createElement(PixiHost, {
    draw: props.draw,
    width: cfg.width,
    height: cfg.height,
    blend: props.blend,
    opacity: props.opacity,
    id: props.id,
  });
};

// Lazy import of Remotion's useVideoConfig (kept local so the helper file stays self-contained).
import { useVideoConfig } from 'remotion';
function useComposition(): { width: number; height: number } {
  const { width, height } = useVideoConfig();
  return { width, height };
}

/** Fill `stage` with a full-frame sprite carrying `color` so a filter has a surface to shade. */
function fullFrameSprite(stage: Container, app: { renderer: { width: number; height: number } }, tint: number, alpha: number): Sprite {
  const sp = new Sprite(Texture.WHITE);
  sp.width = app.renderer.width;
  sp.height = app.renderer.height;
  sp.tint = tint;
  sp.alpha = alpha;
  stage.addChild(sp);
  return sp;
}

function hexNum(hex: string): number {
  return new Color(hex).toNumber();
}

// ---------------------------------------------------------------------------------------------------
// GPU effects — each draws procedural GL content + a pixi-filters GPU shader, overlaid with a blend mode.
// ---------------------------------------------------------------------------------------------------

/**
 * gpu_bloom — a soft additive BLOOM glow (AdvancedBloomFilter, a multi-pass GPU bloom that is expensive
 * on the CPU). Draws a bright radial blob (or a full-frame tint) and blooms it; overlaid with `screen`
 * so it lifts highlights without darkening. `threshold`/`bloomScale`/`blur` tune the GPU bloom.
 */
const gpu_bloom = defineGpuEffect(
  z
    .object({
      color: z.string().default('#ffd9a0'),
      threshold: z.number().min(0).max(1).default(0.3),
      bloomScale: z.number().nonnegative().default(1.4),
      blur: z.number().nonnegative().default(8),
      intensity: z.number().min(0).max(1).default(0.8),
    })
    .strip(),
  (p) => ({
    blend: 'screen',
    opacity: p.intensity,
    draw: (stage, _frame, app) => {
      const g = new Graphics();
      const cx = app.renderer.width / 2;
      const cy = app.renderer.height / 2;
      const r = Math.min(cx, cy) * 0.7;
      g.circle(cx, cy, r).fill({ color: hexNum(p.color), alpha: 1 });
      g.filters = [new AdvancedBloomFilter({ threshold: p.threshold, bloomScale: p.bloomScale, blur: p.blur, quality: 4 })];
      stage.addChild(g);
    },
  }),
);

/**
 * gpu_crt — a CRT screen look (CRTFilter): scanlines + barrel curvature + vignette + animated noise,
 * all in one GPU shader. Overlaid with `overlay` so it textures the layer beneath. `time` is driven by
 * `frame` (pure) so the noise/scanline phase advances deterministically-per-frame.
 */
const gpu_crt = defineGpuEffect(
  z
    .object({
      lineWidth: z.number().positive().default(3),
      lineContrast: z.number().min(0).max(1).default(0.3),
      noise: z.number().min(0).max(1).default(0.2),
      curvature: z.number().nonnegative().default(1),
      vignetting: z.number().min(0).max(1).default(0.3),
      opacity: z.number().min(0).max(1).default(0.85),
    })
    .strip(),
  (p, frame) => ({
    blend: 'overlay',
    opacity: p.opacity,
    draw: (stage, f, app) => {
      const sp = fullFrameSprite(stage, app, 0x808080, 1);
      sp.filters = [
        new CRTFilter({
          lineWidth: p.lineWidth,
          lineContrast: p.lineContrast,
          noise: p.noise,
          curvature: p.curvature,
          vignetting: p.vignetting,
          time: f, // pure fn of frame
          seed: 0,
        }),
      ];
      void frame;
    },
  }),
);

/**
 * gpu_shockwave — an expanding radial SHOCKWAVE ripple (ShockwaveFilter): a GPU distortion ring that
 * sweeps out from a center, parameterised by `frame`. Overlaid with `screen`. `speed` controls how fast
 * the ring travels (radius = speed·frame/fps-ish), `amplitude`/`wavelength` its shape.
 */
const gpu_shockwave = defineGpuEffect(
  z
    .object({
      cx: z.number().min(0).max(1).default(0.5),
      cy: z.number().min(0).max(1).default(0.5),
      speed: z.number().positive().default(8),
      amplitude: z.number().nonnegative().default(30),
      wavelength: z.number().positive().default(160),
      color: z.string().default('#9fd0ff'),
      period: z.number().int().positive().default(60),
      opacity: z.number().min(0).max(1).default(0.7),
    })
    .strip(),
  (p, frame) => ({
    blend: 'screen',
    opacity: p.opacity,
    draw: (stage, f, app) => {
      const w = app.renderer.width;
      const h = app.renderer.height;
      // a faint ring texture to distort, so the shockwave reads
      const g = new Graphics();
      g.rect(0, 0, w, h).fill({ color: hexNum(p.color), alpha: 0.18 });
      // the shockwave `time` loops over `period` frames → a repeating pulse (pure fn of frame).
      const t = (f % p.period) / p.period;
      g.filters = [
        new ShockwaveFilter({
          center: { x: p.cx * w, y: p.cy * h },
          amplitude: p.amplitude,
          wavelength: p.wavelength,
          speed: p.speed,
          radius: -1,
          time: t * 2,
        }),
      ];
      stage.addChild(g);
    },
  }),
);

/**
 * gpu_godrays — volumetric light shafts (GodrayFilter): GPU-raymarched god rays radiating from a point,
 * with animated `time`. Overlaid with `screen` for additive light. `angle`/`gain`/`lacunarity` shape the
 * rays; `time` advances with `frame` (pure). Needs `document` → runs in Chromium (the render target).
 */
const gpu_godrays = defineGpuEffect(
  z
    .object({
      angle: z.number().default(30),
      gain: z.number().min(0).max(1).default(0.5),
      lacunarity: z.number().positive().default(2.5),
      color: z.string().default('#fff1c0'),
      speed: z.number().default(0.01),
      opacity: z.number().min(0).max(1).default(0.6),
    })
    .strip(),
  (p, frame) => ({
    blend: 'screen',
    opacity: p.opacity,
    draw: (stage, f, app) => {
      const sp = fullFrameSprite(stage, app, hexNum(p.color), 0.5);
      sp.filters = [
        new GodrayFilter({
          angle: p.angle,
          gain: p.gain,
          lacunarity: p.lacunarity,
          time: f * p.speed, // pure fn of frame
        }),
      ];
      void frame;
    },
  }),
);

/**
 * gpu_glitch — a digital GLITCH: RGB channel split + sliced offset bands (GlitchFilter). Overlaid with
 * `screen`. `slices`/`offset`/`red`/`green`/`blue` shape the displacement; the GPU shader resolves it.
 * Needs `document` → runs in Chromium. Deterministic structure (no per-frame RNG: fixed `seed`).
 */
const gpu_glitch = defineGpuEffect(
  z
    .object({
      slices: z.number().int().min(1).max(30).default(8),
      offset: z.number().default(60),
      direction: z.number().default(0),
      color: z.string().default('#ffffff'),
      opacity: z.number().min(0).max(1).default(0.6),
    })
    .strip(),
  (p) => ({
    blend: 'screen',
    opacity: p.opacity,
    draw: (stage, _f, app) => {
      const sp = fullFrameSprite(stage, app, hexNum(p.color), 0.4);
      sp.filters = [
        new GlitchFilter({
          slices: p.slices,
          offset: p.offset,
          direction: p.direction,
          fillMode: 0,
          seed: 0,
          red: { x: 8, y: 4 },
          green: { x: -6, y: 2 },
          blue: { x: 4, y: -6 },
        }),
      ];
      void Sprite;
    },
  }),
);

// ---------------------------------------------------------------------------------------------------
// GPU transition — a shader DISSOLVE (gl-transition style) that GPU-blends the two scenes.
// ---------------------------------------------------------------------------------------------------

/**
 * gl-dissolve — a GPU noise-DISSOLVE scene transition. Built as a @remotion/transitions presentation
 * (gl-transition.tsx) whose component shades the boundary on a WebGL canvas. On the CPU/byte-exact tier
 * (plugin not loaded) the IR `kind` falls back to the core-transitions fade; here it upgrades to the GL
 * dissolve when the GPU tier is active (the presentation self-gates via gpuActive()).
 */
const glDissolveImpl: TransitionImpl = {
  build: ({ width, height, transition }: TransitionBuildContext) =>
    glDissolvePresentation({
      width,
      height,
      // optional passthrough params (scale of the dissolve noise) — read loosely off the IR transition
      scale: typeof (transition as Record<string, unknown>).scale === 'number'
        ? ((transition as Record<string, unknown>).scale as number)
        : 12,
    }) as never,
};

// ---------------------------------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------------------------------

/** The GPU effect kind→impl table. Keys are `gpu_*` so they never collide with Tier-A core-effects. */
export const GPU_EFFECTS: Readonly<Record<string, EffectImpl>> = {
  gpu_bloom,
  gpu_crt,
  gpu_shockwave,
  gpu_godrays,
  gpu_glitch,
};

/** The GPU transition kind→impl table (registered under a `gl-` prefixed kind). */
export const GPU_TRANSITIONS: Readonly<Record<string, TransitionImpl>> = {
  'gl-dissolve': glDissolveImpl,
};

/** The gpu-effects plugin: registers every GPU effect + transition under its Scene-IR kind. */
export const gpuEffectsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    for (const [kind, impl] of Object.entries(GPU_EFFECTS)) api.registerEffect(kind, impl);
    for (const [kind, impl] of Object.entries(GPU_TRANSITIONS)) api.registerTransition(kind, impl);
  },
};

export default gpuEffectsPlugin;
