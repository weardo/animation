// CharacterSpec — the blob-creature PROVIDER's OWN spec schema (ADR-006). This lived in core
// (`src/factory/spec.ts`) when the engine still knew about "characters"; ADR-006 purges that domain
// entity from core, so the spec moves INTO the plugin that owns it. The core IR's rig-layer `spec` is
// OPAQUE (`z.record(unknown)`) — only THIS provider validates/interprets it (with the schema below).
//
// One generalized builder (character.ts) + a spec → a distinct creature, so new creatures are DATA,
// not code. Zod-validated → TS types + JSON-Schema for free (CLAUDE.md r.3).
//
// PURE DATA: no behaviour here. The spec is content-addressed + stored as a library artifact and
// travels inside the Scene IR (defs.rigs[ref].spec, opaque to core) so the compositor renders it
// deterministically — the provider parses it back to a typed CharacterSpec at render time.

import { z } from 'zod';

const Color = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected #rgb or #rrggbb');

export const CharacterSpecSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Flat palette (Kurzgesagt: saturated body + dark ink outline + accent for beak/feet). */
    palette: z
      .object({
        body: Color,
        bodyDark: Color,
        ink: Color,
        belly: Color,
        accent: Color,
        white: Color.default('#ffffff'),
        cheek: Color.default('#ff7eb0'),
      })
      .strict(),
    /** Proportions (local units; the builder centres the character on origin). */
    head: z.object({ r: z.number(), cy: z.number() }).strict(),
    body: z.object({ rx: z.number(), ry: z.number(), cy: z.number() }).strict(),
    belly: z.object({ rx: z.number(), ry: z.number(), cy: z.number() }).strict(),
    eyes: z
      .object({ spacing: z.number(), cy: z.number(), r: z.number(), pupil: z.number() })
      .strict(),
    beak: z.object({ show: z.boolean(), width: z.number(), depth: z.number(), cy: z.number() }).strict(),
    cheeks: z.object({ show: z.boolean(), r: z.number(), spacing: z.number(), cy: z.number() }).strict(),
    arms: z.object({ width: z.number(), length: z.number(), shoulderY: z.number(), rest: z.number() }).strict(),
    legs: z
      .object({ width: z.number(), height: z.number(), spacing: z.number(), footRx: z.number(), footRy: z.number(), footCy: z.number() })
      .strict(),
    /** Motion amplitudes; sensible Kurzgesagt defaults so a spec can omit them. */
    motion: z
      .object({
        bob: z.number().default(5),
        swayDeg: z.number().default(1.6),
        breathe: z.number().default(0.03),
        waveRaise: z.number().default(150),
      })
      .strict()
      .default({}),
    /**
     * INTRA-RIG VARIANT axes (spec §8.1 `parts`). A map: axis name → (variant name → a PARTIAL spec
     * override). When a Scene-IR rig layer selects `parts: { axis: "variantName" }`, this provider
     * deep-merges the matching override onto the base spec BEFORE drawing — so one self-contained rig
     * carries multiple looks (e.g. `palette: { warm: {...}, cool: {...} }`, `outfit: {...}`). The valid
     * axis/variant names a rig advertises are also published in its library manifest `variants` (DATA);
     * here the override VALUES live with the provider (it owns the CharacterSpec it interprets). OPAQUE
     * to core — `parts` is just a `z.record(string)` selection the core forwards untouched (ADR-006).
     */
    variants: z.record(z.record(z.record(z.unknown()))).optional(),
  })
  .strict();

export type CharacterSpec = z.infer<typeof CharacterSpecSchema>;

/** Validate raw spec data (from a file or the catalog) → a typed CharacterSpec (throws on invalid). */
export function parseSpec(data: unknown): CharacterSpec {
  return CharacterSpecSchema.parse(data);
}

/** Deep-merge `b` onto `a` (objects merge recursively; scalars/arrays from `b` win). Pure. */
function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && prev && typeof prev === 'object' && !Array.isArray(prev)) {
      out[k] = deepMerge(prev as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Apply a Scene-IR rig layer's `parts` selection (spec §8.1) to a CharacterSpec. For each
 * `{ axis: variantName }`, deep-merges the matching `spec.variants[axis][variantName]` override onto
 * the base, then re-validates (so a variant can't produce an invalid spec). Unknown axes/variants are
 * skipped silently (a selection a rig does not advertise is a no-op, not a crash). Pure + deterministic
 * — a function of (spec, parts) only; no clock, no RNG. Returns the base unchanged when `parts` is empty.
 */
export function applyParts(spec: CharacterSpec, parts: Record<string, string> | undefined): CharacterSpec {
  if (!parts || Object.keys(parts).length === 0 || !spec.variants) return spec;
  let merged: Record<string, unknown> = { ...spec };
  for (const [axis, variantName] of Object.entries(parts)) {
    const override = spec.variants[axis]?.[variantName];
    if (override) merged = deepMerge(merged, override);
  }
  // Drop the variants table from the merged object before re-validating (it's provider-internal data).
  delete merged['variants'];
  return CharacterSpecSchema.parse(merged);
}

/** The reference "blip" spec — the proportions the renderer was hand-tuned to. Used as a template. */
export const BLIP_SPEC: CharacterSpec = CharacterSpecSchema.parse({
  id: 'blip',
  name: 'Blip',
  palette: { body: '#4aa3ff', bodyDark: '#2f86e0', ink: '#16243f', belly: '#d6ecff', accent: '#ffce4a', white: '#ffffff', cheek: '#ff7eb0' },
  head: { r: 66, cy: -66 },
  body: { rx: 70, ry: 68, cy: 28 },
  belly: { rx: 42, ry: 36, cy: 48 },
  eyes: { spacing: 26, cy: -74, r: 17, pupil: 8 },
  beak: { show: true, width: 24, depth: 16, cy: -50 },
  cheeks: { show: true, r: 9, spacing: 46, cy: -50 },
  arms: { width: 18, length: 66, shoulderY: 6, rest: 14 },
  legs: { width: 20, height: 40, spacing: 24, footRx: 23, footRy: 12, footCy: 120 },
  motion: { bob: 5, swayDeg: 1.6, breathe: 0.03, waveRaise: 150 },
});
