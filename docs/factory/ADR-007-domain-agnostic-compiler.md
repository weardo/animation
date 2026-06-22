# ADR-007 — Domain-agnostic compiler: purge the M1 demo from the pipeline; relocate plugin code into plugins

**Date:** 2026-06-22 · **Status:** DONE — completes ADR-005/006. The engine must specialize in NOTHING in the FRONT-END (parse → lower) and in code LOCATION, not just the compositor.

## Status: DONE (2026-06-22)

**What moved / changed:**
- **Lowering pass genericized** (`src/pipeline/lower.ts`): deleted `M1_REFS`, `buildBeadStringLayer`, the forced `background+bead+rig`, `narrator`/`L_neuron`/`L_narr`, `M1_RIG_ANIM`, `RIG_CLIP_PLANS[blip]`, and all `bead-string` special-casing. A scene's layers are now built ENTIRELY from each beat's declared `show[]` (asset/generator/shape/rig, generically); nothing is force-injected. Per-scene clip/duration defaults are GENERIC (`idle`, seconds×fps). `DEFAULT_RIG_PROVIDER` is a neutral placeholder (`'rig'`) used only on the no-library standalone path — core names no provider plugin.
- **Story IR demoted `characters`** (`src/ir/story.ts`): replaced the hardcoded `characters` entity with a generic `cast` (named refs → a library entry + optional provider). A `show[].actor` binds a layer to a cast key; "character" is just a cast entry whose ref resolves to a rig. No `neuron`/`bead`/`character:` vocabulary in the schema.
- **Plugin code relocated** (already physical): `src/generators/* → plugins/core-generators/`, `src/rig/* → plugins/core-rigs/`. Core keeps only the generic sockets — `src/render/GeneratorLayer.tsx` + `src/engine/generator.ts` (the `GeneratorComponentProps` contract) + the provider-dispatch in `src/render/Scene.tsx`. The plugin manifest (`plugins/enabled.ts`) + the composition root (`render-entry.tsx`) live OUTSIDE `src/`, so the engine names no plugin.
- **Generic CLI lock** (`src/cli/render.ts`): `lockRefsForScene` walks the compiled Scene IR's `defs` and pins exactly the refs the story referenced (was the hardcoded `[background, beadStringPath, rig]`).
- **Provider knowledge removed from core** (the last leaks the ADR-006 grep missed): `src/library/loader.ts` now REQUIRES the catalog entry's `provider` (no `format→provider` guess that named `blob-creature`/`dragonbones`) and embeds an inlined spec keyed on the `proc://` URI SCHEME, not a provider name. `src/cli/render.ts#vendorAssets` keys source-file vendoring on the URI scheme (`proc://` vs other `://`), not on a provider id. The `dragon` catalog entry gained an explicit `provider: dragonbones` (data, not core code).
- **Examples re-authored** (`examples/*.yaml`) so each declares its own layers via `show[]`; all demo projects re-compiled.

**Verified invariants:**
1. **DOMAIN-CLEAN:** `src/` code lines contain ZERO `neuron`/`bead`/`blip`/`pip`/`dragon`/`axon`/`narrator`/`M1_REFS`/`M1_RIG_ANIM`/`blob-creature` (only doc comments mention them, which the ADR permits). Grep clean.
2. **DELETE-THE-PLUGIN:** `grep "from .*plugins/" src/` is empty; moving `plugins/core-generators/` + `plugins/core-rigs/` aside leaves `src/` typechecking (`tsc --noEmit` EXIT 0). The dependency arrow is plugin→core.
3. **DETERMINISM:** `render <project> --frames auto` (CPU raster) across two cold processes gave byte-identical stills for neuron-demo (dragonbones provider) and generators-demo (seeded generators). Output legitimately differs from pre-ADR-007 bytes (scenes are now author-declared) — reproducibility, not equality with old output, is the gate.
4. **CORRECT VISUALS:** all six demos render their declared layers (blip character, neuron bead-chain + dragonbones rig, generators, shapes, scatter, effects) — entirely from their story `show[]`.

## Context — the leak ADR-006 missed

ADR-006 genericized the **back-end** (compositor + the rig dispatch + moved `CharacterSpec` out) and we declared a "pure engine." That was only half true. Two domain infections remain, both tracing to the project being built **M1-first as a hardcoded neuron/character vertical slice**:

