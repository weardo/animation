# ADR-005 — Plugin architecture: minimal core, capability via plugins, data in the library

**Date:** 2026-06-22 · **Status:** Accepted — the unifying architecture. Generalizes ADR-001 (providers) and ADR-004 (generators). Implement as a near-term foundation before the bulk of Tier-A capability is added.

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

**Plugin foundation** (near-term, before the bulk of Tier-A): define `EngineAPI` + the extension-point registries + `plugin.json` + the loader/enabled-config; migrate generators + providers to **core plugins**; fold ADR-004 (generator presets) in. After that, **every new capability — effects, transitions, text, color, styles — is authored as a plugin**, and presets/assets as library data.
