// Library catalog schema — the on-disk shape of `library/index.json` (spec §13.2).
//
// The catalog is the human-name + semver registry. It is namespaced by kind
// (characters / props / backgrounds / generators / kits). Each entry carries its
// addressable *content* (uri, format, manifest, deps, provenance) but NOT its
// content hash — the hash is derived at resolve time from this content via
// `object-hash` (see resolver.ts), so the catalog stays hand-editable and the
// hash is never a stale, manually-maintained field.
//
// Zod is the single source of truth (CLAUDE.md golden rule 3): schemas here yield
// both runtime validation and the TS types the rest of the library layer uses.

import { z } from 'zod';

/** Library entry kinds (spec §13.3). M1 exercises `asset` + `rig`; the rest are reserved. */
export const EntryKindSchema = z.enum([
  'asset',
  'rig',
  'preset',
  'clip',
  'environment',
  'generator',
  'stylekit',
  'palette',
  'easing-set',
]);
export type EntryKind = z.infer<typeof EntryKindSchema>;

/** Semantic version `MAJOR.MINOR.PATCH` (no pre-release/build metadata in M1). */
export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'expected semver MAJOR.MINOR.PATCH');

/** Provenance for free / AI-generated assets (source + license). */
export const ProvenanceSchema = z
  .object({
    source: z.string().min(1),
    license: z.string().min(1),
    /** Factory-generated assets: the generator + the content hash of the source spec. */
    generator: z.string().optional(),
    spec_hash: z.string().optional(),
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * Rig manifest: a rig is a typed black box (spec §8.1). It declares the bones/slots
 * that may be attached to (`mounts`) and the swappable part axes (`variants`).
 * Reserved-but-present in M1: the dragon rig declares empty mounts/variants.
 */
export const RigManifestSchema = z
  .object({
    mounts: z
      .record(
        z
          .object({
            bone: z.string().optional(),
            slot: z.string().optional(),
            /** Local offset (px) of this mount in the rig's own centred space (spec §8.1 attach). */
            offset: z.tuple([z.number(), z.number()]).optional(),
          })
          .strict(),
      )
      .default({}),
    variants: z.record(z.array(z.string())).default({}),
    /** Named animations the rig exposes (procedural characters: idle/blink/wave). */
    clips: z.array(z.string()).optional(),
    /** Approximate footprint for layout/preview (local units). */
    bounds: z.object({ w: z.number(), h: z.number() }).optional(),
  })
  .strict();
export type RigManifest = z.infer<typeof RigManifestSchema>;

/**
 * A single catalog entry. `uri` + `format` + `manifest` + `deps` + `provenance`
 * form the *content* that is content-addressed. `id`/`version`/`kind`/`tags` are
 * catalog metadata; `id` and `version` are excluded from the content hash by the
 * resolver (a rename or re-tag must not change a content hash).
 */
export const CatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    version: SemverSchema,
    kind: EntryKindSchema,
    /** Media/serialization format, e.g. 'svg' | 'lottie' | 'image' | 'dragonbones' | 'procedural'. */
    format: z.string().min(1).optional(),
    /**
     * For `rig` entries (ADR-006): the id of the PROVIDER plugin that renders this entry (e.g.
     * 'blob-creature', 'dragonbones'). The loader copies it into the Scene-IR rig def's `provider`.
     * Optional → the loader derives it from `format` for back-compat (procedural → blob-creature).
     */
    provider: z.string().min(1).optional(),
    /** Addressable location, e.g. `rig://dragon.dbones.json` or `asset://bg.svg#path`. */
    uri: z.string().min(1).optional(),
    tags: z.array(z.string()).default([]),
    /** Other entries this one depends on, as `name@version` refs (spec §13.2 dedup/DAG). */
    deps: z.array(z.string()).default([]),
    /** Rig-only manifest (mounts + variant axes). */
    manifest: RigManifestSchema.optional(),
    provenance: ProvenanceSchema.optional(),
    /** Relative path (under library/) to a generated preview image. */
    preview: z.string().optional(),
  })
  .strict();
export type CatalogEntry = z.infer<typeof CatalogEntrySchema>;

/** Namespace name → { entry id → entry }. */
export const NamespaceSchema = z.record(CatalogEntrySchema);
export type Namespace = z.infer<typeof NamespaceSchema>;

/** The full `library/index.json` document. */
export const CatalogSchema = z
  .object({
    catalog_version: z.string().min(1),
    description: z.string().optional(),
    entries: z.record(NamespaceSchema),
  })
  .strict();
export type Catalog = z.infer<typeof CatalogSchema>;
