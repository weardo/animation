// Disk I/O for the library layer: load + validate `library/index.json`, read/write `animation.lock`.
//
// No network (CLAUDE.md: local-first). All paths are explicit so the library layer stays a pure
// function of its inputs; callers (P2 resolver pass / CLI) pass the project + library roots.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { CatalogSchema, type Catalog } from './catalog.js';
import { LockfileSchema, type Lockfile } from './lockfile.js';

/** Default on-disk locations relative to a root dir. */
export const DEFAULT_CATALOG_PATH = 'library/index.json';
export const DEFAULT_LOCK_PATH = 'animation.lock';

/** Validate raw parsed JSON into a typed Catalog (throws with a readable message). */
export function parseCatalog(raw: unknown, source = '<catalog>'): Catalog {
  const result = CatalogSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid library catalog (${source}):\n${detail}`);
  }
  return result.data;
}

/** Load + validate the catalog from `library/index.json` under `rootDir`. */
export function loadCatalog(
  rootDir = process.cwd(),
  catalogPath = DEFAULT_CATALOG_PATH
): Catalog {
  const full = resolvePath(rootDir, catalogPath);
  if (!existsSync(full)) {
    throw new Error(`library catalog not found: ${full}`);
  }
  const text = readFileSync(full, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`library catalog is not valid JSON (${full}): ${(e as Error).message}`);
  }
  return parseCatalog(raw, full);
}

/** Validate raw parsed JSON into a typed Lockfile. */
export function parseLockfile(raw: unknown, source = '<lockfile>'): Lockfile {
  const result = LockfileSchema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`invalid animation.lock (${source}):\n${detail}`);
  }
  return result.data;
}

/** True if a lockfile exists under `rootDir`. */
export function lockfileExists(
  rootDir = process.cwd(),
  lockPath = DEFAULT_LOCK_PATH
): boolean {
  return existsSync(resolvePath(rootDir, lockPath));
}

/** Read + validate `animation.lock`; returns null if it does not exist. */
export function readLockfile(
  rootDir = process.cwd(),
  lockPath = DEFAULT_LOCK_PATH
): Lockfile | null {
  const full = resolvePath(rootDir, lockPath);
  if (!existsSync(full)) return null;
  const text = readFileSync(full, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`animation.lock is not valid JSON (${full}): ${(e as Error).message}`);
  }
  return parseLockfile(raw, full);
}

/**
 * Write `animation.lock` deterministically: keys are pre-sorted by the resolver, and we
 * serialize with stable 2-space JSON + trailing newline so the file is diff-friendly and
 * byte-stable across runs.
 */
export function writeLockfile(
  lock: Lockfile,
  rootDir = process.cwd(),
  lockPath = DEFAULT_LOCK_PATH
): string {
  const full = resolvePath(rootDir, lockPath);
  const json = JSON.stringify(lock, null, 2) + '\n';
  writeFileSync(full, json, 'utf8');
  return full;
}
