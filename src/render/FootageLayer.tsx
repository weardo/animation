// <FootageLayer> — the compositor's renderer for a Scene-IR `footage` layer (M2 compositing): plays
// time-based EXTERNAL media — a VIDEO file or a LOTTIE animation — FRAME-SEEKED by Remotion so the
// output is deterministic (CLAUDE.md r.1: a pure function of `useCurrentFrame()`, no wall clock).
//
// "Reuse over invent" (CLAUDE.md r.3): this is a THIN ADAPTER over the Remotion ecosystem — the
// genuinely-hard work (decode + exact frame seek + caching) is Remotion's, NEVER reimplemented:
//   • VIDEO  → `<OffthreadVideo>` (Remotion's deterministic, frame-exact, off-thread video for
//              rendering — it seeks the decoder to the current composition frame).
//   • LOTTIE → `@remotion/lottie`'s `<Lottie>`, fed the parsed animation JSON; Remotion advances it
//              by the frame clock. The JSON is fetched once via `delayRender`/`continueRender` +
//              `staticFile` (the same offline, deterministic pattern the text font uses — no CDN).
//
// The media kind is read from the resolved `defs.assets[ref].kind` (`video` / `lottie`); the layer's
// own `{a,k}` transform + camera/parallax + the generic blend/matte/effects wrappers (LayerView)
// compose it like every other layer. `from` offsets the source start; `playbackRate` retimes it;
// `loop` repeats it — all still pure functions of the frame, so re-render is byte-identical.

import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill,
  Loop,
  OffthreadVideo,
  Sequence,
  cancelRender,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { Lottie, type LottieAnimationData } from '@remotion/lottie';
import type { AssetDef, Easings, FootageLayer as FootageLayerIR } from '../ir/index.js';
import { evalNumber, evalVec2 } from './eval.js';

export interface FootageLayerProps {
  /** The Scene-IR footage layer ({ ref, from?, playbackRate?, loop?, fit?, transform? }). */
  layer: FootageLayerIR;
  /** The resolved asset definition (`defs.assets[layer.ref]`) — its `kind` selects the renderer. */
  assetDef: AssetDef;
  /** Scene `defs.easings` so the transform keyframes resolve their easing names (never linear). */
  easings?: Easings | undefined;
}

/** Resolve an `asset://…` (or bare) URI to a Remotion `staticFile` URL under `public/`. */
function resolveAssetUrl(uri: string): string {
  const path = uri.includes('://') ? uri.slice(uri.indexOf('://') + 3) : uri;
  return staticFile(path);
}

/**
 * Lottie source: fetch the animation JSON once (deterministic, offline) and feed it to `<Lottie>`,
 * gating the frame with `delayRender`/`continueRender` so the renderer waits for the data. Remotion
 * advances the animation by the composition frame clock; `loop`/`playbackRate` are pure props.
 *
 * DETERMINISM (CLAUDE.md r.1 — the M2 fix). Remotion renders a video by opening MULTIPLE BROWSER TABS
 * IN PARALLEL that DO NOT SHARE STATE (per the upstream "flickering" docs), and `@remotion/lottie`
 * drives lottie-web with `.goToAndStop()` — which is NOT a pure function of `useCurrentFrame()` when one
 * player is advanced INCREMENTALLY: its SVG transforms accumulate floating-point state, so a frame's
 * pixels depend on which frames the tab rendered before it. Across cold runs the tabs split the timeline
 * differently, so the Lottie pixels flap (the observed non-byte-identical video). lottie-web also does
 * NOT support `setSubframe()` under Remotion (upstream), so that lever is unavailable.
 *
 * The fix makes the Lottie a TRUE pure function of the frame: mount a FRESH `<Lottie>` player EVERY
 * composition frame (`key={frame}`), so each frame is an independent seek-from-zero with no carried
 * state — identical no matter which tab/order rendered it, and identical to the (already byte-stable)
 * still path. Remotion's own multi-threading guidance is exactly this: make the animation depend only
 * on the current frame. Re-mounting is cheap (the JSON is tiny + cached). The async load is gated by
 * `delayRender`/`continueRender` so the renderer waits for the fresh player before capturing the frame.
 */
