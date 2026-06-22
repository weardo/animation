# ADR-005 — Plugin architecture: minimal core, capability via plugins, data in the library

**Date:** 2026-06-22 · **Status:** Accepted — the unifying architecture. Generalizes ADR-001 (providers) and ADR-004 (generators). **Foundation DONE (2026-06-22)** — see "Foundation status" below; the rest of the backlog (effects/transitions/text/color/styles capability + presets) is now authored AS PLUGINS.

## Foundation status (DONE — 2026-06-22)

The minimal plugin system is built and dogfooded; all six committed demos render byte-identically. Shipped:
- **Engine core** (`src/engine/`): a generic `Registry<T>` (register/has/names/`get`-throws-loudly) · the seven extension-point registries (3 live + 4 stubs) · the `EngineAPI` plugins register through · the `Plugin`/`plugin.json` Zod-validated manifest contract · the `loadPlugins` loader (manifest re-validate → topological `deps` order → `register(api)`) · the `ENABLED_PLUGINS` config.
- **Built-ins migrated to CORE PLUGINS** (`plugins/`): **core-generators** (bead-string/scatter/water/particles/fire/crowd → `generators`), **core-rigs** (procedural + dragonbones → `rigProviders`), **blob-creature** (the default character style = `characterMarkup` → `characterStyles`). The old hardcoded seams now delegate to the engine registries: `src/generators/registry.ts` is a thin delegate; `src/render/Scene.tsx` resolves the rig `kind` via `rigProviders.get`; `ProceduralRig`/`factory-gen` resolve the style via `characterStyles.get(spec.style)` (CharacterSpec gained an optional `style` field defaulting to `blob-creature`). The Remotion bundle entry (`src/render/index.ts`) and `factory-gen` call `loadPlugins()` before render so runtime + offline resolve capability identically.
- **STUBS left empty** (no contributors, no consumers): `effects` · `transitions` · `layerTypes` · `passes`. Defined with the right shape so future backlog items plug in without a core change. NOT implemented.
- **Verified** (`verify-render`): `tsc --noEmit` clean; the five committed projects (blip-intro, blip-story, generators-demo, scatter-demo, shapes-demo) + neuron-demo (dragonbones provider) render byte-identically across two SEPARATE cold processes (caches cleared between); the pip factory preview PNG is byte-identical (only the spec's new `style` field changes its hash).

## Context

Editors/3D tools (Blender add-ons, OBS plugins, DaVinci OFX) keep a **small generic core** and extend *capability* through **plugins** that carry the logic for generation / effects / animation / config. The core never has to cover everything. We want the same: the engine stays minimal; new abilities (a character style, an effect, a generator, a transition, a pipeline pass) are **plugins**, and many can coexist. The **artifact library (data) remains a separate concern** — plugins are *capability (code)*, the library is *content (data)*.

## Decision — three layers

1. **Engine core (generic, small).** Timeline · compositor · camera/parallax/shading · render host (Remotion) · determinism · the **IR contract** · and the **extension-point registries**. It defines *interfaces*, hardcodes *no* capabilities.
2. **Plugins (capability = code).** A plugin contributes implementations to the core's extension points. It "can contain anything that extends the engine."
3. **Library (content = data).** Assets, character/object specs, generator/effect **presets**, clips, environments, projects — content-addressed, versioned, consumed by the engine + plugins. Unchanged by this ADR.

## Extension points (registries the core owns)

A plugin may contribute to any of: **providers** (rig/character render kinds), **character styles** (CharacterSpec → markup builders), **generators**, **effects** (the `effects[]` channel ops), **transitions** (presentations), **layer types**, **IR passes** (pipeline stages), **asset loaders**. Each is a typed registry + a `register*` API. (Today's `src/generators/registry.ts` and the rig-`kind` dispatch are the seed of this — they become plugin-populated.)

## Plugin contract

```
plugins/<id>/
  plugin.json        # manifest: id, version, contributes[], deps, license, provenance
  index.ts           # export function register(api: EngineAPI): void  — hooks into extension points
  (assets/presets)   # optional content this plugin ships INTO the library
```
- **Discovery/loading:** an enabled-plugins config lists active plugins; at build the core loads each and calls `register(api)`. (Blender-style register/unregister.)
- **Self-contained + shareable:** a plugin is a directory/package (later publishable/installable like a library entry — the same content-addressed + manifest model).
- **Built-ins ship as core plugins:** the current generators (bead-string/scatter/water/particles/fire/crowd), the procedural + DragonBones providers, and shading/transitions become *core plugins* — proving the system dogfoods itself and shrinking the hardcoded core.

## Character styles (the user's example)

"A consistent style in character generation" = a **character-style plugin**: it contributes a `CharacterSpec → markup` builder (the current `characterMarkup` becomes the default **`blob-creature` style plugin**). Many styles coexist (`kurzgesagt-humanoid`, `flat-mascot`, …); a CharacterSpec names its `style`; `blip`/`pip` are specs under the default style. The plugin may ship default presets into the library. Same pattern for effect packs, transition packs, fx kits.

## Determinism & tiers

Plugins MUST obey the golden rules (deterministic, seeded, frame-driven). The core can't enforce purity, so **`verify-render` gates every plugin** (cross-process byte-identical). Tier-B (GPU) capability ships as plugins too, but stays behind the GPU-determinism gate (ADR-003).

## Consequences

- The engine stops growing per feature; **capability scales horizontally via plugins**, content via the library. This is the ecosystem the project has been converging on.
- Generalizes ADR-001 (a provider is a plugin contribution) and ADR-004 (a generator implementation is a plugin contribution; presets stay library data).
- Enables a future **plugin marketplace** alongside the asset library — one sharing model (manifest + content-addressed + verify gate) for both.

## Backlog (supersedes ADR-004's standalone item)

**Plugin foundation** — ✅ **DONE (2026-06-22)**: `EngineAPI` + the extension-point registries + `plugin.json` + the loader/enabled-config built (`src/engine/`); generators + rig providers + the `blob-creature` character style migrated to **core plugins** (`plugins/`); demos byte-identical (see "Foundation status"). The ADR-004 generator-preset layer (catalog `generator-preset` kind + resolver expansion + `factory:gen-preset`) remains its own backlog item — a preset is library data the core-generators plugin's implementations are the code peer of.

After this foundation, **every new capability — effects, transitions, text, color, styles, IR passes — is authored AS A PLUGIN** contributing into the matching extension point (the four stub registries already exist for effects/transitions/layerTypes/passes), and presets/assets stay library data. New Tier-A backlog items (ADR-003) are scoped as plugins, not core edits.
