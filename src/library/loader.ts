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

import { readFileSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { AssetDef, RigDef, ClipDef, Palette } from '../ir/index.js';
import { StyleKitSchema, ClipDefSchema, PaletteSchema, type StyleKit } from '../ir/index.js';
import type { Catalog, GeneratorPreset } from './catalog.js';
import { GeneratorPresetSchema } from './catalog.js';
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
    // Carry the rig's declared MOUNT points (spec §8.1) from the library manifest into the Scene-IR
    // rig def as DATA, so the compositor can resolve an `attach.bone`/`attach.slot` to a position
    // without poking the provider's internals (a rig stays a typed black box). Absent → no mounts.
    const mounts =
      r.entry.manifest && Object.keys(r.entry.manifest.mounts).length > 0
        ? r.entry.manifest.mounts
        : undefined;
    if (r.entry.uri.startsWith('proc://')) {
      // A `proc://` entry inlines its sidecar spec. The spec lives co-located with the entry under its
      // namespace dir: `library/<ns>/<id>/<id>.spec.json`. Core knows no provider→namespace mapping, so
      // we search the known catalog namespaces (a data convention) and embed the first match; if none
      // exists the provider falls back to its own default spec (e.g. core-objects' STAR_SPEC).
      const id = r.entry.uri.replace(/^proc:\/\//, '').split('/')[0] ?? '';
      const NAMESPACES = ['characters', 'props', 'objects'] as const;
      for (const ns of NAMESPACES) {
        const specPath = resolvePath(this.rootDir, 'library', ns, id, `${id}.spec.json`);
        if (existsSync(specPath)) {
          const spec = JSON.parse(readFileSync(specPath, 'utf8')) as Record<string, unknown>;
          return { uri: r.entry.uri, provider, spec, ...(mounts ? { mounts } : {}) };
        }
      }
      return { uri: r.entry.uri, provider, ...(mounts ? { mounts } : {}) };
    }
    return { uri: r.entry.uri, provider, ...(mounts ? { mounts } : {}) };
  }

  /** Adapt a resolved asset entry to the Scene-IR `AssetDef` shape (src/ir). */
  toAssetDef(ref: string): AssetDef {
    const r = this.get(ref);
    if (r.entry.kind !== 'asset') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'asset'`);
    }
    if (!r.entry.uri) throw new Error(`asset entry ${r.key} has no uri`);
    const fmt = r.entry.format;
    // The asset formats the renderer understands (AssetDef.kind enum): static art (svg/image) and the
    // two frame-seeked FOOTAGE media kinds (lottie / video). `video` backs the byte-DETERMINISTIC footage
    // path (`<OffthreadVideo>`); `lottie` is the vector path (perceptual — lottie-web is not bit-exact in
    // Remotion's parallel-tab video render, per upstream, so the determinism-gated demo uses `video`).
    if (fmt !== 'svg' && fmt !== 'lottie' && fmt !== 'image' && fmt !== 'video') {
      throw new Error(`asset entry ${r.key} has unsupported format '${fmt ?? '<none>'}'`);
    }
    return { uri: r.entry.uri, kind: fmt };
  }

  /**
   * Resolve a `stylekit` entry to a validated {@link StyleKit} (ADR-008 I2). The catalog entry's URI
   * is the engine-generic `stylekit://<name>` convention: the JSON DATA lives co-located at
   * `library/stylekits/<name>.json` and is parsed with the StyleKit schema. Like `proc://` for rigs,
   * the lookup keys on the URI SCHEME (a data convention), never on any look name in core.
   */
  toStyleKit(ref: string): StyleKit {
    // Default an unversioned ref (e.g. "kurzgesagt") to `@1.0.0`, mirroring the rig/asset paths, so a
    // bare `style: kurzgesagt` in the story resolves against the catalog.
    const r = this.get(ref.includes('@') ? ref : `${ref}@1.0.0`);
    if (r.entry.kind !== 'stylekit') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'stylekit'`);
    }
    if (!r.entry.uri) throw new Error(`stylekit entry ${r.key} has no uri`);
    if (!r.entry.uri.startsWith('stylekit://')) {
      throw new Error(`stylekit entry ${r.key} has unsupported uri '${r.entry.uri}' (expected stylekit://<name>)`);
    }
    const name = r.entry.uri.replace(/^stylekit:\/\//, '').split('/')[0] ?? '';
    const path = resolvePath(this.rootDir, 'library', 'stylekits', `${name}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return StyleKitSchema.parse(raw);
  }

  /**
   * Resolve a `clip` entry to a validated {@link ClipDef} (M2 nested composition). Mirrors
   * {@link toStyleKit}: the catalog entry's URI is the engine-generic `clip://<name>` convention; the
   * JSON DATA lives co-located at `library/clips/<name>/<name>.clip.json` and is parsed with
   * {@link ClipDefSchema}. The lookup keys on the URI SCHEME (a data convention), never on any clip
   * name in core. The resolved def is the SHARED precomp the lowering pass stores once in
   * `defs.clips[ref]` (the Lottie `assets` precomp model).
   */
  toClip(ref: string): ClipDef {
    // Default an unversioned ref (e.g. "lower-third") to `@1.0.0`, mirroring the rig/asset/stylekit
    // paths, so a bare `clip: lower-third` in the story resolves against the catalog.
    const r = this.get(ref.includes('@') ? ref : `${ref}@1.0.0`);
    if (r.entry.kind !== 'clip') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'clip'`);
    }
    if (!r.entry.uri) throw new Error(`clip entry ${r.key} has no uri`);
    if (!r.entry.uri.startsWith('clip://')) {
      throw new Error(`clip entry ${r.key} has unsupported uri '${r.entry.uri}' (expected clip://<name>)`);
    }
    const name = r.entry.uri.replace(/^clip:\/\//, '').split('/')[0] ?? '';
    const path = resolvePath(this.rootDir, 'library', 'clips', name, `${name}.clip.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return ClipDefSchema.parse(raw);
  }

  /**
   * Resolve a `palette` entry to a validated {@link Palette} token map (color-script, spec §11.4).
   * Mirrors {@link toStyleKit}/{@link toClip}: the catalog entry's URI is the engine-generic
   * `palette://<name>` convention; the JSON DATA lives co-located at `library/palettes/<name>.json`
   * (a flat `{ token: color }` map) and is parsed with {@link PaletteSchema}. The lookup keys on the
   * URI SCHEME (a data convention), never on any mood name in core. The resolved tokens are merged
   * over the stylekit base by the lowering color-script pass to form a beat's scene palette.
   */
  toPalette(ref: string): Palette {
    // Default an unversioned ref (e.g. "warm") to `@1.0.0`, mirroring the other resolvers.
    const r = this.get(ref.includes('@') ? ref : `${ref}@1.0.0`);
    if (r.entry.kind !== 'palette') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'palette'`);
    }
    if (!r.entry.uri) throw new Error(`palette entry ${r.key} has no uri`);
    if (!r.entry.uri.startsWith('palette://')) {
      throw new Error(`palette entry ${r.key} has unsupported uri '${r.entry.uri}' (expected palette://<name>)`);
    }
    const name = r.entry.uri.replace(/^palette:\/\//, '').split('/')[0] ?? '';
    const path = resolvePath(this.rootDir, 'library', 'palettes', `${name}.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return PaletteSchema.parse(raw);
  }

  /**
   * Resolve a `generator-preset` entry to its validated {@link GeneratorPreset} body (ADR-004 §2).
   * Mirrors {@link toClip}/{@link toPalette}: the catalog entry's URI is the engine-generic
   * `preset://<name>` convention; the JSON DATA lives co-located at
   * `library/generators/<name>.preset.json` and is parsed with {@link GeneratorPresetSchema}. The
   * lookup keys on the URI SCHEME (a data convention), never on any generator name in core. The
   * returned `{ gen, params }` is what {@link expandGeneratorRef} merges with a layer's own args.
   */
  toGeneratorPreset(ref: string): GeneratorPreset {
    // Default an unversioned ref (e.g. "starfield") to `@1.0.0`, mirroring the other resolvers.
    const r = this.get(ref.includes('@') ? ref : `${ref}@1.0.0`);
    if (r.entry.kind !== 'generator-preset') {
      throw new Error(`ref ${r.key} is kind '${r.entry.kind}', expected 'generator-preset'`);
    }
    if (!r.entry.uri) throw new Error(`generator-preset entry ${r.key} has no uri`);
    if (!r.entry.uri.startsWith('preset://')) {
      throw new Error(
        `generator-preset entry ${r.key} has unsupported uri '${r.entry.uri}' (expected preset://<name>)`
      );
    }
    const name = r.entry.uri.replace(/^preset:\/\//, '').split('/')[0] ?? '';
    const path = resolvePath(this.rootDir, 'library', 'generators', `${name}.preset.json`);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return GeneratorPresetSchema.parse(raw);
  }

  /**
   * Expand a Scene-IR `generator.gen` value to a concrete `{ gen, params }` pair (ADR-004 §2,
   * resolver expansion). The value is EITHER:
   *   • a bare generator IMPLEMENTATION name (e.g. `"scatter"`) — passed through as `{ gen, params:{} }`;
   *   • a `generator-preset` ref (e.g. `"starfield@1.0.0"` / bare `"starfield"`) — resolved via
   *     {@link toGeneratorPreset} to its locked `{ gen, params }`.
   * Disambiguation keys on the CATALOG (data), not on any name list in core: a ref that locates to a
   * `generator-preset` entry is expanded; anything else (a bare impl name, or an unknown ref the
   * generator registry will validate) passes straight through. `layerParams` are merged OVER the
   * preset's params (preset = defaults, the authored layer args win) — a shallow, deterministic merge.
   */
  expandGeneratorRef(
    genRef: string,
    layerParams: Record<string, unknown> = {}
  ): { gen: string; params: Record<string, unknown> } {
    // Probe the catalog: is this ref a generator-preset entry? If it doesn't resolve (bare impl name
    // with no catalog entry) or isn't a preset, treat it as a pass-through implementation name.
    let isPreset = false;
    try {
      const r = this.get(genRef.includes('@') ? genRef : `${genRef}@1.0.0`);
      isPreset = r.entry.kind === 'generator-preset';
    } catch {
      isPreset = false; // not in catalog → bare implementation name.
    }
    if (!isPreset) return { gen: genRef, params: { ...layerParams } };
    const preset = this.toGeneratorPreset(genRef);
    // Preset params are defaults; the layer's own args override (most specific wins).
    return { gen: preset.gen, params: { ...preset.params, ...layerParams } };
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
