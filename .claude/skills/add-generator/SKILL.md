---
name: add-generator
description: Use when adding a new procedural generator (water, fire, smoke, clouds, crowd, bead-string, particles, etc.) to the animation factory. Ensures it follows the deterministic, registered, golden-tested contract. Do not use for static assets or rigs (see new-library-entry).
---

# Add a Generator

A **generator** is a parametric procedural layer: a **pure function of `(params + seed + frame)`** that emits an animated sub-tree. It is how the factory does organic/ambient motion (the thing keyframes and rigs can't do).

## Contract (must hold)

- Deterministic: output depends ONLY on `params`, `seed`, and the current frame. **No `Date.now`/`Math.random`** — use `simplex-noise` seeded from `seed`, and derive phase from `frame`.
- Rendered as a Remotion React component driven by `useCurrentFrame()`.
- Consumes a Scene IR `generator` layer: `{ gen, seed, path?, params }`.

## Checklist

1. **Reuse, don't hand-roll.** Geometry → `d3-shape`; noise → `simplex-noise`; organic blobs → `blobshape`; placement along a path → `getPointAtLength`/`svg-path-properties`. (CLAUDE.md rule 3.)
2. **Implement** `src/generators/<name>.ts` as the component; keep math pure and frame-driven.
3. **Register** it in the generator registry so the compositor can resolve `gen: "<name>"`.
4. **Extend the Scene IR** generator-layer `params` in the Zod schema (`src/ir`) if you introduce new params; keep older params optional (no breaking changes).
5. **Golden-test** it: `verify-render` skill — render N frames twice → byte-identical; commit a small golden fixture.
6. **Ship as a library entry** only if it's a reusable preset → `new-library-entry` skill (semver, `index.json`).
7. **Refine** the standard if a new convention emerged → `refine-standard` skill.

Keep this skill thin: it encodes the *process*; the *contract details* live in the spec (§10) and CLAUDE.md.
