// characterMarkup — the GENERALIZED procedural creature builder, OWNED by the blob-creature provider
// (ADR-006: moved out of core `src/factory/`). One function + a CharacterSpec → the SVG markup for a
// flat-vector Kurzgesagt creature, animated as a pure function of the frame.
//
// Returns an SVG markup STRING (a `<g>` centred on local origin) so it can drive BOTH:
//   • runtime (the provider injects it via dangerouslySetInnerHTML), and
//   • factory previews (wrapped in an <svg> and rasterised by rsvg-convert — no Remotion needed).
//
// DETERMINISM (CLAUDE.md r.1): pure function of (spec, frame, fps, clips). No Date.now/Math.random;
// blink is frame-modulo; motion is trig of frame/fps. Numbers are fixed-precision so the STRING is
// byte-stable across runs.

import type { RigClip } from '../../src/ir/index.js';
import type { CharacterSpec } from './spec.js';

const TAU = Math.PI * 2;
const f2 = (n: number): string => n.toFixed(2);

/** Active wave window (from rig_state.clips) → arm-raise angle in degrees (rest when inactive). */
export function waveAngle(frame: number, fps: number, clips: readonly RigClip[], rest: number, raise: number): number {
  const wave = clips.find((c) => c.anim === 'wave' && typeof c.at === 'number');
  if (!wave || wave.at === undefined) return rest;
  const start = wave.at;
  const later = clips.map((c) => c.at).filter((a): a is number => typeof a === 'number' && a > start);
  const end = later.length ? Math.min(...later) : start + 48;
  if (frame < start || frame >= end) return rest;
  const p = (frame - start) / (end - start);
  const up = Math.sin(Math.min(1, p * 1.5) * (Math.PI / 2));
  const waggle = p < 0.85 ? Math.sin((frame / fps) * TAU * 3) * 16 : 0;
  return rest - up * raise + waggle;
}

/**
 * Build the animated SVG markup for a character at a frame. Drawn centred on local origin (0,0).
 *
 * `liveness` (ADR-008 I3, default true) gates the always-alive idle: when false, the creature holds
 * a STATIC neutral pose (no bob/sway/breathe/blink) for a flat/technical look. An authored wave clip
 * (an explicit action, not ambient liveness) still plays so explicit motion is never suppressed.
 */
