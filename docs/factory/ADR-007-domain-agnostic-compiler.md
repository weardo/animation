# ADR-007 — Domain-agnostic compiler: purge the M1 demo from the pipeline; relocate plugin code into plugins

**Date:** 2026-06-22 · **Status:** Accepted — completes ADR-005/006. The engine must specialize in NOTHING in the FRONT-END (parse → lower) and in code LOCATION, not just the compositor.

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
