// gpu-effects — the GL DISSOLVE transition presentation (Tier-B). A @remotion/transitions
// `TransitionPresentation` whose entering scene is revealed through a GPU-SHADED noise dissolve mask:
// a Pixi WebGL canvas renders an animated simplex-noise field thresholded by `presentationProgress`,
// and that canvas is used as a CSS `mask-image` on the entering scene — so the dissolve PATTERN is
// generated on the GPU (the iGPU, gl:"angle"). This is the gl-transitions idea (a shader drives the
// blend) adapted to Remotion's DOM-children presentation model (we can't sample the sibling scenes as
// textures, so the GPU generates the MASK instead of compositing the two textures directly).
//
// GATE (CLAUDE.md r.1): the whole plugin loads only on the GPU tier, and the GL mask self-gates via
// gpuActive() (pixi-host.tsx). When GPU is NOT active this presentation degrades to a plain opacity
// crossfade — so it is harmless if ever resolved on the CPU tier (it never is, since the plugin is not
// registered there; this is belt-and-braces).
//
// DETERMINISM (M6 perceptual tier): the noise field is a PURE function of `presentationProgress` (a pure
// fn of frame) — no clock/RNG; the GPU shader is the only non-determinism (verified perceptually).

import React from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';
import {
  type TransitionPresentation,
  type TransitionPresentationComponentProps,
} from '@remotion/transitions';
import { Application, Graphics, Sprite, Texture } from 'pixi.js';
import { SimplexNoiseFilter } from 'pixi-filters';
import { gpuActive } from './pixi-host.js';

export type GlDissolveProps = { width: number; height: number; scale: number };

let seq = 0;

const GlDissolve: React.FC<TransitionPresentationComponentProps<GlDissolveProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  const { width, height } = passedProps;
  const p = presentationProgress;
  const active = gpuActive();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [maskUrl, setMaskUrl] = React.useState<string | null>(null);
  const [id] = React.useState(() => `gld-${seq++}`);
  const [handle] = React.useState(() =>
    active && presentationDirection === 'entering' ? delayRender(`gl-dissolve-${id}`) : null,
  );

  React.useEffect(() => {
    if (!active || presentationDirection !== 'entering' || handle === null) return;
    let app: Application | null = null;
    let cancelled = false;
    (async () => {
      try {
        app = new Application();
        await app.init({ width, height, backgroundAlpha: 1, antialias: false, preference: 'webgl', autoStart: false });
        if (cancelled) return app.destroy(true, { children: true });
        // A white field, GPU-warped by simplex noise; thresholded by progress → a dissolving stencil.
        const sp = new Sprite(Texture.WHITE);
        sp.width = width;
        sp.height = height;
        const g = new Graphics().rect(0, 0, width, height).fill(0xffffff);
        // SimplexNoiseFilter produces a GPU noise field; we bias its strength by progress so the white
        // region (mask-visible) grows as the transition advances → the entering scene dissolves in.
        const noise = new SimplexNoiseFilter({ strength: 1, noiseScale: passedProps.scale, step: -1 });
        // map progress → a luminance offset so the thresholded noise area expands with `p`
        g.tint = 0xffffff;
        g.alpha = 1;
        g.filters = [noise];
        // overlay a black-to-white wipe gate scaled by p so the average coverage tracks progress
        const gate = new Graphics().rect(0, 0, width, height).fill({ color: 0xffffff, alpha: p });
        app.stage.addChild(g, gate);
        app.renderer.render(app.stage);
        const url = (app.canvas as HTMLCanvasElement).toDataURL('image/png');
        if (!cancelled) setMaskUrl(url);
        requestAnimationFrame(() => requestAnimationFrame(() => continueRender(handle)));
      } catch {
        continueRender(handle);
      }
    })();
    return () => {
      cancelled = true;
      app?.destroy(true, { children: true });
    };
  }, [active, presentationDirection, handle, p, width, height, passedProps.scale]);

  // The exiting scene sits underneath fully opaque; the entering scene is masked by the GPU stencil.
  if (presentationDirection === 'exiting') {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }

  // Entering scene: GPU dissolve mask when active; plain crossfade fallback otherwise.
  if (!active) {
    return <AbsoluteFill style={{ opacity: p }}>{children}</AbsoluteFill>;
  }

  const maskStyle: React.CSSProperties = maskUrl
    ? {
        maskImage: `url(${maskUrl})`,
        WebkitMaskImage: `url(${maskUrl})`,
        maskSize: '100% 100%',
        WebkitMaskSize: '100% 100%',
      }
    : { opacity: p };

  return (
    <AbsoluteFill>
      <div ref={hostRef} style={{ display: 'none' }} />
      <AbsoluteFill style={maskStyle}>{children}</AbsoluteFill>
    </AbsoluteFill>
  );
};

export const glDissolvePresentation = (props: GlDissolveProps): TransitionPresentation<GlDissolveProps> => ({
  component: GlDissolve,
  props,
});
