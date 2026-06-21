// animation.lock — npm-style lockfile that pins resolved content hashes per project (spec §13.2).
//
// "Why the lockfile matters": it reconciles a *growing library* with *deterministic
// renders*. Each project records the exact hash every `name@version` resolved to, so
// improving a library entry later never silently changes a past video — upgrades are
// opt-in (re-resolve + rewrite the lock).
//
// Pure schema + (de)serialization here; the read/write/verify glue lives in
// resolver.ts so it can share the hashing function.

import { z } from 'zod';

/** Content-hash string. `object-hash` (sha1) hex by default; format-tagged for clarity. */
export const ContentHashSchema = z.string().min(1);
export type ContentHash = z.infer<typeof ContentHashSchema>;

/** One pinned ref. Keyed in the lock by canonical `name@version`. */
export const LockEntrySchema = z
  .object({
    /** Catalog namespace the entry resolved from (e.g. 'characters'). */
    namespace: z.string().min(1),
    id: z.string().min(1),
    version: z.string().min(1),
    /** The resolved content hash this project is pinned to. */
    hash: ContentHashSchema,
    /** Resolved deps, as canonical `name@version` refs, for DAG reconstruction. */
    deps: z.array(z.string()).default([]),
  })
  .strict();
export type LockEntry = z.infer<typeof LockEntrySchema>;

/** The full `animation.lock` document. `refs` is keyed by `name@version`. */
export const LockfileSchema = z
  .object({
    lockfile_version: z.literal('1'),
    /** Hash of the hashing algorithm + scheme, so a scheme change invalidates old locks. */
    algorithm: z.string().min(1),
    refs: z.record(LockEntrySchema),
  })
  .strict();
export type Lockfile = z.infer<typeof LockfileSchema>;

/** Hashing scheme identifier recorded in every lockfile; bump on any hashing change. */
export const LOCK_ALGORITHM = 'object-hash@sha1/v1';
export const LOCKFILE_VERSION = '1' as const;

/** An empty, well-formed lockfile (used when none exists yet). */
export function emptyLockfile(): Lockfile {
  return { lockfile_version: LOCKFILE_VERSION, algorithm: LOCK_ALGORITHM, refs: {} };
}
