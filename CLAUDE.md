# Animation Factory — Project Standard

A code-driven, Kurzgesagt-style 2.5D animation pipeline: **a story script in → a deterministic video out.** No manual animation tool; everything is code + offline-generated assets.

**Authoritative design:** `docs/superpowers/specs/2026-06-22-animation-factory-design.md`. Read it before non-trivial work. This file is the *short, durable standard* loaded every session; detail lives in the spec and in `.claude/skills/`.

---

## Golden rules (non-negotiable)

1. **Determinism.** Same IR ⇒ byte-identical MP4. Seeded RNG only — **never** `Date.now()`, `Math.random()`, or wall-clock. Everything is a function of `frame` (+ `seed`, `params`). Re-rendering twice must match. **Recipe:** render with **no `gl` backend (CPU raster)** — deterministic + disk-safe; `gl:'angle'` (the Iris Xe iGPU) is non-deterministic for blur-heavy SVG and software GL balloons the disk. **Verify fast on stills** (`render <proj> --frames auto`, ~14s) before the slow full video. See `verify-render`.
2. **Separation of identity vs motion.** Art is fixed assets; code only changes *transforms* and *part-swaps*. **AI never touches frames or runtime** — only the offline asset library and (later) the script→IR front-end.
3. **Reuse over invent.** Before writing anything non-trivial, check for an existing library/standard. Adopted standards — do not re-implement: **Remotion** (host/render/audio/mux/batch), **DragonBones** (skeletal rigs + IK + mesh deform, via Pixi canvas), **Lottie superset** (Scene IR property/keyframe model), **Zod** (single source → types + validation + JSON-Schema), **OTIO-aligned** (sequencing concepts), plus `d3-shape`, `simplex-noise`, `@remotion/shapes`+`@remotion/paths`+`flubber` (the `shape` layer: primitives + path morph), `@remotion/transitions`, `@remotion/motion-blur`, `object-hash`.
4. **Compiler architecture.** `script → Story IR → Scene IR → frames → MP4`. Each stage is a **pure `IR_n → IR_{n+1}` pass**; validate (Zod) at every boundary; content-hash cache; golden-diff.
5. **Scope discipline.** Build by milestone (M1 → M2 → M3 in spec §15). Do **not** build ahead of the current milestone. Reserve IR fields for future stages; don't implement them early.
6. **Library discipline.** Every reusable unit is content-addressed (`name@version` → hash), cataloged in `library/index.json`, and pinned via `animation.lock`. See `new-library-entry` skill.
7. **Quality floor (Kurzgesagt).** StyleKit defaults apply automatically: **no motion is ever linear**, motion blur on fast moves, liveness (idle + breathing + blink + spring follow-through), parallax depth, limited per-scene palette.

---

## Layer taxonomy (one graph for characters *and* objects)

`asset/text` (fixed art, animate transforms) · `rig` (DragonBones, identity-stable) · `shape` (morph/path) · `generator` (procedural: water, fire, neurons, crowds) · `clip` (reusable nested composition) · `scene-template/environment` (composable scene). Compose **intra-rig** (parts/skins) and **inter-rig** (scene-graph `attach`). Reuse compounds: parts → rigs → presets → clips → scenes → videos.

## Repo layout

`src/ir` (Zod IR) · `src/library` (registry/resolver/lockfile) · `src/factory` (data-driven asset gen: CharacterSpec → builder) · `src/project` (project bundle: manifest + scene + lock) · `src/pipeline` (passes) · `src/render` (compositor + Remotion entry + procedural/DragonBones rig providers) · `src/generators` (procedural) · `src/cli` · `library/` (shared asset catalog) · `projects/<id>/` (reproducible video bundles) · `examples/` (source scripts + specs) · `docs/` (spec, ADRs, factory standard).

**Three pillars (ADR-001):** the **engine** (generic; renders any provider) · the **library** (shared, content-addressed, versioned reusable assets) · the **project** (`projects/<id>/`: one reproducible video = manifest + scene.json + project.lock + media). library : project :: npm package : app. Providers (procedural / dragonbones / …) sit behind one `AssetProvider`-style interface; procedural (SVG/DOM) is preferred — deterministic on any GL backend, no software-GL disk bloat.

---

## How we work (process)

- **New capability** → `superpowers:brainstorming` → spec → `writing-plans` or a `Workflow`. Don't implement before design is approved.
- **Add a generator** → `.claude/skills/add-generator`.
- **Add any reusable unit** → `.claude/skills/new-library-entry`.
- **Before claiming a render works** → `.claude/skills/verify-render`.
- **After any workflow/milestone** → `.claude/skills/refine-standard` (folds learnings back into this standard).

## Self-refining standard

This standard **grows** (add skills + decisions) and **self-corrects** (delete/fix disproven rules). After each milestone, run `refine-standard`: append to `docs/factory/DECISIONS.md`, update these golden rules *only* for durable lessons, and create skills for new repeatable processes. Keep CLAUDE.md tight — push detail into skills/spec.
