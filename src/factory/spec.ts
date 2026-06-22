// Character SPEC — the data-driven recipe the asset factory turns into a procedural character
// (spec ADR-001/ADR-002). One generalized builder (character.ts) + a spec → a distinct creature, so
// new characters are DATA, not code. Zod-validated → TS types + JSON-Schema for free (CLAUDE.md r.3).
//
// PURE DATA: no behaviour here. The spec is content-addressed + stored as a library artifact and
// travels inside the Scene IR (defs.rigs[ref].spec) so the compositor renders it deterministically.

import { z } from 'zod';

const Color = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected #rgb or #rrggbb');

export const CharacterSpecSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /**
     * The character STYLE that builds this spec's markup (ADR-005 "Character styles"). Resolved at
     * render time from the engine's `characterStyles` registry (a style ships as a plugin, e.g. the
     * default `blob-creature`). Optional → defaults to `blob-creature` so existing specs are unchanged.
     */
    style: z.string().min(1).default('blob-creature'),
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
  })
  .strict();

export type CharacterSpec = z.infer<typeof CharacterSpecSchema>;

/** Validate raw spec data (from a file or the catalog) → a typed CharacterSpec (throws on invalid). */
export function parseSpec(data: unknown): CharacterSpec {
  return CharacterSpecSchema.parse(data);
}

/** The reference "blip" spec — the proportions ProceduralRig was hand-tuned to. Used as a template. */
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
