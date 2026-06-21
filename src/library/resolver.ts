// Resolver — maps `name@version` → content hash and reconciles it with `animation.lock` (spec §13.2).
//
// Responsibilities:
//   • parse a ref (`name@version`, optionally `kind://name@version`, with `#fragment`),
//   • find the catalog entry across namespaces,
//   • compute its content hash deterministically via `object-hash`,
//   • dedup repeated refs in a single resolve pass,
//   • read / write / verify `animation.lock` so past renders stay byte-stable.
//
// Determinism (CLAUDE.md golden rule 1): no wall-clock, no Math.random. The hash is a
// pure function of the entry's *content* (uri/format/manifest/deps/provenance) — id,
// version, and tags are deliberately excluded so a rename or re-tag cannot change a hash.

import objectHash from 'object-hash';
import type { Catalog, CatalogEntry } from './catalog.js';
import {
  type Lockfile,
  type LockEntry,
  LOCK_ALGORITHM,
  emptyLockfile,
} from './lockfile.js';

/** A parsed library reference. */
export interface ParsedRef {
  /** Original ref string. */
  raw: string;
  /** Optional scheme/kind from a `kind://…` URI form (e.g. 'rig', 'asset'). */
  scheme?: string;
  /** Entry id (the human name). */
  name: string;
  /** Requested semver. */
  version: string;
  /** Optional `#fragment` (e.g. `#path` for an SVG sub-path). */
  fragment?: string;
}

/** Canonical `name@version` key used in the catalog index and the lockfile. */
export function canonicalRef(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Parse a ref. Accepts:
 *   `name@1.0.0`
 *   `rig://name@1.0.0`
 *   `asset://name@1.0.0#path`
 * The scheme and fragment are informational; lookup keys on `name@version`.
 */
export function parseRef(ref: string): ParsedRef {
  let rest = ref;
  let scheme: string | undefined;
  const schemeIdx = rest.indexOf('://');
  if (schemeIdx !== -1) {
    scheme = rest.slice(0, schemeIdx);
    rest = rest.slice(schemeIdx + 3);
  }
  let fragment: string | undefined;
  const hashIdx = rest.indexOf('#');
  if (hashIdx !== -1) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }
  const at = rest.lastIndexOf('@');
  if (at <= 0) {
    throw new Error(`invalid library ref "${ref}": expected "name@version"`);
  }
  const name = rest.slice(0, at);
  const version = rest.slice(at + 1);
  if (!name || !version) {
    throw new Error(`invalid library ref "${ref}": empty name or version`);
  }
  const parsed: ParsedRef = { raw: ref, name, version };
  if (scheme !== undefined) parsed.scheme = scheme;
  if (fragment !== undefined) parsed.fragment = fragment;
  return parsed;
}

/** A catalog entry plus the namespace it was found in. */
export interface LocatedEntry {
  namespace: string;
  entry: CatalogEntry;
}

/**
 * Find an entry by name+version across all catalog namespaces. Throws if missing or
 * if the same name+version appears in two namespaces (an ambiguous catalog is a bug).
 */
export function locateEntry(
  catalog: Catalog,
  name: string,
  version: string
): LocatedEntry {
  const matches: LocatedEntry[] = [];
  for (const [namespace, ns] of Object.entries(catalog.entries)) {
    const entry = ns[name];
    if (entry && entry.version === version) {
      matches.push({ namespace, entry });
    }
  }
  if (matches.length === 0) {
    throw new Error(
      `library entry not found: ${canonicalRef(name, version)} (no namespace has this id@version)`
    );
  }
  if (matches.length > 1) {
    const where = matches.map((m) => m.namespace).join(', ');
    throw new Error(
      `ambiguous library entry ${canonicalRef(name, version)}: present in [${where}]`
    );
  }
  // Exactly one match — narrowed and guaranteed defined.
  return matches[0]!;
}

/**
 * Compute the content hash of an entry. Pure function of the entry's *content*:
 * uri, format, manifest, deps, provenance, and kind. `id`, `version`, and `tags`
 * are excluded so renames/re-tags don't churn hashes. `object-hash` canonicalizes
 * key order, so the hash is stable regardless of JSON field ordering.
 */
