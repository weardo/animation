# ADR-006 — The engine specializes in NOTHING: purge domain entities (character) from core

**Date:** 2026-06-22 · **Status:** DONE 2026-06-22 — refinement of ADR-005, implemented. Engine specializes in nothing; core has zero `character`/`CharacterSpec`/`style` refs; `blob-creature` is a provider plugin owning its CharacterSpec. All demos re-lowered + byte-identical across cold processes (blob-creature + dragonbones provider paths).

## Context

ADR-005 made *capability* pluggable, but the engine still hardcodes a **domain entity**:
- `characterStyles` is a **character-specific extension point** in the core registry set.
- `CharacterSpec` + `characterMarkup` live in `src/factory/` (core-adjacent).
- `factory-gen` is a **character-specific CLI**.

A generated video is **not necessarily a character video** — it may be an infographic, a chart, a still, pure abstract motion, a data-viz sequence. The engine must therefore know nothing about "character" (or "scene type", or any specific subject). It composites **generic layers** on a timeline, deterministically — nothing more. Domain meaning ("this is a character", "this is a chart") lives in **plugins (code)** and **library entries (data)**, never in core.

## Decision

1. **Remove the `characterStyles` extension point.** A "character style" is just a **provider** that renders a rig/provider layer from an opaque spec. Collapse it into the generic **`providers`** registry (rename `rigProviders` → `providers`). `blob-creature`, `dragonbones`, and any future `chart` / `infographic-widget` / `diagram` are all *providers* — peers. The engine sees only: *a `rig` layer → a provider id + an opaque `spec` → the provider renders it.* No "character", no "style" in core.

2. **Move `CharacterSpec`, `characterMarkup`, and the factory builder OUT of core** (`src/factory/`) **into the `blob-creature` plugin.** The core IR's rig-layer `spec` is **opaque** (`z.record(unknown)`); the *provider* validates + interprets it. Core has **zero `CharacterSpec` references**. (`src/factory/` ceases to exist as a core module.)

3. **The factory becomes plugin-owned source-material tooling.** `factory-gen` (spec → library entry + preview) is *how the blob-creature plugin generates its source material* — not a core CLI. Generalize the concept: **any provider plugin MAY ship a source-material generator**. A thin generic CLI can dispatch to the active plugin's generator; the character specifics live in the plugin.

4. **Keep the wire-compatible surface to avoid breaking committed projects:** the `rig` layer type, `defs.rigs`, and the `library/characters/` namespace stay (data organization). But they are domain-NEUTRAL: a `rig` is "a provider-rendered animatable layer", `defs.rigs[ref]` carries `{ provider, spec }` (was `{ kind, spec }` with a separate `style`), and `characters/` is just one library namespace among many.

## What "core" knows after this

Generic layer kinds only: `asset` · `shape` · `text` · `generator` · `rig` (provider-rendered) · `clip`. Plus timeline, camera/parallax, shading, determinism, the IR contract, and the plugin extension-point registries (`generators`, `providers`, `effects`, `transitions`, `layerTypes`, `passes`). **No `character`, no `style`, no `CharacterSpec`, no scene-type, no subject.** Everything domain-specific is a plugin contribution + library data.

## Consequences

- The engine is now a **pure generic compositor** — an infographic/chart/still pipeline drops in as plugins with zero core change, exactly like a character does.
- `blob-creature` is just the *first* provider; the factory pattern (spec → library entry) is reusable by every provider plugin (a chart plugin ships a `ChartSpec` + its own generator).
- Confirms the layering: **core (generic) · plugins (capability/code) · library (content/data)** — with no domain leakage into core. Generalizes ADR-001/004/005 to their endpoint.

## Implementation (DONE 2026-06-22)

- **Engine:** the `characterStyles` extension point is gone; `rigProviders` → one generic **`providers`** registry. `EngineAPI` drops `registerCharacterStyle`; exposes `registerProvider(id, component)` (provider id, not "style"). The 4 stub registries (`effects`/`transitions`/`layerTypes`/`passes`) are unchanged.
- **Out of core:** `src/factory/` is **deleted**. Its `spec.ts` (CharacterSpec) + `character.ts` (`characterMarkup`) moved into `plugins/blob-creature/` (`spec.ts`, `character.ts`). The provider renderer (`plugins/blob-creature/renderer.tsx`, formerly `src/render/ProceduralRig.tsx`) takes the rig layer's OPAQUE spec, validates it with the plugin's OWN `CharacterSpec` (Zod), and renders. `src/ir` has ZERO CharacterSpec import — `RigDef.spec` is `z.record(unknown)`.
- **IR + consumers:** `RigDef` = `{ uri, provider, spec? }` (was `{ uri, kind, spec }` + `spec.style`). `library/loader.ts` sets `provider` from the catalog entry (`provider` field, else derived: `format:'procedural'` → `blob-creature`, else `dragonbones`) and embeds the opaque spec for blob-creature. `src/render/Scene.tsx` rig dispatch → `providers.get(rigDef.provider)`. `core-rigs` registers the vendor renderer under `dragonbones`.
- **Factory:** the character-specific generator moved to `plugins/blob-creature/generator.ts` (CharacterSpec → library entry + preview). `src/cli/factory-gen.ts` is a thin CLI that dispatches to the active provider plugin's `generate(...)`.
- **Wire-compat:** the `rig` layer type, `defs.rigs`, and `library/characters/` namespace stay (data org). All 6 demo projects re-lowered so their `scene.json` carries the new `{provider, spec}` rig def.
- **Verify:** `render <project> --frames auto` (CPU raster), cross-process `cmp` of stills → byte-identical for the blob-creature provider (blip-intro) across two cold processes; dragonbones provider (neuron-demo) renders correctly; typecheck clean.
