// Generator library — shared types and the per-generator params contract. Spec §10, §6.2.
//
// A Scene IR `generator` layer carries `{ gen, seed, path?, params }` with `params` typed loosely
// (z.record(unknown)) at the IR boundary so adding a generator needs NO IR/pipeline change
// (CLAUDE.md rule 5; add-generator skill step 4). Each generator narrows its own `params` HERE via
// its own Zod schema, parsed at render time. This keeps the IR stable while every generator is
// strongly typed and self-validating.
//
// The compositor (src/render) is responsible for resolving palette tokens / easing names and
// providing the frame clock; a generator component receives already-resolved primitive props so it
// stays a pure function of (resolvedProps + frame). We keep the resolution helpers tolerant: a
// `fill` may be a raw color OR a palette token, resolved against an optional palette map.

import type { FC } from 'react';
import { z } from 'zod';
import type { Palette } from '../ir/scene.js';

/**
 * Common props every generator React component receives from the compositor.
 *  - `seed`   the layer's deterministic seed (Scene IR `generator.seed`).
 *  - `frame`  the current frame; in Remotion this is `useCurrentFrame()`. Passed in (not read from a
 *             hook) so generators are unit-testable as pure functions and never own a clock.
 *  - `fps`    frames per second (for any Hz-based speed → per-frame conversion).
 *  - `width`/`height`  the composition size, for sensible default placement.
 *  - `path`   the optional Scene IR `path` (e.g. "asset://axon.svg#path"). M1 has no asset loader,
 *             so when no explicit points are supplied a generator falls back to a default path.
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
 * literal string if no matching token (so a raw hex always works). Pure.
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

// --- bead-string params -----------------------------------------------------------------------

/** Pulse propagation params: `phase = frame*speed − index*phase_step` drives per-bead scale. */
export const PulseParamsSchema = z
  .object({
    /** Peak scale delta of a bead at the pulse crest (e.g. 0.25 → bead scales up to 1.25×). */
    amp: z.number().default(0.25),
    /** Pulse travel speed along the chain (phase units per frame). */
    speed: z.number().default(1.4),
    /** Per-bead phase offset; larger ⇒ a more spread-out, slower-looking travelling wave. */
    phase_step: z.number().default(0.6),
  })
  .strip();

/** Wavy connector bending params (seeded organic sideways undulation of the chain). */
export const WaveParamsSchema = z
  .object({
    /** Bending amplitude in pixels (sideways displacement of the connector). */
    amp: z.number().default(10),
    /** Bending speed (cycles per second; sampled at frame/fps). */
    speed: z.number().default(0.8),
  })
  .strip();

/**
 * The full bead-string params contract (spec §6.2 example). Loose at the IR boundary, strict here.
 * All fields have defaults so a minimally-authored layer still renders.
 */
export const BeadStringParamsSchema = z
  .object({
    /** Number of beads placed along the path. */
    beads: z.number().int().positive().default(9),
    /** Base bead radius in pixels (modulated per-bead by the pulse + wobble). */
    bead_radius: z.number().positive().default(14),
    /** Blobby wobble strength, 0 = perfect circles, ~0.5 = noticeably organic. */
    blobbiness: z.number().min(0).default(0.35),
    /** Travelling-pulse params. */
    pulse: PulseParamsSchema.default({}),
    /** Wavy connector bending params. */
    wave: WaveParamsSchema.default({}),
    /** Gooey merge look (SVG goo filter on the connector + beads). */
    gooey: z.boolean().default(true),
    /** Emissive glow around beads. */
    glow: z.boolean().default(true),
    /** Fill: a CSS color OR a `defs.palette` token name. */
    fill: z.string().default('#ffcf4d'),
    /** Connector stroke width in pixels (the "axon" line under the beads). */
    connector_width: z.number().positive().default(6),
  })
  .strip();

export type BeadStringParams = z.infer<typeof BeadStringParamsSchema>;
