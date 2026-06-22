// <ProceduralRig> — a code-only character provider (spec ADR-001 "procedural" rig kind). A character
// is composed from PRIMITIVE SHAPES (the prototype's vocabulary) and animated as a pure function of
// the frame — no vendor skeleton, no mesh/FFD/UV contract to get wrong (which is what broke the
// DragonBones-codegen rig). Identity is structural: shapes are fixed; only transforms change.
//
// Wiring: a `rig` layer whose resolved `defs.rigs[ref].kind === 'procedural'` dispatches here (see
// Scene.tsx). The character is selected by the `proc://<id>` uri against the BUILDERS registry; the
// layer's `{a,k}` transform (position/scale/rotation/opacity) is applied as a wrapper exactly like
// <RigLayer>, so the camera/parallax/contact-shadow all line up. rig_state.clips drive the gestures.
//
// DETERMINISM (CLAUDE.md r.1): pure function of (frame, fps, clips). Blink is frame-modulo (no RNG);
// motion is trig of frame/fps. SVG renders on the CPU → no swangle/Pixi, so it is byte-reproducible
// AND fast (no software-GL cost).

import React from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Easings, RigClip, RigLayer as RigLayerIR } from '../ir/index.js';
import { evalNumber, evalVec2 } from './eval.js';

const TAU = Math.PI * 2;

/** A character builder: (frame, fps, clips) → an SVG <g> drawn centred on local origin (0,0). */
type CharBuilder = (frame: number, fps: number, clips: readonly RigClip[]) => React.ReactNode;

/** Resolve the active wave gesture window from rig_state.clips → arm-raise angle (degrees). */
function waveAngle(frame: number, fps: number, clips: readonly RigClip[], rest: number): number {
  const wave = clips.find((c) => c.anim === 'wave' && typeof c.at === 'number');
  if (!wave || wave.at === undefined) return rest;
  const laterAts = clips.map((c) => c.at).filter((a): a is number => typeof a === 'number' && a > wave.at!);
  const end = laterAts.length ? Math.min(...laterAts) : wave.at + 48;
  if (frame < wave.at || frame >= end) return rest;
  const p = (frame - wave.at) / (end - wave.at);
  const raise = Math.sin(Math.min(1, p * 1.5) * (Math.PI / 2)); // ease up, then hold
  const waggle = p < 0.85 ? Math.sin((frame / fps) * TAU * 3) * 16 : 0;
  return rest - raise * 150 + waggle; // negative = arm rotates upward
}

const PAL = {
  body: '#4aa3ff',
  bodyDark: '#2f86e0',
  ink: '#16243f',
  belly: '#d6ecff',
  accent: '#ffce4a',
  white: '#ffffff',
  cheek: '#ff7eb0',
} as const;