export function hashEntry(entry: CatalogEntry): string {
  const content = {
    kind: entry.kind,
    format: entry.format ?? null,
    uri: entry.uri ?? null,
    deps: [...entry.deps].sort(),
    manifest: entry.manifest ?? null,
    provenance: entry.provenance ?? null,
  };
  return objectHash(content, { algorithm: 'sha1', encoding: 'hex' });
}

/** A fully resolved entry: located + content-hashed + canonical key. */
export interface ResolvedEntry extends LocatedEntry {
  ref: ParsedRef;
  key: string;
  hash: string;
}

/**
 * Resolve a single ref against the catalog: locate + hash. Does not touch the lockfile.
 */
export function resolveRef(catalog: Catalog, ref: string): ResolvedEntry {
  const parsed = parseRef(ref);
  const located = locateEntry(catalog, parsed.name, parsed.version);
  return {
    ...located,
    ref: parsed,
    key: canonicalRef(parsed.name, parsed.version),
    hash: hashEntry(located.entry),
  };
}

/**
 * Resolve many refs, deduping repeated `name@version`. Returns a Map keyed by canonical
 * `name@version`, so a ref used N times resolves (and hashes) exactly once (spec §13.2 dedup).
 * Insertion order follows first occurrence, keeping resolution deterministic.
 */
export function resolveRefs(
  catalog: Catalog,
  refs: readonly string[]
): Map<string, ResolvedEntry> {
  const out = new Map<string, ResolvedEntry>();
  for (const ref of refs) {
    const parsed = parseRef(ref);
    const key = canonicalRef(parsed.name, parsed.version);
    if (out.has(key)) continue; // dedup: already resolved this name@version.
    out.set(key, resolveRef(catalog, ref));
  }
  return out;
}

/** Build a lockfile from a set of resolved entries (deterministic key order). */
export function buildLockfile(resolved: Map<string, ResolvedEntry>): Lockfile {
  const lock = emptyLockfile();
  for (const key of [...resolved.keys()].sort()) {
    const r = resolved.get(key)!;
    const entry: LockEntry = {
      namespace: r.namespace,
      id: r.entry.id,
      version: r.entry.version,
      hash: r.hash,
      deps: [...r.entry.deps].sort(),
    };
    lock.refs[key] = entry;
  }
  return lock;
}

/** Result of verifying live resolution against an existing lockfile. */
export interface LockVerifyResult {
  ok: boolean;
  /** keys present in the lock but missing from current resolution. */
  missing: string[];
  /** keys whose hash drifted: [key, lockedHash, currentHash]. */
  drifted: Array<{ key: string; locked: string; current: string }>;
  /** keys resolved now but absent from the lock. */
  added: string[];
}

/**
 * Verify a freshly-resolved set against a lockfile. A `drifted` hash means a library
 * entry changed content under a pinned version — a determinism violation that must be
 * surfaced (never silently accepted), per spec §13.2.
 */
export function verifyAgainstLock(
  resolved: Map<string, ResolvedEntry>,
  lock: Lockfile
): LockVerifyResult {
  if (lock.algorithm !== LOCK_ALGORITHM) {
    // A different hashing scheme can't be meaningfully compared; treat all as drift.
    return {
      ok: false,
      missing: Object.keys(lock.refs),
      drifted: [],
      added: [...resolved.keys()],
    };
  }
  const missing: string[] = [];
  const drifted: LockVerifyResult['drifted'] = [];
  const added: string[] = [];
  for (const [key, locked] of Object.entries(lock.refs)) {
    const cur = resolved.get(key);
    if (!cur) {
      missing.push(key);
      continue;
    }
    if (cur.hash !== locked.hash) {
      drifted.push({ key, locked: locked.hash, current: cur.hash });
    }
  }
  for (const key of resolved.keys()) {
    if (!(key in lock.refs)) added.push(key);
  }
  return {
    ok: missing.length === 0 && drifted.length === 0 && added.length === 0,
    missing,
    drifted,
    added,
  };
}
