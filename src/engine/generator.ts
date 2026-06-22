// Generator extension-point CONTRACT (ADR-005/007). The engine core owns ONLY this generic socket —
// the props every generator React component receives and the `GeneratorComponent` type the
// `generators` registry stores. The concrete generators (their geometry, RNG, and per-generator Zod
// params) are CODE and live in a plugin (plugins/core-generators); the engine specializes in NOTHING.
//
// Spec §10, §6.2: a Scene-IR `generator` layer carries `{ gen, seed, path?, params }` with `params`
// loose (`z.record(unknown)`) at the IR boundary so adding a generator needs NO IR/pipeline change.
// Each generator narrows its own `params` inside the plugin via its own Zod schema, parsed at render
// time. This keeps the IR + core stable while every generator is strongly typed and self-validating.
//
// DETERMINISM (CLAUDE.md r.1): this is a pure type/helper module — no clock, no RNG, no per-frame
// state. A generator component receives already-resolved primitive props so it stays a pure function
// of (resolvedProps + frame); the compositor (src/render) provides palette/frame.

import type { FC } from 'react';
import type { Palette } from '../ir/scene.js';

/**
 * Common props every generator React component receives from the compositor.
 *  - `seed`   the layer's deterministic seed (Scene IR `generator.seed`).
 *  - `frame`  the current frame; in Remotion this is `useCurrentFrame()`. Passed in (not read from a
 *             hook) so generators are unit-testable as pure functions and never own a clock.
 *  - `fps`    frames per second (for any Hz-based speed → per-frame conversion).
 *  - `width`/`height`  the composition size, for sensible default placement.
 *  - `path`   the optional Scene IR `path` (e.g. "asset://curve.svg#path"). When no explicit points
 *             are supplied a generator falls back to a default path.
 *  - `palette` optional token→color map (Scene IR `defs.palette`) for resolving token fills.
 *  - `params` the raw, generator-specific params object (validated by the generator's own schema).
 */
export interface GeneratorComponentProps {
  seed: number;
  /** Frame override; when omitted the generator reads Remotion's `useCurrentFrame()`. */
  frame?: number | undefined;
  /** FPS override; when omitted read from `useVideoConfig()`. */
  fps?: number | undefined;
  /** Width override; when omitted read from `useVideoConfig()`. */
  width?: number | undefined;
  /** Height override; when omitted read from `useVideoConfig()`. */
  height?: number | undefined;
  path?: string | undefined;
  palette?: Palette | undefined;
  params: unknown;
}

/** A generator is a React component consuming {@link GeneratorComponentProps}. */
export type GeneratorComponent = FC<GeneratorComponentProps>;

/**
 * Resolve a fill that may be a literal CSS color OR a `defs.palette` token name. Falls back to the
 * literal string if no matching token (so a raw hex always works). Pure. Shared by the generator
 * family AND the `shape` layer renderer — both resolve palette tokens identically.
 */
export function resolveFill(
  value: string | undefined,
  palette: Palette | undefined,
  fallback: string,
): string {
  if (value === undefined) return fallback;
  if (palette && Object.prototype.hasOwnProperty.call(palette, value)) {
    return palette[value]!;
  }
  return value;
}