1. **The lowering pass *is* the demo.** `src/pipeline/lower.ts` — a pass that must be a generic `StoryIR → SceneIR` transform — hardcodes the M1 neuron/character/dragon slice into *every* render: `M1_REFS = {background:'bg_gradient', beadStringPath:'axon_curve', rig:'dragon@1.0.0'}`; a dedicated `buildBeadStringLayer()` (`id:'L_neuron'`, beads:9, axon pulse); `buildRigLayer()` always injecting a DragonBones rig (`'narrator'`/`'L_narr'`); `M1_RIG_ANIM='throw'`; `RIG_CLIP_PLANS={blip:…}`; every scene forced to `background + bead-string + dragon rig`; `s.generator !== 'bead-string'` special-casing. The system can *render* anything but can only *compile* the neuron demo.

2. **Generator + rig CODE lives in core; the plugins are hollow shells.** `plugins/core-generators/index.ts` is `import { BeadString } from '../../src/generators/…'` — the implementations physically live in `src/generators/*`. Same for `plugins/core-rigs` → `import { RigLayer } from '../../src/rig/*'` (the whole DragonBones runtime). ADR-005's "migration" moved only the `register()` call; the dependency arrow still points `plugin → core`.

3. **Story IR hardcodes `characters`** as a first-class entity (`characters: z.record(CharacterSchema)`, `character:` fields, `neuron`/`bead` references) — the front-end analog of the bug ADR-006 fixed in the back-end.

**Why the ADR-006 verify passed anyway:** it grepped core for `CharacterSpec`/`characterStyles` — the *previous* disease. The leak here is `bead-string`/`narrator`/`M1_REFS`/`src/generators`, which that grep never looked for.

## Decision — clean it to fully agnostic (full scope)

1. **Genericize the lowering pass.** `lower.ts` builds layers ONLY from what the story declares (`show[]` items → `asset`/`generator`/`shape`/`rig`/`text` layers, generically). DELETE `M1_REFS`, `buildBeadStringLayer`, the forced `background+bead+rig`, `narrator`/`L_neuron`/`L_narr`, `M1_RIG_ANIM`, `RIG_CLIP_PLANS[blip]`, and all `bead-string` special-casing. Default backgrounds, clip plans, and rig defaults become **library entries + story data**, never code. The pass knows generic layer kinds — not `neuron`, `character`, or `dragon`.

2. **Physically relocate plugin code.** Move `src/generators/* → plugins/core-generators/` and `src/rig/* → plugins/core-rigs/` (the implementations, not just registration). Core keeps only the **generic sockets**: the `GeneratorLayer` renderer + `GeneratorComponentProps` contract, and the provider-dispatch in the compositor. **Delete-the-plugin test:** removing `plugins/core-generators/` (or `core-rigs/`) must leave `src/` type-checking — the dependency arrow points plugin→core, never core→plugin.

3. **Demote `characters` in the Story IR.** Replace the hardcoded `characters` entity with a generic `cast`/declared-refs concept (a story names refs + layers; "character" is just one ref kind). Remove `neuron`/`bead` from the schema. Front-end ADR-006.

4. **Generic CLI lock.** `lockRefsForScript` pins whatever refs the scene actually references (walk the scene), not the hardcoded `[background, beadStringPath, rig]`.

5. **(Low, non-blocking)** `"kurzgesagt"` stays as the default StyleKit *preset name* — the engine is style-agnostic and merely ships it as the default look; no code depends on it being kurzgesagt. Optional later: namespace it as one preset among many.

## Verification gate (added to `verify-render`)

- **Domain-clean grep:** `src/` (excluding none) contains ZERO of: `neuron`, `bead`, `blip`, `pip`, `dragon`, `axon`, `narrator`, `M1_REFS`, and the specific generator names as hardcoded logic. (Generic words in comments are fine; hardcoded *behavior* is not.)
- **Delete-the-plugin test:** temporarily moving a core plugin dir aside still leaves `src/` type-checking.
- **Determinism:** each re-lowered demo renders byte-identical across two cold processes (CPU raster). NOTE: output may legitimately DIFFER from the pre-ADR-007 bytes (the scene structure is now author-declared, not hardcoded) — we verify *reproducibility + correct visuals*, not equality with the old output.
- **Demos render correct visuals** (blip, neuron chain, generators, effects) — now entirely from their story `show[]` declarations.

## Consequence

The compiler becomes genuinely generic end-to-end: it can compile ANY story — infographic, chart, still, abstract, character — because it hardcodes none of them. "Pure core" now holds for the **front-end and code location**, not just the compositor. Completes the ADR-001→007 arc: every drop of domain knowledge lives in plugins (code) + library (data); `src/` specializes in nothing.

## Migration

Existing demos no longer get layers for free — their `examples/*.yaml` must DECLARE their layers (`show[]`: the background, the bead-string generator, the rig, etc.). Re-author the example stories so they reproduce their intended scenes, then re-compile every project. This is the proof the front-end is generic: the neuron demo becomes *a story that declares a neuron*, not *the behavior the compiler bakes in*.