/** The "blip" character: a flat-vector Kurzgesagt blob creature, built from primitives. */
const blip: CharBuilder = (frame, fps, clips) => {
  const t = frame / fps;
  const bob = Math.sin(t * TAU * 0.45) * 5; // gentle vertical bob
  const sway = Math.sin(t * TAU * 0.3) * 1.6; // whole-body sway, degrees
  const breathe = 1 + 0.03 * Math.sin((t * TAU) / 4); // chest scale
  const bsx = 1 / Math.sqrt(breathe); // volume-preserving squash
  const blinkClosed = frame % 132 < 5 || frame % 312 < 5; // deterministic double-rhythm blink
  const eyeSy = blinkClosed ? 0.12 : 1;
  const armR = waveAngle(frame, fps, clips, 14);
  const armL = -16;

  const Eye: React.FC<{ x: number }> = ({ x }) => (
    <g transform={`translate(${x} -74) scale(1 ${eyeSy})`}>
      <circle r={17} fill={PAL.white} stroke={PAL.ink} strokeWidth={3} />
      <circle cx={2} cy={2} r={8} fill={PAL.ink} />
      <circle cx={-2} cy={-3} r={3} fill={PAL.white} />
    </g>
  );

  return (
    <g transform={`translate(0 ${bob.toFixed(2)}) rotate(${sway.toFixed(2)})`}>
      {/* legs + feet (behind) */}
      <rect x={-34} y={78} width={20} height={40} rx={10} fill={PAL.bodyDark} />
      <rect x={14} y={78} width={20} height={40} rx={10} fill={PAL.bodyDark} />
      <ellipse cx={-24} cy={120} rx={23} ry={12} fill={PAL.accent} stroke={PAL.ink} strokeWidth={3} />
      <ellipse cx={24} cy={120} rx={23} ry={12} fill={PAL.accent} stroke={PAL.ink} strokeWidth={3} />

      {/* arms (behind body), pivoting at the shoulders */}
      <g transform={`rotate(${armL} -58 6)`}>
        <rect x={-72} y={2} width={18} height={66} rx={9} fill={PAL.bodyDark} stroke={PAL.ink} strokeWidth={3} />
        <circle cx={-63} cy={70} r={11} fill={PAL.body} stroke={PAL.ink} strokeWidth={3} />
      </g>
      <g transform={`rotate(${armR.toFixed(2)} 58 6)`}>
        <rect x={54} y={2} width={18} height={66} rx={9} fill={PAL.bodyDark} stroke={PAL.ink} strokeWidth={3} />
        <circle cx={63} cy={70} r={11} fill={PAL.body} stroke={PAL.ink} strokeWidth={3} />
      </g>

      {/* body (breathing squash about its centre) */}
      <g transform={`scale(${bsx.toFixed(4)} ${breathe.toFixed(4)})`}>
        <ellipse cx={0} cy={28} rx={70} ry={68} fill={PAL.body} stroke={PAL.ink} strokeWidth={4} />
        <ellipse cx={0} cy={48} rx={42} ry={36} fill={PAL.belly} opacity={0.92} />
      </g>

      {/* head */}
      <circle cx={0} cy={-66} r={66} fill={PAL.body} stroke={PAL.ink} strokeWidth={4} />
      <ellipse cx={26} cy={-92} rx={16} ry={11} fill={PAL.white} opacity={0.22} />

      {/* cheeks */}
      <circle cx={-46} cy={-50} r={9} fill={PAL.cheek} opacity={0.5} />
      <circle cx={46} cy={-50} r={9} fill={PAL.cheek} opacity={0.5} />

      {/* eyes */}
      <Eye x={-26} />
      <Eye x={26} />

      {/* beak + mouth */}
      <path d="M -12 -50 L 12 -50 L 0 -34 Z" fill={PAL.accent} stroke={PAL.ink} strokeWidth={2.5} strokeLinejoin="round" />
      <path d="M -11 -28 Q 0 -20 11 -28" stroke={PAL.ink} strokeWidth={3} fill="none" strokeLinecap="round" />
    </g>
  );
};

const BUILDERS: Record<string, CharBuilder> = { blip };

/** `proc://blip` → `blip`. */
function charId(uri: string): string {
  return uri.replace(/^proc:\/\//, '').split('/')[0] ?? '';
}

export interface ProceduralRigProps {
  layer: RigLayerIR;
  rigUri: string;
  easings?: Easings | undefined;
}

export const ProceduralRig: React.FC<ProceduralRigProps> = ({ layer, rigUri, easings }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const easingTable: Easings = easings ?? {};

  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  const build = BUILDERS[charId(rigUri)] ?? blip;

  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height,
    opacity: opacityPct / 100,
    transform: [
      `translate(${px - width / 2}px, ${py - height / 2}px)`,
      `rotate(${rotationDeg}deg)`,
      `scale(${scalePct / 100})`,
    ].join(' '),
    transformOrigin: 'center center',
  };

  return (
    <AbsoluteFill data-proc-rig={layer.id}>
      <div style={wrapperStyle}>
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ overflow: 'visible' }}>
          <g transform={`translate(${width / 2} ${height / 2})`}>{build(frame, fps, layer.rig_state.clips)}</g>
        </svg>
      </div>
    </AbsoluteFill>
  );
};

export default ProceduralRig;
