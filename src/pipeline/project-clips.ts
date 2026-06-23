// project-clips.ts — PROJECT-LOCAL clip/rig definitions (the project-internal reuse level; CLAUDE.md
// golden rule 6). A project is a PORTABLE, self-contained directory (like a traditional video-edit
// project file): its own reusable objects ("rigs") are clip defs that live in
// `<projectDir>/rigs/<name>.clip.{yaml,yml,json}` — NOT shared-library entries. This wraps a LibraryLike
// so `toClip(ref)` resolves a project-local rig FIRST (by name, relative to the project dir WHEREVER it
// is on disk), falling back to the shared `library/` (the opt-in publish/import level) for anything not
// found locally. Every other resolver delegates unchanged.
//
// Compile-time pure I/O (read + Zod-parse a def file) → deterministic. DOMAIN-CLEAN: generic clip loading,
// no rig/subject name hardcoded.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ClipDefSchema, type ClipDef } from '../ir/index.js';
import type { LibraryLike } from './lower.js';

/** The rig-def file extensions tried, in order (YAML preferred for hand-authoring; JSON also accepted). */
const RIG_EXTS = ['.clip.yaml', '.clip.yml', '.clip.json'] as const;

/**
 * Read a project-local rig def `<projectDir>/rigs/<name>.clip.{yaml,yml,json}` → a validated ClipDef,
 * or `undefined` if the project declares no such local rig (caller falls back to the shared library).
 */
export function loadLocalClip(projectDir: string, ref: string): ClipDef | undefined {
  const name = (ref.split('@')[0] ?? '').trim(); // strip an optional `@version`
  if (!name) return undefined;
  for (const ext of RIG_EXTS) {
    const p = resolvePath(projectDir, 'rigs', `${name}${ext}`);
    if (existsSync(p)) {
      const text = readFileSync(p, 'utf8');
      const raw = ext === '.clip.json' ? (JSON.parse(text) as unknown) : (parseYaml(text) as unknown);
      return ClipDefSchema.parse(raw);
    }
  }
  return undefined;
}

/**
 * True if `ref` names a PROJECT-LOCAL rig (a `<projectDir>/rigs/<name>.clip.*` file exists). Used to
 * exclude project-local rigs from the library lockfile — they travel INSIDE the project bundle (in
 * `rigs/`), so they are not library deps to pin.
 */
export function isLocalClip(projectDir: string, ref: string): boolean {
  const name = (ref.split('@')[0] ?? '').trim();
  if (!name) return false;
  return RIG_EXTS.some((ext) => existsSync(resolvePath(projectDir, 'rigs', `${name}${ext}`)));
}

/**
 * Wrap a {@link LibraryLike} so clip refs resolve PROJECT-LOCALLY first (a portable project's own
 * `rigs/`), then fall back to the shared library. All other resolvers delegate to `library` unchanged.
 * This is the project-internal reuse path: define a rig once in the project, instance it N times across
 * its scenes, never touching `library/`.
 */
export function withLocalClips(library: LibraryLike, projectDir: string): LibraryLike {
  return {
    toAssetDef: (r) => library.toAssetDef(r),
    toRigDef: (r) => library.toRigDef(r),
    ...(library.toStyleKit ? { toStyleKit: (r: string) => library.toStyleKit!(r) } : {}),
    ...(library.toPalette ? { toPalette: (r: string) => library.toPalette!(r) } : {}),
    ...(library.expandGeneratorRef
      ? { expandGeneratorRef: (g: string, p?: Record<string, unknown>) => library.expandGeneratorRef!(g, p) }
      : {}),
    ...(library.hashOf ? { hashOf: (r: string) => library.hashOf!(r) } : {}),
    toClip: (ref: string): ClipDef => {
      const local = loadLocalClip(projectDir, ref);
      if (local) return local;
      if (library.toClip) return library.toClip(ref);
      throw new Error(`clip '${ref}' not found in the project's rigs/ nor the shared library`);
    },
  };
}
