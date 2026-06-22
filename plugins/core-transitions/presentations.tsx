// core-transitions — the CUSTOM scene-boundary presentations (the kinds @remotion/transitions has no
// preset for): `mask` (soft SVG radial reveal), `morph-match`/`match-cut` (flubber shared-element
// bridge), `camera-continuous` (one unbroken camera push). Each is a `@remotion/transitions`
// `TransitionPresentation` = a {component, props} pair; the component is a PURE function of
// `presentationProgress` (a pure fn of frame, timed by the compositor's linearTiming + StyleKit
// easing) — no Date.now / Math.random / clock read (CLAUDE.md r.1). SVG masks + flubber are frame-
// deterministic on the CPU raster default. The DOM presets (fade/wipe/slide/iris) are NOT here — they
// reuse @remotion/transitions directly (never reimplemented; ADR-003), wired in index.ts.

import React from 'react';
import { AbsoluteFill } from 'remotion';
import {
  type TransitionPresentation,
  type TransitionPresentationComponentProps,
} from '@remotion/transitions';
import type { Transition } from '../../src/ir/index.js';

// ---------------------------------------------------------------------------------------------------
// flubber (path morphing) — the same defensive namespace-probe ShapeLayer.tsx uses: flubber's UMD
// build exposes `interpolate` either as a namespace member (webpack) or on the default object (Node
// CJS interop). Probe both so this works under the Remotion webpack bundle AND tsx/Node. Cast through
// unknown (no ambient decl needed) — keeps the plugin self-contained.
// ---------------------------------------------------------------------------------------------------
import * as flubberNS from 'flubber';
type FlubberInterpolate = (
  from: string,
  to: string,
  opts?: { maxSegmentLength?: number },
) => (t: number) => string;
const flubberMod = flubberNS as unknown as {
  interpolate?: FlubberInterpolate;
  default?: { interpolate?: FlubberInterpolate };
};
const flubberInterpolate: FlubberInterpolate =
  flubberMod.interpolate ?? flubberMod.default?.interpolate!;

/** A deterministic id suffix so co-existing transitions never collide on SVG mask ids. */
let idCounter = 0;
const nextId = (): string => `xt${(idCounter = (idCounter + 1) % 1_000_000)}`;

// ---------------------------------------------------------------------------------------------------
// `mask` — a soft-edged SVG radial REVEAL of the entering scene.
//
// Unlike `iris` (a hard circular clip), this reveals through a feathered radial gradient mask so the
// boundary reads as a soft bloom-in rather than a crisp circle. The entering scene's alpha is driven by
// an SVG <mask> whose white radius (+ soft falloff) grows with `presentationProgress`; the exiting
// scene is shown unmasked underneath. Pure SVG (deterministic on CPU raster), no clock.
// ---------------------------------------------------------------------------------------------------
export type MaskProps = { width: number; height: number };

