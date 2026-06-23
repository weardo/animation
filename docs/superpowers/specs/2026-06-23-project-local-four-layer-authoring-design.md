# Project-Local, Four-Layer Authoring — Design

**Date:** 2026-06-23 · **Status:** Proposed (for review before implementation). Fixes the separation-of-
concerns problem: rig DEFINITION, scene COMPOSITION, ANIMATION, and the FILM/timeline are currently all
jammed into one `story.yaml` → one `scene.json`. This spec separates them into four authoring layers the
compiler FUSES, with reusable units **project-local by default** (the shared `library/` stays opt-in
publish/import only — CLAUDE.md golden rule 6).

## Goals

1. **Separate the four concerns** so each is authored independently and changed without touching the others:
   **definition → composition → animation → film**.
2. **Project-local reuse by default** — a rig/object is defined ONCE in the project and instanced many
   times across its scenes (the After-Effects precomp/asset model); it never leaves the project. The
   `library/` is reached for ONLY to publish/import across projects.
3. **Reuse the existing IR, don't reinvent.** The Scene IR already has the pieces: `defs.clips` (reusable
   nested pre-comps = the definition primitive), layer `transform` with `{a,k}` channels (placement +
   animation), and `scenes[]` with `at`/`duration_frames` (the timeline). The gap is the AUTHORING split
   + project-local clip/rig definitions, not the runtime.

## The four layers (each its own file; the compiler merges them)

```
projects/<id>/
  rigs/<name>.yaml      ① DEFINITION  — a reusable object: composite of flat shapes (+ nested rigs) + EXPOSED params.
                                        NO placement, NO motion. (Lowers to a project-local defs.clips entry.)
  scenes/<name>.yaml    ② COMPOSITION — staging: which rig INSTANCES appear + placement (position/z/scale) +
                                        INITIAL param values. NO internals, NO keyframes.
  scenes/<name>.anim.yaml ③ ANIMATION — keyframes on this scene's instances' params/transform + the camera,
                                        over the scene's local time. (Optional; a scene can be static.)
  film.yaml             ④ FILM        — the timeline: ordered scene refs + per-cut transitions + duration +
                                        film-level style / format / audio.
  scene.json            COMPILED      — the compiler fuses ①②③④ → the existing Scene IR (defs.clips + scenes[]
                                        + timeline). NOT hand-edited; may be split per-scene later if huge.
```

**Layer boundaries (the contract):**
- ① a rig knows nothing about where it's placed or how it moves — only its parts + the params it exposes
  (e.g. `bird`: params `headTurn`, `blink`, `beakOpen`; parts = body/wing/belly/beak/eye flat shapes).
- ② a scene knows which rigs are on stage and their static base state (position, z, scale, initial param
  values) — not the rigs' internals, not their motion.
- ③ animation knows the timeline of a scene's motion (keyframes per instance-channel + camera) — it layers
  ON TOP of ②'s static base. Authoring placement (static) and motion (keyframes) separately is the whole point.
- ④ the film knows the sequence of scenes + how they cut together + film-wide settings — not scene internals.

## How each layer lowers (the fusion)

- **① rig def → `defs.clips[name]`** (project-local, NOT a library entry). A rig def is authored like a clip:
  its own `layers[]` (flat `shape` layers / nested rig instances) + `params[]` (exposed Essential-Graphics
  knobs with defaults). The project-assembly pass loads `rigs/*.yaml` into `defs.clips` directly — reusing
  the existing clip machinery (id-namespacing + per-instance seed derivation already make N instances
  distinct yet byte-identical).
- **② scene composition → scene `layers[]`** of `clip`-layer instances: `{ rig: <name>, at|position, z, scale,
  params: {…} }` → a clip-layer referencing `defs.clips[name]`, with `transform.position` (the explicit-
  position forwarding just added) + `args` (the param values). Pure staging.
- **③ animation → `{a,k}` on those instances' channels.** A keyframe entry `{ target: <instanceId>, channel:
  transform.position | param.<name>, keys: [{t, v, ease}] }` (+ camera keys) is folded into the instance's
  transform/`args` as an animated `{a,k}` channel. The compiler MERGES ② (the base/static value = the
  `{a:0}` default) with ③ (the keyframes) → the final animated channel. A scene with no `.anim` is static.
- **④ film → `scenes[]` timeline + `config` + film-level `audio`/`post`/`style`/`format`.** Ordered scene
  refs become the sequenced `scenes[]` (cumulative `at`, per-cut `transition_in`); film-level settings become
  `config`/`defs.stylekit`/`audio`/`post`.

A new **project-assembly pass** (`src/pipeline/assemble.ts`) reads the four layers from a project dir and
fuses them into the existing **Scene IR** (`defs.clips` + `scenes[]` + `config`), reusing `lower.ts`'s
layer/timeline builders — so the render runtime is UNCHANGED. (Whether it emits an extended Story IR that
`lower` consumes, or Scene IR directly, is an implementation detail pinned in the plan; either way the
render side does not change.)

## Reuse / not-reinvent

- **Clip = the universal reusable-definition primitive.** A "rig/object" is a project-local clip def. No new
  runtime concept — we add the project-local AUTHORING + loading of clip defs (vs only library refs today).
- Placement uses the `transform.position` forwarding (just landed). Animation uses the existing `{a,k}` model
  + easing refs. The timeline uses the existing `scenes[]`/`TransitionSeries`. Library publish/import already
  exists (`factory:publish-library`/`fetch-library`) for the opt-in sharing direction.

## Determinism, gates, domain-clean

- Pure compile: the assembly pass is a deterministic `(files) → IR` fold; rigs/clips are pure (seeded). CPU
  raster byte-identical cross-process (the standing gate).
- Domain-clean: `src/` gains only GENERIC machinery (project-assembly, project-local clip loading) — no
  `bird`/`leaf`/subject words; those live in the project's `rigs/*.yaml` DATA.
- Back-compat: a single-file `story.yaml` still compiles (the four-layer split is ADDITIVE — a project may use
  the combined story OR the split files; the assembly pass detects which).

## Phasing (incremental, each verifiable)

- **P1 — Definition + Composition (project-local rigs).** Author `rigs/*.yaml` (clip defs) loaded project-
  locally into `defs.clips`; a scene/story stages instances with placement + initial params. This alone fixes
  "objects defined inline" → reusable project-local defs. (Migrate c-0016's 31 shapes into `bird`/`plant`/
  `leaf`/`caterpillar` rig defs + an `encounter` staging.)
- **P2 — Animation layer.** The separate `.anim` keyframe surface folded onto instance channels + camera;
  authoring motion apart from staging.
- **P3 — Film/timeline split + multi-scene.** `film.yaml` sequences multiple scene files into the timeline.
- **P4 — Publish a project-local rig → library** (opt-in sharing): a `factory:publish-rig` that lifts a
  project-local rig def into the shared `library/` for other projects to import. (The other reuse level.)

## Migration — c-0016 becomes the first project under the new model

The 31 inline shapes become four project-local rig defs (`rigs/bird.yaml`, `plant.yaml`, `leaf.yaml`,
`caterpillar.yaml`, each flat-shape facets + params) + `scenes/encounter.yaml` (staging: bird@right,
plant@lower-left, caterpillar-on-leaf) — proving definition/composition separation (P1). Animation + film
split follow in P2/P3.

## Out of scope (now)

The runtime/render (unchanged). A GUI. The remote registry SERVICE (publish/import plumbing exists; a hosted
registry is separate). Pixel-faithful c-0016 (separate tuning).
