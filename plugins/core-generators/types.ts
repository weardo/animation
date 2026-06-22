// core-generators — per-generator params CONTRACTS (the generator-specific Zod schemas). ADR-007:
// these are domain CODE and live in the plugin, NOT in core. The generic socket — the
// `GeneratorComponentProps`/`GeneratorComponent` types and the `resolveFill` palette helper — lives in
// the engine core (engine/generator.ts) and is re-exported here so the generator modules in this
// plugin import everything from one local place.
//
// A Scene IR `generator` layer carries `{ gen, seed, path?, params }` with `params` loose
// (z.record(unknown)) at the IR boundary so adding a generator needs NO IR/pipeline change (CLAUDE.md
// rule 5; add-generator skill step 4). Each generator narrows its own `params` HERE via its own Zod
// schema, parsed at render time. This keeps the IR stable while every generator is self-validating.

import { z } from 'zod';

// Re-export the engine's generic generator contract so local generator modules import from one place.
export {
  resolveFill,
  type GeneratorComponent,
  type GeneratorComponentProps,
} from '../../src/engine/index.js';

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
    /** Connector stroke width in pixels (the line under the beads). */
    connector_width: z.number().positive().default(6),
  })
  .strip();

export type BeadStringParams = z.infer<typeof BeadStringParamsSchema>;

// --- scatter params ---------------------------------------------------------------------------

/**
 * Rectangular region the scatter fills. Defaults to the full composition (resolved in the renderer
 * because width/height are not known here). All fields optional → a layer can omit `region` and get
 * the whole frame, or specify any subset to bound a sub-area.
 */
export const ScatterRegionSchema = z
  .object({
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
  })
  .strip();

/**
 * Hard upper bound on element count (spec §10.1 shape budget). Counts above this are CLAMPED and the
 * drop is `console.warn`-ed — never silently truncated (CLAUDE.md "no silent caps" rule).
 */
export const SCATTER_SHAPE_BUDGET = 2000;

/**
 * The scatter generator params contract. Distributes `count` small motifs over `region` with seeded
 * per-element size/color/rotation/phase and optional per-element animation. Loose at the IR boundary,
 * strict here; every field defaulted so a minimally-authored layer still renders.
 */
export const ScatterParamsSchema = z
  .object({
    /** Per-element shape: a circle, a 4-point sparkle, or an organic blob (blobPath). */
    motif: z.enum(['dot', 'star', 'blob']).default('dot'),
    /** Region to fill; omitted fields fall back to the full composition (resolved at render time). */
    region: ScatterRegionSchema.default({}),
    /** Number of elements requested (clamped to SCATTER_SHAPE_BUDGET with a warning). */
    count: z.number().int().positive().default(200),
    /** Element size range in px, picked per-element by seed: [min, max]. */
    size: z.tuple([z.number().positive(), z.number().positive()]).default([2, 6]),
    /** Palette tokens OR hex colors; one is picked per-element by seed. */
    colors: z.array(z.string()).default(['#ffffff']),
    /** Placement: jittered even grid (default) or seeded uniform random. */
    distribution: z.enum(['grid', 'random']).default('grid'),
    /** Grid jitter strength 0..1 (fraction of a cell). Ignored for `random`. */
    jitter: z.number().min(0).max(1).default(0.6),
    /** Per-element animation driven by frame + per-element phase (deterministic). */
    anim: z.enum(['none', 'twinkle', 'drift', 'pulse']).default('none'),
    /** Animation speed in cycles/second (sampled at frame/fps). */
    anim_speed: z.number().positive().default(0.5),
    /** Drift travel radius in px (only used by anim='drift'). */
    drift_amount: z.number().min(0).default(6),
    /** Blobbiness for motif='blob' (0 = circle). */
    blobbiness: z.number().min(0).default(0.4),
    /** Soft emissive glow (SVG gaussian blur halo) behind the elements. */
    glow: z.boolean().default(false),
    /** Base layer opacity 0..1. */
    opacity: z.number().min(0).max(1).default(1),
  })
  .strip();

export type ScatterParams = z.infer<typeof ScatterParamsSchema>;