const LottieFootage: React.FC<{
  url: string;
  loop: boolean;
  playbackRate: number;
}> = ({ url, loop, playbackRate }) => {
  const [data, setData] = useState<LottieAnimationData | null>(null);
  const [handle] = useState(() => delayRender(`Loading Lottie footage: ${url}`));
  const frame = useCurrentFrame();

  useEffect(() => {
    let cancelled = false;
    fetch(url)
      .then((res) => res.json())
      .then((json: LottieAnimationData) => {
        if (cancelled) return;
        setData(json);
        continueRender(handle);
      })
      .catch((err) => cancelRender(err));
    return () => {
      cancelled = true;
    };
  }, [url, handle]);

  if (!data) return null;
  return (
    // `key={frame}` forces a FRESH lottie-web player every frame → a pure function of `frame` (no
    // carried state), so the parallel-tab video path is byte-identical to the deterministic still path.
    <Lottie
      key={frame}
      animationData={data}
      loop={loop}
      playbackRate={playbackRate}
      renderer="svg"
      style={{ width: '100%', height: '100%' }}
    />
  );
};

/**
 * Render one Scene-IR footage layer: its (animated) transform wrapping the frame-seeked media. The
 * media kind comes from the resolved asset def — `video` → `<OffthreadVideo>`, `lottie` → `<Lottie>`.
 * `from` offsets which source frame plays (via a `<Sequence from={-from}>` time-shift); `loop` wraps
 * the media in Remotion's `<Loop>`. Parallax is folded by the parent LayerView wrapper.
 */
export const FootageLayer: React.FC<FootageLayerProps> = ({ layer, assetDef, easings }) => {
  const frame = useCurrentFrame();
  const { width, height, durationInFrames } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  // The layer's own `{a,k}` transform at this frame (optional → identity defaults). Default position
  // is the composition centre; with no authored position the media fills the frame.
  const t = layer.transform;
  const [tx, ty] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const hasPosition = t?.position !== undefined;
  const translateX = hasPosition ? tx - width / 2 : 0;
  const translateY = hasPosition ? ty - height / 2 : 0;

  const wrapperStyle: React.CSSProperties = {
    opacity: opacityPct / 100,
    transform: [
      `translate(${translateX}px, ${translateY}px)`,
      `rotate(${rotationDeg}deg)`,
      `scale(${scalePct / 100})`,
    ].join(' '),
    transformOrigin: 'center center',
  };

  const url = resolveAssetUrl(assetDef.uri);
  const from = layer.from ?? 0;
  const playbackRate = layer.playbackRate ?? 1;
  const loop = layer.loop ?? false;
  const fit = layer.fit ?? 'contain';

  let media: React.ReactNode;
  if (assetDef.kind === 'video') {
    const video = (
      <OffthreadVideo
        src={url}
        playbackRate={playbackRate}
        style={{ width: '100%', height: '100%', objectFit: fit, display: 'block' }}
      />
    );
    media = loop ? <Loop durationInFrames={durationInFrames}>{video}</Loop> : video;
  } else if (assetDef.kind === 'lottie') {
    media = <LottieFootage url={url} loop={loop} playbackRate={playbackRate} />;
  } else {
    throw new Error(
      `Scene IR: footage layer "${layer.id}" references asset "${layer.ref}" of kind ` +
        `"${assetDef.kind}" — a footage layer needs a "video" or "lottie" asset.`,
    );
  }

  // `from` offsets which SOURCE frame plays: a `<Sequence from={-from}>` shifts the local clock so the
  // media starts `from` frames in. (Sequence is Remotion's time-shift primitive — never reimplemented.)
  const timed = from !== 0 ? <Sequence from={-from} layout="none">{media}</Sequence> : media;

  return (
    <AbsoluteFill data-footage-layer={layer.id} style={wrapperStyle}>
      {timed}
    </AbsoluteFill>
  );
};

export default FootageLayer;