export function characterMarkup(
  spec: CharacterSpec,
  frame: number,
  fps: number,
  clips: readonly RigClip[],
  liveness = true,
): string {
  const t = frame / fps;
  const P = spec.palette;
  const m = spec.motion;
  const bob = liveness ? Math.sin(t * TAU * 0.45) * m.bob : 0;
  const sway = liveness ? Math.sin(t * TAU * 0.3) * m.swayDeg : 0;
  const breathe = liveness ? 1 + m.breathe * Math.sin((t * TAU) / 4) : 1;
  const bsx = 1 / Math.sqrt(breathe);
  const eyeSy = liveness && (frame % 132 < 5 || frame % 312 < 5) ? 0.12 : 1;
  const armR = waveAngle(frame, fps, clips, spec.arms.rest, m.waveRaise);
  const armL = -spec.arms.rest - 2;

  const sx = spec.body.rx * 0.83; // shoulder x
  const aw = spec.arms.width;
  const al = spec.arms.length;
  const ay = spec.arms.shoulderY;
  const arm = (side: 1 | -1, angle: number): string => {
    const px = side * sx;
    const rx = px - aw / 2;
    return (
      `<g transform="rotate(${f2(angle)} ${f2(px)} ${ay})">` +
      `<rect x="${f2(rx)}" y="${ay - 4}" width="${aw}" height="${al}" rx="${aw / 2}" fill="${P.bodyDark}" stroke="${P.ink}" stroke-width="3"/>` +
      `<circle cx="${f2(px)}" cy="${ay - 4 + al + 4}" r="${(aw * 0.6).toFixed(1)}" fill="${P.body}" stroke="${P.ink}" stroke-width="3"/>` +
      `</g>`
    );
  };

  const eye = (side: 1 | -1): string => {
    const ex = side * spec.eyes.spacing;
    return (
      `<g transform="translate(${f2(ex)} ${spec.eyes.cy}) scale(1 ${eyeSy})">` +
      `<circle r="${spec.eyes.r}" fill="${P.white}" stroke="${P.ink}" stroke-width="3"/>` +
      `<circle cx="2" cy="2" r="${spec.eyes.pupil}" fill="${P.ink}"/>` +
      `<circle cx="-2" cy="-3" r="${(spec.eyes.pupil * 0.4).toFixed(1)}" fill="${P.white}"/>` +
      `</g>`
    );
  };

  const legY = spec.body.cy + spec.body.ry - 18;
  const leg = (side: 1 | -1): string => {
    const lx = side * spec.legs.spacing - spec.legs.width / 2;
    return `<rect x="${f2(lx)}" y="${legY}" width="${spec.legs.width}" height="${spec.legs.height}" rx="${spec.legs.width / 2}" fill="${P.bodyDark}"/>`;
  };
  const foot = (side: 1 | -1): string =>
    `<ellipse cx="${f2(side * spec.legs.spacing)}" cy="${spec.legs.footCy}" rx="${spec.legs.footRx}" ry="${spec.legs.footRy}" fill="${P.accent}" stroke="${P.ink}" stroke-width="3"/>`;

  const beak = spec.beak.show
    ? `<path d="M ${f2(-spec.beak.width / 2)} ${spec.beak.cy} L ${f2(spec.beak.width / 2)} ${spec.beak.cy} L 0 ${f2(spec.beak.cy + spec.beak.depth)} Z" fill="${P.accent}" stroke="${P.ink}" stroke-width="2.5" stroke-linejoin="round"/>`
    : '';
  const cheeks = spec.cheeks.show
    ? `<circle cx="${f2(-spec.cheeks.spacing)}" cy="${spec.cheeks.cy}" r="${spec.cheeks.r}" fill="${P.cheek}" opacity="0.5"/>` +
      `<circle cx="${f2(spec.cheeks.spacing)}" cy="${spec.cheeks.cy}" r="${spec.cheeks.r}" fill="${P.cheek}" opacity="0.5"/>`
    : '';

  return (
    `<g transform="translate(0 ${f2(bob)}) rotate(${f2(sway)})">` +
    leg(-1) + leg(1) + foot(-1) + foot(1) +
    arm(-1, armL) + arm(1, armR) +
    `<g transform="scale(${bsx.toFixed(4)} ${breathe.toFixed(4)})">` +
    `<ellipse cx="0" cy="${spec.body.cy}" rx="${spec.body.rx}" ry="${spec.body.ry}" fill="${P.body}" stroke="${P.ink}" stroke-width="4"/>` +
    `<ellipse cx="0" cy="${spec.belly.cy}" rx="${spec.belly.rx}" ry="${spec.belly.ry}" fill="${P.belly}" opacity="0.92"/>` +
    `</g>` +
    `<circle cx="0" cy="${spec.head.cy}" r="${spec.head.r}" fill="${P.body}" stroke="${P.ink}" stroke-width="4"/>` +
    `<ellipse cx="${(spec.head.r * 0.4).toFixed(1)}" cy="${(spec.head.cy - spec.head.r * 0.4).toFixed(1)}" rx="16" ry="11" fill="${P.white}" opacity="0.22"/>` +
    cheeks + eye(-1) + eye(1) + beak +
    `<path d="M -11 ${spec.beak.cy + 22} Q 0 ${spec.beak.cy + 30} 11 ${spec.beak.cy + 22}" stroke="${P.ink}" stroke-width="3" fill="none" stroke-linecap="round"/>` +
    `</g>`
  );
}
