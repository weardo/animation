// ObjectSpec — the core-objects PROVIDER's OWN spec schema (ADR-006). A peer of blob-creature's
// CharacterSpec: where blob-creature owns "characters", core-objects owns simple flat-vector PROPS
// (the small environmental/scene objects a story needs — star, cloud, tree, planet, gear, …). The
// core IR's rig-layer `spec` is OPAQUE (`z.record(unknown)`); ONLY this provider validates/interprets
// it (with the schema below). "An object/prop is DATA, not code": one builder + a spec → a distinct
// prop, so a new prop is a new `kind` value + a few numbers, never a new component.
//
// PURE DATA: no behaviour here. The spec is content-addressed + travels inside the Scene IR
// (defs.rigs[ref].spec, opaque to core) so the compositor renders it deterministically — the provider
// parses it back to a typed ObjectSpec at render time. Zod-validated → TS types + JSON-Schema for free
// (CLAUDE.md r.3).

import { z } from 'zod';

const Color = z.string().regex(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'expected #rgb or #rrggbb');

/**
 * The prop vocabulary core-objects can draw. Each maps to one pure draw routine in objects.ts. New
 * props are added by extending this enum + adding a draw case — the IR/pipeline/core never change.
 */
export const ObjectKindSchema = z.enum([
  'star', // a five-point star (idle: twinkle)
  'cloud', // a lumpy stratus cloud (idle: drift)
  'tree', // a round-canopy tree (idle: sway)
  'planet', // a ringed planet disc (idle: gentle bob)
  'gear', // a cog/gear wheel (idle: rotate)
  'arrow', // a directional arrow (static)
  'icon', // an INGESTED open-license glyph: a filled badge (form-shaded) + outline strokes from `glyph`
]);
export type ObjectKind = z.infer<typeof ObjectKindSchema>;

export const ObjectSpecSchema = z
  .object({
    id: z.string().min(1),
    kind: ObjectKindSchema,
    /** Flat palette: a saturated fill + a dark ink outline + an accent (Kurzgesagt look). */
    palette: z
      .object({
        fill: Color,
        fillDark: Color.default('#000000'),
        ink: Color.default('#16243f'),
        accent: Color.default('#ffce4a'),
      })
      .strict(),
    /** Bounding radius in local units; the builder centres the prop on origin (0,0). */
    size: z.number().positive().default(60),
    /** Outline thickness in local units. */
    stroke: z.number().nonnegative().default(4),
    /**
     * Intra-prop variant flags — the per-`kind` part/skin selectors the rig layer's `parts` map sets
     * (e.g. {variant:"crescent"} on a planet, {detail:"detailed"} on a tree). Opaque numbers/strings
     * the draw routine reads; absent → the kind's default look. Mirrors how blob-creature's spec lets
     * the renderer pick part variants — here it makes the rig-layer `parts` field functional for props.
     */
    parts: z.record(z.string()).default({}),
    /**
     * INGESTED-ICON geometry (only read by `kind: "icon"`). A normalized open-license glyph: the SVG
     * path `d` strings extracted from the source icon + its viewBox, so the draw routine can scale the
     * glyph into the prop's local `size` box and stroke it in the palette `ink`. This is pure DATA
     * (no executable SVG) produced OFFLINE by `factory:ingest-icons` and content-addressed; the icon
     * is drawn ON a filled badge so the active stylekit form-shades it for free (like any prop fill).
     * Absent → the draw routine renders only the badge (graceful).
     */
    glyph: z
      .object({
        /** Extracted path `d` commands from the source SVG (geometry only; never raw markup). */
        paths: z.array(z.string().min(1)).default([]),
        /** The source viewBox `[minX, minY, w, h]` the paths are authored in (for scale-to-fit). */
        viewBox: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([0, 0, 24, 24]),
        /** Source stroke width in viewBox units (lucide/tabler are stroked icons; default 2). */
        strokeWidth: z.number().nonnegative().default(2),
        /** Whether the source paths are FILLED (CC0 solid icons) vs STROKED outlines. */
        filled: z.boolean().default(false),
        /** Show the colored badge behind the glyph (form-shaded). Off → a bare glyph (line-art). */
        badge: z.boolean().default(true),
        /** Badge shape: a rounded square or a disc. */
        badgeShape: z.enum(['rounded', 'circle']).default('rounded'),
      })
      .strict()
      .optional(),
    /** Idle-motion amplitudes (gated by the stylekit liveness floor at render). Kurzgesagt defaults. */
    motion: z
      .object({
        amp: z.number().default(1), // generic amplitude multiplier (twinkle/drift/sway/bob)
        spinHz: z.number().default(0.15), // gear rotation speed (turns/sec)
      })
      .strict()
      .default({}),
  })
  .strict();

export type ObjectSpec = z.infer<typeof ObjectSpecSchema>;

/** Validate raw spec data (from a file or the catalog) → a typed ObjectSpec (throws on invalid). */
export function parseSpec(data: unknown): ObjectSpec {
  return ObjectSpecSchema.parse(data);
}

/** A reference star spec — the fallback when a rig layer carries no (or an invalid) spec. */
export const STAR_SPEC: ObjectSpec = ObjectSpecSchema.parse({
  id: 'star',
  kind: 'star',
  palette: { fill: '#ffce4a', fillDark: '#e0a92f', ink: '#16243f', accent: '#fff3c4' },
  size: 56,
});