const MaskPresentation: React.FC<TransitionPresentationComponentProps<MaskProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  const { width, height } = passedProps;
  if (presentationDirection === 'exiting') {
    return <AbsoluteFill>{children}</AbsoluteFill>;
  }
  const maxR = Math.sqrt(width * width + height * height) / 2;
  const r = Math.max(0.0001, maxR * presentationProgress);
  const cx = width / 2;
  const cy = height / 2;
  const maskId = `mask-reveal-${nextId()}`;
  const gradId = `${maskId}-g`;
  return (
    <AbsoluteFill>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', width: 0, height: 0 }}
        aria-hidden
      >
        <defs>
          <radialGradient id={gradId} cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="white" />
            <stop offset="75%" stopColor="white" />
            <stop offset="100%" stopColor="black" />
          </radialGradient>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect x={0} y={0} width={width} height={height} fill="black" />
            <circle cx={cx} cy={cy} r={r} fill={`url(#${gradId})`} />
          </mask>
        </defs>
      </svg>
      <AbsoluteFill style={{ mask: `url(#${maskId})`, WebkitMask: `url(#${maskId})` }}>
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const maskPresentation = (props: MaskProps): TransitionPresentation<MaskProps> => ({
  component: MaskPresentation,
  props,
});

// ---------------------------------------------------------------------------------------------------
// `morph-match` / `match-cut` — a flubber-morphed SHARED ELEMENT that bridges the cut while the two
// scenes crossfade. The transition carries optional `from`/`to` path `d` strings (the shared element's
// silhouette in each scene); flubber interpolates between them across the boundary. Defaults to a
// circle→rounded-square morph so the transition is demo-able with no params.
//
// Read: scene A fades out as scene B fades in, and OVER the seam a single morphing shape (the matched
// element) deforms from its A-pose to its B-pose — the eye tracks the shape across the cut, selling the
// continuity. Pure (flubber is a deterministic geometric interpolator); morph `t` and the crossfade are
// both the eased presentation progress. No clock, no RNG.
// ---------------------------------------------------------------------------------------------------
export type MatchProps = {
  width: number;
  height: number;
  fromD: string;
  toD: string;
  tint: string;
};

const MatchPresentation: React.FC<TransitionPresentationComponentProps<MatchProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  const { width, height, fromD, toD, tint } = passedProps;
  const p = presentationProgress;
  const sceneOpacity = presentationDirection === 'exiting' ? 1 - p : p;
  const morphed = React.useMemo(() => {
    try {
      return flubberInterpolate(fromD, toD, { maxSegmentLength: 10 })(p);
    } catch {
      return toD;
    }
  }, [fromD, toD, p]);
  // The shared element peaks mid-transition (a quick in/out bell, 4·p·(1−p)) so it bridges the seam
  // without lingering. Drawn ONCE (on the entering pass) so it is not doubled.
  const elementOpacity = presentationDirection === 'entering' ? 4 * p * (1 - p) : 0;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: sceneOpacity }}>{children}</AbsoluteFill>
      {presentationDirection === 'entering' && elementOpacity > 0.001 ? (
        <AbsoluteFill style={{ pointerEvents: 'none' }}>
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            style={{ position: 'absolute', inset: 0 }}
            aria-hidden
          >
            {/* center the morph element in the frame; authored paths are assumed ~200u wide */}
            <g transform={`translate(${width / 2 - 100}, ${height / 2 - 100})`}>
              <path d={morphed} fill={tint} opacity={elementOpacity} />
            </g>
          </svg>
        </AbsoluteFill>
      ) : null}
    </AbsoluteFill>
  );
};

export const matchPresentation = (props: MatchProps): TransitionPresentation<MatchProps> => ({
  component: MatchPresentation,
  props,
});

// ---------------------------------------------------------------------------------------------------
// `camera-continuous` — a continuous CAMERA push across the cut. Both scenes share ONE uninterrupted
// translate+scale parameterised by `presentationProgress`, so the boundary reads as a single unbroken
// camera move rather than two clips. The exiting scene continues OUT in the push direction (dollying
// in) while the entering scene arrives FROM the opposite side, settling into place — a match-on-action
// camera continuity. `dir` chooses the push axis. Pure fn of progress.
// ---------------------------------------------------------------------------------------------------
export type CameraProps = {
  width: number;
  height: number;
  dir: NonNullable<Transition['dir']>;
};

const CameraPresentation: React.FC<TransitionPresentationComponentProps<CameraProps>> = ({
  children,
  presentationDirection,
  presentationProgress,
  passedProps,
}) => {
  const { width, height, dir } = passedProps;
  const p = presentationProgress;
  const ax = dir === 'left' ? -1 : dir === 'right' ? 1 : 0;
  const ay = dir === 'up' ? -1 : dir === 'down' ? 1 : 0;
  const spanX = width * ax;
  const spanY = height * ay;
  let tx: number;
  let ty: number;
  let scale: number;
  if (presentationDirection === 'exiting') {
    tx = -spanX * p;
    ty = -spanY * p;
    scale = 1 + 0.08 * p;
  } else {
    tx = spanX * (1 - p);
    ty = spanY * (1 - p);
    scale = 1.08 - 0.08 * p;
  }
  return (
    <AbsoluteFill
      style={{
        transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
        transformOrigin: 'center center',
      }}
    >
      {children}
    </AbsoluteFill>
  );
};

export const cameraPresentation = (props: CameraProps): TransitionPresentation<CameraProps> => ({
  component: CameraPresentation,
  props,
});
