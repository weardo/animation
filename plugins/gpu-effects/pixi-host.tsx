// gpu-effects — the Pixi WebGL HOST (the Tier-B GL runner). A reusable React component that mounts a
// headless Pixi v8 `Application` on a GPU WebGL context (gl:"angle", the Iris Xe iGPU), runs a PURE
// per-frame `draw(stage, frame, app)` callback, renders ONE frame synchronously, and overlays the
// resulting <canvas> over the layer subtree with a CSS blend mode. This is the ONE place that touches
// WebGL/Pixi — every GPU effect (effects.tsx) is just a `draw` callback + blend + params.
//
// TIER GATE (CLAUDE.md r.1 — the CPU raster default MUST stay byte-identical): a GPU effect is ONLY
// active on the perceptual GPU tier. Two independent gates:
//   1. LOAD gate (primary): the gpu-effects plugin is appended to the enabled list ONLY when the bundle
//      was built with `process.env.GPU_TIER` (set by `render.ts --gpu` via a webpack DefinePlugin). On
//      the CPU tier the plugin is never registered, so NONE of this code is in the CPU render path.
//   2. RUNTIME self-gate (belt-and-braces): even if mounted, the host renders NOTHING unless a real
//      hardware WebGL2 context is obtainable. Software-WebGL fallback (the deprecated swiftshader path
//      Chromium uses with no `gl` backend) is REJECTED — so a GPU effect can never silently leak onto
//      the byte-exact tier and perturb its pixels.
//
// DETERMINISM CAVEAT (honest, per M6): this is the PROJECT'S ONLY non-byte-exact tier. GPU shader output
// (texture sampling order/precision on the iGPU) is verified PERCEPTUALLY (VMAF/SSIM), NOT with `cmp`.
// The `draw` callback is still a PURE function of `frame` (no clock / Math.random / Date.now) — the only
// non-determinism is the GPU itself, which is exactly what the perceptual tier accepts. continueRender
// is deferred until the GL flush + a rAF settle so the captured frame is the fully-drawn one.

import React from 'react';
import { AbsoluteFill, continueRender, delayRender, useCurrentFrame } from 'remotion';
import { Application, type Container } from 'pixi.js';

/** A pure per-frame GL scene builder: populate `stage` for `frame`. No clock, no RNG (CLAUDE.md r.1). */
export type PixiDraw = (stage: Container, frame: number, app: Application) => void;

/**
 * True only when a REAL hardware WebGL context is available — i.e. the GPU tier (gl:"angle"). We probe a
 * throwaway canvas and require a context whose UNMASKED renderer is NOT the software rasterizer
 * (SwiftShader / "Software"): Chromium with NO `gl` backend silently falls back to software WebGL, and
 * we must NOT let a GPU effect render there (it would perturb the byte-exact CPU tier). Cached per module.
 */
let HW_WEBGL: boolean | null = null;
function hasHardwareWebGL(): boolean {
  if (HW_WEBGL !== null) return HW_WEBGL;
  try {
    if (typeof document === 'undefined') return (HW_WEBGL = false);
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') ?? c.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return (HW_WEBGL = false);
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
    // SwiftShader / "Software" / "llvmpipe" = the software fallback → treat as NO hardware GL.
    HW_WEBGL = !/swiftshader|software|llvmpipe/i.test(renderer);
  } catch {
    HW_WEBGL = false;
  }
  return HW_WEBGL;
}

/** Build-time tier flag (webpack DefinePlugin replaces `process.env.GPU_TIER` in the bundle). */
function gpuTierEnabled(): boolean {
  try {
    return typeof process !== 'undefined' && process.env != null && !!process.env.GPU_TIER;
  } catch {
    return false;
  }
}

/** True when GPU effects may render: built for the GPU tier AND a hardware GL context is present. */
export function gpuActive(): boolean {
  return gpuTierEnabled() && hasHardwareWebGL();
}

export interface PixiHostProps {
  /** Pure per-frame GL scene builder. Re-invoked each frame on a freshly-cleared stage. */
  draw: PixiDraw;
  /** Composition px (the GL canvas matches the frame so the overlay aligns 1:1). */
  width: number;
  height: number;
  /** CSS mix-blend-mode for the overlay over the layer subtree (e.g. "screen" for additive glow). */
  blend?: React.CSSProperties['mixBlendMode'];
  /** Overlay opacity (0..1). */
  opacity?: number;
  /** A stable id so concurrent hosts get distinct delayRender labels. */
  id: string;
}

/**
 * Mount a Pixi WebGL Application, draw one frame for `useCurrentFrame()`, and overlay its canvas. Renders
 * an empty fragment (no overlay, no GL) whenever {@link gpuActive} is false — so on the CPU/byte-exact
 * tier this is a strict no-op and the layer subtree is untouched.
 */
export const PixiHost: React.FC<PixiHostProps> = ({ draw, width, height, blend, opacity = 1, id }) => {
  const frame = useCurrentFrame();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const active = gpuActive();
  const [handle] = React.useState(() => (active ? delayRender(`gpu-${id}`) : null));

  React.useEffect(() => {
    if (!active || handle === null) return;
    let app: Application | null = null;
    let cancelled = false;
    (async () => {
      try {
        app = new Application();
        await app.init({
          width,
          height,
          backgroundAlpha: 0,
          antialias: true,
          preference: 'webgl', // gl:"angle" gives a real WebGL context (verified on the Iris Xe)
          autoStart: false, // we drive a single synchronous render — no ticker (no clock, deterministic)
          powerPreference: 'high-performance',
        });
        if (cancelled) {
          app.destroy(true, { children: true });
          return;
        }
        draw(app.stage, frame, app);
        app.renderer.render(app.stage);
        const canvas = app.canvas as HTMLCanvasElement;
        canvas.style.width = '100%';
        canvas.style.height = '100%';
        hostRef.current?.replaceChildren(canvas);
        // Defer capture until the GL pipeline has flushed (double-rAF settle) so the still is complete.
        requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
      } catch {
        continueRender(handle); // never hang the render on a GL failure — degrade to no overlay
      }
    })();
    return () => {
      cancelled = true;
      app?.destroy(true, { children: true });
    };
  }, [active, handle, draw, frame, width, height]);

  if (!active) return null;
  return (
    <AbsoluteFill
      ref={hostRef}
      style={{ mixBlendMode: blend, opacity, pointerEvents: 'none' }}
      data-gpu-overlay={id}
    />
  );
};
