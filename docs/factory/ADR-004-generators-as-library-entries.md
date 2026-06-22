# ADR-004 — Generators are first-class library entries (capability + presets)

**Date:** 2026-06-22 · **Status:** Accepted — backlog item (implement after the generator batch lands).

## Context

Generators currently live only as code in `src/generators/registry.ts` (a static name→component map). They are reusable units, so per the three-pillar library model (ADR-001) and the factory (ADR-002) they should be **part of the library and addable on demand** — discoverable, versioned, content-addressed, and shareable — *without* editing a code registry for every new variant.

## Decision

Apply the **character-factory pattern to generators**. Two layers, kept distinct:

1. **Generator implementation = code (the mechanism).** A `src/generators/<name>.tsx` component holds the genuinely-novel deterministic logic (closed-form, seeded, frame-driven). New *logic* still means new code — that's the engine layer. BUT each implementation is **cataloged** as a library `generator` entry: `{ id, version, params (JSON-Schema derived from its Zod), tags, provenance, preview }`. So generators are discoverable/versioned/shareable like every other library kind, and the code `REGISTRY` becomes the *implementation map* behind a catalog-driven resolver.

2. **Generator preset = data (the "add as we want" unit).** A preset is a library entry that pins `{ gen: <implementation>, params: {…} }` under a name@version — e.g. `starfield@1.0.0` = `scatter` + star/twinkle params; `kurzgesagt-water@1.0.0` = `water` + warm params. A Story/Scene IR references a preset by `name@version`; the resolver expands it to `{ gen, params }`. **Adding a preset needs zero code** — author a small spec, the factory registers it (exactly like `pip` was just a CharacterSpec).

## Mechanics

- **Catalog:** `library/index.json` `generators` namespace gains `kind:'generator'` (implementation capability) and `kind:'generator-preset'` entries. (Today that namespace holds an SVG path asset — migrate/clean.)
- **Resolver:** Scene IR `generator.gen` may be a bare implementation name (e.g. `"scatter"`) OR a preset ref (`"starfield@1.0.0"`); the library resolves a preset ref → `{ gen, params }` and merges params (preset params as defaults, layer params override).
- **Factory:** add a `factory:gen-preset <preset.json>` path (parallel to `factory:gen` for characters): validate → register catalog entry + render a preview → done. Implementations self-describe their params (Zod → JSON-Schema) so presets validate against them.
- **Determinism:** presets are pure data; implementations are the deterministic closed-form components — unchanged.

## Consequences

- Generators join the **fractal library** (parts → rigs → presets → clips → **generator presets** → scenes → videos): all reuse-compounding, content-addressed, lockfile-pinned, shareable, bundle-exportable.
- "Add a generator as we want" = (common case) author a preset spec → factory registers it, *no code*; (rare case) new logic = a new implementation module, auto-cataloged.
- Consistent with ADR-003's determinism gate: we *integrate* deterministic libraries, and our generator family (implementations + presets) is the deterministic source for procedural motion that clock-owning libs (tsParticles/GSAP-runtime) can't provide.

## Backlog (ADR-003 addendum)

- New item: **"Generators as library entries"** — catalog the existing implementations (bead-string, scatter, water, particles, fire, crowd) as `generator` entries; add `generator-preset` kind + resolver expansion; add `factory:gen-preset`; ship a few presets (starfield, dust, warm-water). Run after the generator-batch (#4) commits.
