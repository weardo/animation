// The `sim` generator — the "explain anything" surface. It runs AGENT-AUTHORED simulation code that
// returns SVG markup for the current frame, so a Concept agent can visualize ANY physics/math idea
// (orbits, pulleys, logic gates, waves, geometry…) as a real, animated diagram.
//
// DETERMINISM (CLAUDE.md r.1): the code MUST be a PURE function of `frame` — it recomputes the full
// state from scratch each call (no carried state; Remotion renders frames in parallel / out of order),
// and uses no Date/unseeded random. Output is SVG → captured deterministically, safe on the CPU raster.
//
// SECURITY: `new Function` executes model-authored JS and its output is injected as SVG. Acceptable in
// the single-user, localhost self-host studio (the code is the operator's OWN Claude, not arbitrary
// input; the SVG renders in the headless render process, not the studio UI, so it's not a browser-XSS
// vector). A hardened multi-tenant deploy would run the code in a worker/sandbox.
import React from 'react';
import Matter from 'matter-js';
import { useCurrentFrame, useVideoConfig } from 'remotion';
import { z } from 'zod';

import type { GeneratorComponentProps } from './types.js';

export const SimParamsSchema = z
  .object({
    /** Body of `(frame, fps, width, height, params) => string` returning SVG inner markup for `frame`. */
    code: z.string().min(1),
    /** Free-form parameters passed to the sim code (constants, labels, colors…). */
    params: z.record(z.unknown()).default({}),
  })
  .passthrough();

type SimFn = (
  frame: number,
  fps: number,
  width: number,
  height: number,
  params: unknown,
  Matter: typeof import('matter-js'),
) => unknown;

// Compile each distinct code string ONCE (pure → caching across frames is sound + fast). `Matter` is
// the real 2D physics engine (matter-js) injected into the sim scope so agent code runs ACCURATE
// rigid-body physics (pulleys, gears, collisions, pendulums) rather than eyeballed motion. Determinism
// holds because the code re-simulates from frame 0 with a fixed timestep each call (matter-js has no
// internal randomness) — so the same `frame` always yields the same SVG.
const compiled = new Map<string, SimFn>();
function compile(code: string): SimFn {
  let fn = compiled.get(code);
  if (!fn) {
    // eslint-disable-next-line no-new-func
    fn = new Function('frame', 'fps', 'width', 'height', 'params', 'Matter', code) as SimFn;
    compiled.set(code, fn);
  }
  return fn;
}

const escapeXml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const Sim: React.FC<GeneratorComponentProps> = (props) => {
  const cfg = useVideoConfig();
  const hookFrame = useCurrentFrame();
  const frame = props.frame ?? hookFrame;
  const fps = props.fps ?? cfg.fps;
  const width = props.width ?? cfg.width;
  const height = props.height ?? cfg.height;

  const parsed = SimParamsSchema.parse(props.params ?? {});

  let markup = '';
  try {
    markup = String(compile(parsed.code)(frame, fps, width, height, parsed.params, Matter) ?? '');
  } catch (e) {
    markup = `<text x="24" y="48" fill="#ff5a52" font-family="monospace" font-size="22">sim error: ${escapeXml(
      (e as Error).message.slice(0, 80),
    )}</text>`;
  }

  // innerHTML on an SVG element parses in the SVG namespace (context node = <g> in the SVG tree), so
  // <circle>/<line>/<path> become real SVG shapes — unlike innerHTML on an HTML node.
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ width, height }}>
      <g dangerouslySetInnerHTML={{ __html: markup }} />
    </svg>
  );
};
