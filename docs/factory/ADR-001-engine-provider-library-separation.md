# ADR-001 — Source-agnostic engine, pluggable providers, shareable library

**Date:** 2026-06-22 · **Status:** Accepted (target architecture; integrate into main spec after M2)

## Context

The prototype proved we can build animatable Kurzgesagt beings from code-generated shapes alone (vendor-free), and M1/M2 proved DragonBones rigs work. The directive: **keep it modular — source assets from anywhere (our procedural builder, DragonBones, or any future source), keep separation of concerns, keep the engine generic/configurable, and design the library/artifacts for reuse and sharing** (a future hosted/community service must not require re-architecting).

## Decision

Adopt a **layered, source-agnostic architecture** with four cleanly separated concerns. No layer reaches across the interface boundary of another.

```
┌───────────────────────────────────────────────────────────────┐
│ AUTHORING FRONT-ENDS   (YAML story now; LLM, GUI later)         │  → produce Story IR
├───────────────────────────────────────────────────────────────┤
│ IR / SPEC CONTRACT     (Story IR, Scene IR — Zod; the stable    │  ← the only thing
│                         interface; versioned & shareable)        │     everyone agrees on
├───────────────────────────────────────────────────────────────┤
│ ENGINE CORE  (generic)  timeline · compositor · camera/parallax │  knows layer CONTRACT,
│                         · shading/depth · effects/post · render  │  never provider internals
│                         host (Remotion) · determinism            │
├───────────────────────────────────────────────────────────────┤
│ PROVIDER LAYER (pluggable)  procedural · dragonbones · lottie ·  │  each implements the
│                         spine/svg-import/ai-gen (future)         │  AssetProvider interface
├───────────────────────────────────────────────────────────────┤
│ LIBRARY / REGISTRY (separate)  storage · content-addressing ·   │  engine depends on a thin
│                         versioning · sharing · provenance        │  resolver interface only
└───────────────────────────────────────────────────────────────┘
```

### 1. The engine is generic and knows nothing about asset *sources*

The engine core consumes the Scene IR and orchestrates timeline, camera/parallax, shading (§11.1), effects/post (§11), compositing, and the render host (Remotion) + determinism. For each layer it only knows a **contract**, not how the pixels are made. It hands each provider a **surface** to draw into and applies transform/camera/shading/compositing *around* that surface. Procedural shapes, a DragonBones canvas, and a Lottie player are all just "things that draw a frame into a surface."

### 2. Asset Source Provider interface (the plug)

Every source implements one interface. Adding a new source = adding a provider; **zero engine or IR changes.**

```ts
type Surface = { kind: 'svg' | 'canvas2d' | 'pixi'; mount: unknown }; // engine supplies this

interface AssetProvider {
  id: string;                       // 'procedural' | 'dragonbones' | 'lottie' | …
  kinds: LayerKind[];               // which Scene-IR layer kinds it serves (rig, generator, asset…)
  describe(ref, lib): AssetManifest;            // capabilities (see §3) — uniform across providers
  resolve(ref, lib): ResolvedHandle;            // name@version → content-addressed data via library
  instantiate(handle, params, seed): Instance;  // build a (re)usable instance
  render(inst, frame, surface, ctx): void;      // DRAW one frame deterministically into the surface
  dispose(inst): void;
}
```

**Hard rule — determinism (CLAUDE.md #1):** `render` MUST be a pure function of `(params, seed, frame)` and follow its backend's determinism recipe (e.g. the Pixi/WebGL provider uses swangle + preserveDrawingBuffer + synchronous gating; the procedural SVG provider is pure by construction).

Current sources map directly: **ProceduralProvider** (the shape-factory prototype), **DragonBonesProvider** (today's `RigLayer` refactored behind the interface), **LottieProvider** (ingest). Future: SpineProvider, SvgImportProvider, AiGenProvider (consumes offline AI-generated parts) — all peers.

### 3. Normalized manifest (uniform capabilities across all sources)

So the engine and authors treat every source identically, each entry self-describes via a manifest (generalizes §8.1's rig manifest to all providers):

```jsonc
{ "id":"birb", "version":"1.2.0", "provider":"procedural", "kinds":["rig"],
  "mounts":   { "handR":{…}, "head_top":{…} },     // attach points (inter-asset composition)
  "variants": { "palette":["warm","cool"], … },    // swappable axes
  "clips":    ["idle","blink","wave"],             // named animations
  "bounds":   { "w":172, "h":180 },                // for layout/shading silhouette
  "params":   { /* JSON-Schema of accepted params */ },
  "provenance": { "source":"procedural", "author":"@me", "license":"CC0" } }
```

### 4. Library / registry is a separate concern (storage ≠ engine)

The engine depends on a thin `LibraryResolver` (`resolve(name@version) → content hash + data`, `lock`, `list`), **not** on where things live. Today that's the local FS catalog + `animation.lock`. Tomorrow it can be a remote registry service implementing the same interface — **the engine never changes.**

### 5. Specification & definitions ARE library artifacts

Per the directive ("specification can be part of a library"): the **Story/Scene IR Zod schemas, the StyleKit, palettes, easing-sets, generator definitions, and provider manifests** are themselves versioned, content-addressed, shareable library entries — a "**spec pack**." A community author can install a spec pack and author against the exact same contract, or ship a creature/clip/environment that any compatible engine can render.

## Sharability & service-readiness (designed in now, hosted later)

These are deliberate so a future public/community service needs no re-architecting:

- **Content-addressing** (`object-hash`) → automatic dedup of identical assets *across users/tenants*, and a **deterministic render cache** keyed by content hash (a shared render is reusable across the community because output is byte-reproducible).
- **Namespacing** → `@author/name@semver` for entries; per-author/org isolation; conflict-free sharing.
- **Versioning + lockfile** → a shared project pins exact dependency hashes; improving an asset never breaks others' videos (opt-in upgrades).
- **License + provenance per entry** → safe redistribution; required for community/marketplace.
- **Bundle export/import** → a project + its pinned deps + assets serialize to a portable bundle (offline share now; publish/install later).
- **Future registry service** → `publish` / `install` behind the same `LibraryResolver`; multi-tenant storage, quotas, and attribution are registry concerns, **invisible to the engine**.
- **Local-first today** → everything works offline on a laptop; the service is an *optional* backend swap, not a rewrite.

## Consequences

- **Refactor (incremental, not now):** wrap M1/M2's `RigLayer` as `DragonBonesProvider`; wrap the prototype as `ProceduralProvider`; both behind `AssetProvider`. Scene IR `rig`/`generator` layers gain a `provider` field (defaulted/inferred for back-compat).
- **Engine stays generic:** shading/depth, camera, effects, determinism live in core and apply to *every* provider uniformly.
- **No primary source:** procedural and DragonBones are peers; choose per-asset. New sources are additive.
- **What must NOT happen:** provider-specific logic leaking into engine core, or storage/registry details leaking into the engine. Those are the boundaries that keep it future-proof.

## Follow-ups (after M2 lands, to avoid editing shared files mid-workflow)

- Fold this into the main spec (a new "Engine / Provider / Library separation" section) and add a CLAUDE.md golden rule ("source-agnostic engine; providers behind the `AssetProvider` interface; library/registry is a separate concern").
- Define `AssetProvider` + `LibraryResolver` as real TS interfaces in `src/` and migrate the two existing sources behind them.
- Specify the bundle/export format and the `LibraryResolver` remote variant.
