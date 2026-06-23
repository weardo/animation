// ADR-001 formal interfaces (M7a) — the two boundary contracts ADR-001 reserved as TS types.
//
// ADR-001 §2 (the AssetProvider "plug") and §4 (the thin LibraryResolver) describe the seams that
// keep the engine source-agnostic and storage-agnostic. The behavior already exists in this layer's
// loader/resolver; these interfaces make the seams EXPLICIT so an alternate backend (a remote
// registry, a different ref→def adapter) is a drop-in implementation, not a refactor.
//
// IMPORTANT — these are descriptive, not prescriptive: they formalize the EXISTING `Library`
// behavior verbatim (no new behavior, no signature drift). `Library implements AssetRefResolver,
// LibraryResolver` is a compile-time assertion that the loader already honors both contracts.
//
// Two scopes, matching ADR-001's two boxes:
//   • {@link LibraryResolver}  ← ADR-001 §4 "Library / registry is a separate concern (storage ≠
//     engine)": catalog lookup `name@version → content hash + data`, lockfile pin/verify, dedup.
//     The engine depends on THIS thin interface, never on where things live (local FS today, a
//     remote registry tomorrow — same interface, zero engine change).
//   • {@link AssetRefResolver}  ← ADR-001 §2/§5 the library-side of the AssetProvider plug: adapt a
//     resolved catalog entry/URI to a CONCRETE Scene-IR def (RigDef/AssetDef) or a validated spec-pack
//     artifact (StyleKit/Palette/ClipDef/GeneratorPreset). This is the `proc://`-embedding +
//     provider-from-catalog + `toStyleKit`/`toClip`/… behavior, keyed on the URI SCHEME (data), so
//     core names no provider/look/clip. (ADR-001 §2's render-time `instantiate`/`render`/`dispose`
//     live in the PROVIDER PLUGINS — `providers.get(id)` — per ADR-005/006/007; this interface is
//     the LIBRARY half: ref → def, which is what `src/library` owns.)

import type { AssetDef, RigDef, ClipDef, Palette, StyleKit } from '../ir/index.js';
import type { Catalog, GeneratorPreset } from './catalog.js';
import type { ResolvedEntry, LockVerifyResult } from './resolver.js';
import type { Lockfile } from './lockfile.js';

/**
 * ADR-001 §4 — the thin library/registry seam the engine depends on. Maps a human `name@version`
 * ref to a content-addressed, deduped {@link ResolvedEntry} (location + hash), and pins/verifies
 * those resolutions against `animation.lock` for byte-stable re-renders. No network is implied:
 * the FS catalog satisfies it today; a remote registry could satisfy the same contract tomorrow.
 */
export interface LibraryResolver {
  /** The loaded catalog this resolver reads (`library/index.json` shape). */
  readonly catalog: Catalog;

  /** Resolve a single `name@version` ref to its located + content-hashed entry (deduped). */
  get(ref: string): ResolvedEntry;

  /** Resolve many refs at once, deduping; returns a Map keyed by canonical `name@version`. */
  load(refs: readonly string[]): Map<string, ResolvedEntry>;

  /** The content hash (the `cache://sha…` address) for a ref. */
  hashOf(ref: string): string;

  /** Build a lockfile pinning the currently-resolved set, plus any extra refs. */
  buildLock(extraRefs?: readonly string[]): Lockfile;

  /** Build + write `animation.lock`; returns the absolute path written. */
  writeLock(extraRefs?: readonly string[], lockPath?: string): string;

  /** Read `animation.lock` (null if absent). */
  readLock(lockPath?: string): Lockfile | null;

  /** Verify live resolution of `refs` against the on-disk lockfile (surfaces hash drift). */
  verifyLock(refs: readonly string[], lockPath?: string): LockVerifyResult;
}

/**
 * ADR-001 §2/§5 (library half) — adapt a resolved library ref/URI to a CONCRETE Scene-IR def or a
 * validated spec-pack artifact. Each method keys on the entry KIND + URI SCHEME (a data convention,
 * e.g. `proc://` / `stylekit://` / `clip://` / `palette://` / `preset://`), so the engine core names
 * no provider, look, or clip. This is exactly the existing loader behavior: `provider`-from-catalog,
 * `proc://` sidecar-spec embedding, and the `toStyleKit`/`toClip`/`toPalette`/`toGeneratorPreset`
 * spec-pack resolvers (ADR-001 §5 — "definitions ARE library artifacts").
 */
export interface AssetRefResolver {
  /** Adapt a resolved `rig` entry to the Scene-IR {@link RigDef} (provider id + opaque spec + mounts). */
  toRigDef(ref: string): RigDef;

  /** Adapt a resolved `asset` entry to the Scene-IR {@link AssetDef} (svg/image/lottie/video). */
  toAssetDef(ref: string): AssetDef;

  /** Resolve a `stylekit` entry to a validated {@link StyleKit} (ADR-008 spec-pack artifact). */
  toStyleKit(ref: string): StyleKit;

  /** Resolve a `clip` entry to a validated {@link ClipDef} (nested-composition spec-pack artifact). */
  toClip(ref: string): ClipDef;

  /** Resolve a `palette` entry to a validated {@link Palette} token map (color-script artifact). */
  toPalette(ref: string): Palette;

  /** Resolve a `generator-preset` entry to its validated {@link GeneratorPreset} body (ADR-004). */
  toGeneratorPreset(ref: string): GeneratorPreset;

  /** Expand a `generator.gen` value (bare impl name OR preset ref) to a concrete `{ gen, params }`. */
  expandGeneratorRef(
    genRef: string,
    layerParams?: Record<string, unknown>,
  ): { gen: string; params: Record<string, unknown> };
}
