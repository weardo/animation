// <BrandOverlay> — the channel BRAND, composited over the finished film (spec 2026-07-09-india-storyboard).
// Two always-on, retention-safe mechanisms, both a pure function of (resolved-stylekit brand, frame):
//   • a persistent corner LOGO BUG on every frame (the #1 "instantly recognizable" lever), and
//   • a branded END-CARD over the last `endcard.seconds` (logo + handle + tagline, dimmed footage behind
//     it so it STILL loops to the hook — not a hard CTA card).
// Values are all DATA from the stylekit's `brand` sub-table; core owns only this generic mechanism.
// Absent `brand` (any non-branded style) → renders nothing → byte-identical to an unbranded film.
import React from 'react';
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

import type { StyleKit } from '../ir/index.js';

type Brand = NonNullable<StyleKit['brand']>;

/** The persistent corner logo bug. Positioned + sized as a percent of frame width from the stylekit. */
const Bug: React.FC<{ bug: NonNullable<Brand['bug']>; width: number }> = ({ bug, width }) => {
  const w = (width * bug.widthPct) / 100;
  const m = (width * bug.marginPct) / 100;
  const pos: React.CSSProperties = {};
  if (bug.corner.startsWith('top')) pos.top = m;
  else pos.bottom = m;
  if (bug.corner.endsWith('left')) pos.left = m;
  else pos.right = m;
  return (
    <Img
      src={staticFile(bug.asset)}
      style={{
        position: 'absolute',
        width: w,
        height: 'auto',
        opacity: bug.opacity,
        filter: 'drop-shadow(0 2px 7px rgba(0,0,0,0.55))',
        ...pos,
      }}
    />
  );
};

/** The branded end-card over the LAST `seconds`: dimmed footage + big logo + handle + tagline; fades in. */
const EndCard: React.FC<{ brand: Brand; ec: NonNullable<Brand['endcard']> }> = ({ brand, ec }) => {
  const frame = useCurrentFrame();
  const { width, durationInFrames, fps } = useVideoConfig();
  const ecFrames = Math.round(ec.seconds * fps);
  const start = durationInFrames - ecFrames;
  if (frame < start) return null;
  const fade = interpolate(frame, [start, start + Math.min(10, ecFrames)], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill
      style={{
        opacity: fade,
        backgroundColor: 'rgba(6,9,16,0.64)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: width * 0.02,
      }}
    >
      <Img
        src={staticFile(ec.logo)}
        style={{ width: width * 0.46, height: 'auto', filter: 'drop-shadow(0 6px 20px rgba(0,0,0,0.6))' }}
      />
      {brand.handle && (
        <div style={{ fontFamily: 'Mukta, "Segoe UI", sans-serif', fontWeight: 800, color: '#E6B24A', fontSize: width * 0.045 }}>
          {brand.handle}
        </div>
      )}
      {brand.tagline && (
        <div style={{ fontFamily: 'Mukta, "Segoe UI", sans-serif', color: '#c9d3e4', fontSize: width * 0.03 }}>
          {brand.tagline}
        </div>
      )}
    </AbsoluteFill>
  );
};

/** The brand layer. A no-op unless the resolved stylekit carries a `brand` block. */
export const BrandOverlay: React.FC<{ brand?: Brand | undefined }> = ({ brand }) => {
  const { width } = useVideoConfig();
  if (!brand) return null;
  return (
    <>
      {brand.bug && <Bug bug={brand.bug} width={width} />}
      {brand.endcard?.enabled && <EndCard brand={brand} ec={brand.endcard} />}
    </>
  );
};

export default BrandOverlay;
