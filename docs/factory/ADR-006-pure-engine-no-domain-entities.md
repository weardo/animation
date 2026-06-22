# ADR-006 — The engine specializes in NOTHING: purge domain entities (character) from core

**Date:** 2026-06-22 · **Status:** Accepted — refinement of ADR-005. Implement next.

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

## Backlog item

**Engine purification** (next): drop `characterStyles` → `providers`; move `CharacterSpec`/`characterMarkup`/factory into `plugins/blob-creature/`; make the IR rig `spec` opaque + rig def `{provider, spec}`; thin generic source-material CLI dispatching to the plugin; re-lower/verify all demos byte-identical. After this, the core has no domain entity.
