---
name: new-library-entry
description: Use when PUBLISHING a reusable unit to the SHARED library for cross-project sharing/import (an asset, rig, preset, clip, scene-template/environment, or generator preset). This is the OPT-IN public-sharing path (npm-package layer) — NOT for project-internal reuse, which stays inside the project and never touches the library (CLAUDE.md golden rule 6). Enforces content-addressing, semver, the index.json catalog, manifests, and lockfile discipline.
---

# Add a Library Entry (the SHARED / published layer)

The library is the factory's compounding **shared** asset — the OPT-IN, cross-project PUBLISH/IMPORT layer (`library : project :: npm package : app`). Use it ONLY when deliberately sharing a unit so OTHER projects can import it. A project's OWN reusable units (defined once, reused across its scenes, never leaving it — the After-Effects precomp/asset model) are PROJECT-LOCAL and do NOT belong here. The library must **grow without ever changing past videos**.

## Kinds

`asset` (SVG/Lottie/image) · `rig` (DragonBones) · `preset` (rig + parts + attachments + palette) · `clip` (reusable nested composition with `params` + slots) · `scene-template`/`environment` (background + props + camera presets + named anchors) · `generator` (parametric component preset) · `stylekit`/`palette`/`easing-set`.

## Checklist

1. **Place** it under the right namespace: `library/{characters,props,backgrounds,clips,environments,generators,kits}/`.
2. **Address** it as `name@semver`. Bump semver on any change; never mutate a published version in place.
3. **Catalog** it in `library/index.json`: id, version, kind, tags, deps, and (for rigs) a manifest declaring **mounts** (attachable bones/slots) and **variants** (swappable parts). For free/AI assets, record `provenance` (source + license).
4. **Content-address** via `object-hash`; the resolver maps `name@version` → hash.
5. **Pin** in `animation.lock` so every video records exact resolved hashes; improving an entry later is opt-in per project.
6. **Dedup**: reference shared sub-entries via `deps`; the P2 resolver dedups and (for repeated rigs) sets up DragonBones-factory instancing.
7. **Verify** anything animated with `verify-render`.

Determinism: a `clip`/preset output is a pure function of `(version + args + overrides + seed)`, folded into its content hash. See spec §13.
