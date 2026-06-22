// Loader — the consumer-facing facade over the library layer (spec §13.2, pipeline P2).
//
// A `Library` wraps a loaded catalog and gives callers a small, dedup-aware API:
//   • get(ref)        → resolved entry data (located + content-hashed), by `name@version`
//   • load(refs)      → dedup'd Map of resolved entries for a whole scene's refs
//   • toRigDef/AssetDef → adapt a resolved entry to the Scene-IR `defs` shapes (src/ir)
//   • lock / verifyLock → produce / check `animation.lock` against the live catalog
//
// No network. Resolution is pure over the catalog; the only side effects are explicit
// lockfile reads/writes the caller requests.

import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { AssetDef, RigDef } from '../ir/index.js';
import type { Catalog } from './catalog.js';
import {
  resolveRef,
  resolveRefs,
  buildLockfile,
  verifyAgainstLock,
  type ResolvedEntry,
  type LockVerifyResult,
} from './resolver.js';
import type { Lockfile } from './lockfile.js';
import {
  loadCatalog,
  readLockfile,
  writeLockfile,
  DEFAULT_CATALOG_PATH,
  DEFAULT_LOCK_PATH,
} from './io.js';

export class Library {
  /** In-pass resolution cache so a repeated ref is hashed exactly once (dedup, spec §13.2). */
  private readonly cache = new Map<string, ResolvedEntry>();

  constructor(
    readonly catalog: Catalog,
    private readonly rootDir: string = process.cwd()
  ) {}

  /** Construct a Library by loading `library/index.json` from disk. */
  static open(
    rootDir: string = process.cwd(),
    catalogPath: string = DEFAULT_CATALOG_PATH
  ): Library {
    return new Library(loadCatalog(rootDir, catalogPath), rootDir);
  }

  /** Resolve a single ref to its located + content-hashed entry (cached/deduped). */
  get(ref: string): ResolvedEntry {
    const resolved = resolveRef(this.catalog, ref);
    const existing = this.cache.get(resolved.key);
    if (existing) return existing;
    this.cache.set(resolved.key, resolved);
    return resolved;
  }

  /**
   * Resolve many refs at once, deduping. Folds results into the instance cache so
   * subsequent `get()` calls for the same `name@version` are free.
   */
  load(refs: readonly string[]): Map<string, ResolvedEntry> {
    const resolved = resolveRefs(this.catalog, refs);
    for (const [key, r] of resolved) {
      if (!this.cache.has(key)) this.cache.set(key, r);
    }
    return resolved;
  }

  /** The content hash for a ref (the `cache://sha…` address in spec §13.2 terms). */
  hashOf(ref: string): string {
    return this.get(ref).hash;
  }

  /** Adapt a resolved rig entry to the Scene-IR `RigDef` shape (src/ir). */
  toRigDef(ref: string): RigDef {
    const r = this.get(ref);
    if (r.entry.kind !== 'rig') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'rig'`);
    }
    if (!r.entry.uri) throw new Error(`rig entry ${r.key} has no uri`);
    // ADR-006/007: the rig def carries a `provider` id (NOT a domain "kind"), named by the catalog
    // entry as DATA — core knows no provider plugin by name. The provider itself validates/renders the
    // opaque spec. We require the entry to declare its provider (no core fallback that guesses a plugin
    // name from `format` — that would re-introduce provider knowledge into the engine).
    const provider = r.entry.provider;
    if (!provider) {
      throw new Error(
        `rig entry ${r.key} has no 'provider' (the catalog entry must name the provider plugin that renders it)`
      );
    }
    // A `proc://` URI is the engine-generic convention for "this entry carries an inlined sidecar spec
    // co-located with it" — embed it so the opaque spec travels in the Scene IR (the named provider
    // validates/renders it). Keyed on the URI SCHEME (data convention), not on any provider name.
    if (r.entry.uri.startsWith('proc://')) {
      const id = r.entry.uri.replace(/^proc:\/\//, '').split('/')[0] ?? '';
      const specPath = resolvePath(this.rootDir, 'library', 'characters', id, `${id}.spec.json`);
      const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
      return { uri: r.entry.uri, provider, spec };
    }
    return { uri: r.entry.uri, provider };
  }

  /** Adapt a resolved asset entry to the Scene-IR `AssetDef` shape (src/ir). */
  toAssetDef(ref: string): AssetDef {
    const r = this.get(ref);
    if (r.entry.kind !== 'asset') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'asset'`);
    }
    if (!r.entry.uri) throw new Error(`asset entry ${r.key} has no uri`);
    const fmt = r.entry.format;
    if (fmt !== 'svg' && fmt !== 'lottie' && fmt !== 'image') {
      throw new Error(`asset entry ${r.key} has unsupported format '${fmt ?? '<none>'}'`);
    }
    return { uri: r.entry.uri, kind: fmt };
  }

  /** Build a lockfile pinning the currently-cached resolutions, plus any extra refs. */
  buildLock(extraRefs: readonly string[] = []): Lockfile {
    if (extraRefs.length) this.load(extraRefs);
    return buildLockfile(this.cache);
  }

  /** Build + write `animation.lock`; returns the absolute path written. */
  writeLock(
    extraRefs: readonly string[] = [],
    lockPath: string = DEFAULT_LOCK_PATH
  ): string {
    return writeLockfile(this.buildLock(extraRefs), this.rootDir, lockPath);
  }

  /** Read `animation.lock` (null if absent). */
  readLock(lockPath: string = DEFAULT_LOCK_PATH): Lockfile | null {
    return readLockfile(this.rootDir, lockPath);
  }

  /**
   * Verify the live catalog resolution of `refs` against the on-disk lockfile. Surfaces
   * drift (a pinned version whose content changed) instead of silently re-rendering.
   * Throws if no lockfile exists (caller should `writeLock` to create one first).
   */
  verifyLock(
    refs: readonly string[],
    lockPath: string = DEFAULT_LOCK_PATH
  ): LockVerifyResult {
    const lock = this.readLock(lockPath);
    if (!lock) {
      throw new Error(
        `no lockfile at ${lockPath}; run writeLock() to pin resolved hashes first`
      );
    }
    return verifyAgainstLock(this.load(refs), lock);
  }
}
