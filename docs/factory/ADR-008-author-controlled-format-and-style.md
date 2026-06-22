# ADR-008 — Author-controlled format + style-as-data (the remaining "agnostic" blockers)

**Date:** 2026-06-22 · **Status:** I1 DONE; I2–I4 accepted, pending. Continues the ADR-006/007 "core specializes in nothing" arc into the format/style defaults.

## Context

ADR-007 made the *compiler* domain-agnostic (no neuron/character baked in). But the audit found four **format/style assumptions** still baked into core defaults that stop it being a *general* factory — the renderer + Scene-IR `config` already support anything; the *upstream* defaults don't let you choose:

- **I1 — output format hardcoded.** `lower.ts` forced `RENDER_CONFIG` (1920×1080@30); the Story IR had no `format` field → every film was 1080p landscape @30.
- **I2 — StyleKit hardcoded in core.** The whole Kurzgesagt look lives in `src/render/stylekit.ts` (not a selectable library preset) → the style is fixed.
- **I3 — quality floor forced.** No-linear-motion / liveness / parallax / shading apply automatically, no opt-out → can't do a flat/technical look.
- **I4 — camera = ~4 named presets in core** (`hold`/`slow_push_in`/`pan_*`) → no arbitrary keyframed moves; recipes belong in a plugin/data.

## I1 — DONE (2026-06-22)

Author-controlled frame size + fps. The STORY chooses the format; the renderer already honors any Scene-IR `config`.

- **Story IR** (`src/ir/story.ts`): optional top-level `format` — `{ aspect?, width?, height?, fps? }`. `aspect` is an ergonomic preset (`16:9`/`9:16`/`1:1`/`4:5`/`4:3`/`21:9`) resolved to width×height; explicit `width`/`height` override it; `fps` defaults to 30. Omitted → 1920×1080@30.
- **Lowering** (`src/pipeline/lower.ts`): `resolveConfig(story.format, opts.format)` over the `RENDER_CONFIG` defaults replaces the hardcoded destructure. Pure, no domain assumptions.
- **CLI override** (`src/cli/render.ts`): `--aspect` / `--fps` / `--width` / `--height` render any story at a new format without editing it (the story's `format` is primary; this is convenience).
- **Cache correctness** (`src/pipeline/index.ts`): the content-hash cache key now folds in a `cacheKeyExtra` (the format override). Without it a CLI `--aspect` would hit a stale cached IR for the same script — a real bug found + fixed during this work (the story-field path was always correct since `format` is in the story hash).
- **Verified:** default → 1920×1080@30; `--aspect 1:1` → 1080×1080; `--width 3840 --height 2160` → 3840×2160; `9:16 @60` → 1080×1920@60; `examples/vertical-demo.yaml` (format in YAML) → 1080×1920, byte-identical across cold processes. typecheck clean.

**Note — frame geometry only.** Output *codec/container* (alpha, ProRes, GIF, PNG-sequence) is a separate render-side concern (capability gap G4), NOT part of `format`.

## I2–I4 — accepted, pending

- **I2 — StyleKit as data.** Move the Kurzgesagt defaults out of `src/render/stylekit.ts` into a selectable library **stylekit/palette preset** (the catalog already reserves those kinds). A story/project names its stylekit; Kurzgesagt becomes the default preset, not core code. (Same delete-the-plugin spirit: a look is content, not a core edit.)
- **I3 — floor opt-out.** A `plain`/style switch (per project or scene) that disables liveness/parallax/shading for flat/technical/diagram looks. The quality floor stays the *default*, not a mandate.
- **I4 — camera as data/plugin.** Move the camera recipe table to a plugin/library and allow arbitrary keyframed moves (the Scene-IR camera is already general `{a,k}`; only the front-end vocabulary is limited).

## Capability gaps (separate roadmap — features, not infections)

Tracked from the audit, each a plugin: **text/typography** (no `text` layer yet) → **footage** (video/Lottie playback) → **alpha/codecs output** (G4) → **nested `clip` comps** → **audio** (M3).
