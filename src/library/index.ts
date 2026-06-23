// Library layer: content-addressed registry, name@version -> hash resolver, and animation.lock.
//
// Maps human `name@version` refs to deterministic content hashes (object-hash) over the
// `library/index.json` catalog; pins resolved hashes in `animation.lock` for byte-stable
// re-renders; loads asset/rig entry data by ref with dedup. No network, local-first. Spec §13.2.
//
// M1 catalog ships: a DragonBones dragon rig, a background svg, an axon curve (bead-string path).
// Hashes are NOT stored in the catalog — they are computed at resolve time from entry content.

// Catalog (library/index.json) schema + types.
export {
  CatalogSchema,
  NamespaceSchema,
  CatalogEntrySchema,
  EntryKindSchema,
  SemverSchema,
  ProvenanceSchema,
  RigManifestSchema,
  GeneratorPresetSchema,
} from './catalog.js';
export type {
  Catalog,
  Namespace,
  CatalogEntry,
  EntryKind,
  Provenance,
  RigManifest,
  GeneratorPreset,
} from './catalog.js';

// Lockfile (animation.lock) schema + types + constants.
export {
  LockfileSchema,
  LockEntrySchema,
  ContentHashSchema,
  LOCK_ALGORITHM,
  LOCKFILE_VERSION,
  emptyLockfile,
} from './lockfile.js';
export type { Lockfile, LockEntry, ContentHash } from './lockfile.js';

// Resolver: ref parsing, lookup, content hashing, dedup, lockfile build/verify.
export {
  canonicalRef,
  parseRef,
  locateEntry,
  hashEntry,
  resolveRef,
  resolveRefs,
  buildLockfile,
  verifyAgainstLock,
} from './resolver.js';
export type {
  ParsedRef,
  LocatedEntry,
  ResolvedEntry,
  LockVerifyResult,
} from './resolver.js';

// Disk I/O: catalog load + lockfile read/write.
export {
  loadCatalog,
  parseCatalog,
  readLockfile,
  parseLockfile,
  writeLockfile,
  lockfileExists,
  DEFAULT_CATALOG_PATH,
  DEFAULT_LOCK_PATH,
} from './io.js';

// Loader facade (the P2-pass entry point).
export { Library } from './loader.js';
