# ADR-008 — Author-controlled format + style-as-data (the remaining "agnostic" blockers)

**Date:** 2026-06-22 · **Status:** I1–I4 DONE (2026-06-22). Continues the ADR-006/007 "core specializes in nothing" arc into the format/style defaults — the core is now neutral on FORMAT, DOMAIN, **and STYLE**.

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

## I2 — StyleKit as data — DONE (2026-06-22)

The whole Kurzgesagt look is now selectable library DATA, not core code. The core keeps only the generic SCHEMA + mechanism + a STYLE-CLEAN neutral fallback.

- **Schema in core, values in data.** `src/ir/stylekit.ts` holds the PURE Zod `StyleKitSchema` (palette tokens · `easings`/`defaultEasings` · `motion`{spring/idle/breathing/blink/stagger/parallax/motionBlurShutter} · `light` · `shading` · a `floor`{liveness,parallax,shading,nonLinearMotion} bool object) — no remotion dep, so the Scene IR can carry it. `src/render/stylekit.ts` keeps only: a re-export of that schema/types, the easing HELPER fns (`easingFn`/`bezierFn` → Remotion `Easing.bezier`, never reimplemented), and `NEUTRAL_STYLEKIT` (generic greys + standard CSS easings + floor OFF; NO Kurzgesagt hex / liveness magic numbers).
- **Values relocated.** The Kurzgesagt VALUES moved verbatim to `library/stylekits/kurzgesagt.json` (catalog `kind:stylekit`, `uri:stylekit://kurzgesagt`). The library loader gained `toStyleKit(ref)` (parses `library/stylekits/<name>.json` via the schema, like `proc://` for rigs).
- **Story selects it.** Story IR gained optional top-level `style` (a stylekit ref). Lowering (`resolveStyleKit`, default `DEFAULT_STYLEKIT_REF = "kurzgesagt"`) resolves it through the Library, (a) seeds `defs.palette`/`defs.easings` from it AND (b) carries the whole resolved kit in the Scene IR as `defs.stylekit` (the Scene-IR schema was extended). Standalone (no Library) → `NEUTRAL_STYLEKIT`.
- **Render reads the IR, not constants.** `src/render/Scene.tsx` reads `defs.stylekit` (props, falling back to `NEUTRAL_STYLEKIT`); `shading.tsx` takes the kit's `light`/`shading`; both providers receive `stylekit` via `ProviderProps` and read liveness magnitudes from `stylekit.motion`. No core look constant survives at render.
- **Value-preservation verified:** the default `character` demo renders **byte-identical** to pre-refactor HEAD (f7dfefd) across all 5 stills — the values were relocated, not changed.

## I3 — floor opt-out — DONE (2026-06-22)

`library/stylekits/plain.json` (floor flags all OFF; neutral light-grey palette) gives a flat/technical look. The render HONORS each `floor` toggle as a generic mechanism switch:
- `shading=false` → `Scene.tsx` skips ALL §11.1 shading (no object filter / contact shadow / scene light wash).
- `parallax=false` → every layer rides the camera flat (no per-layer `cameraPosition*(1-parallax)` counter-shift).
- `liveness=false` → both providers skip idle/breathe/blink (`BlobCreatureProvider` holds a static neutral pose; `RigLayer` runs no overlays).
- `nonLinearMotion=false` → linear easing is allowed (no "never linear" enforcement).

A story with `style: plain` renders flat: `examples/plain-demo.yaml` (same scene as `character.yaml`) renders byte-stable cross-process and DIFFERS from the kurzgesagt render on every frame.

## I4 — camera as data + arbitrary keyframes — DONE (2026-06-22)

- **(a) Arbitrary keyframes.** The Story-IR `CameraIntent` accepts an object with explicit `position`/`zoom` `{a,k}` channels; `cameraFromIntent` passes them straight through verbatim (the strict Scene-IR boundary validates them). A front-end can author ANY move, not just a named preset. `examples/custom-camera-demo.yaml` proves a diagonal pan + punch-in zoom with no preset.
- **(b) Recipe table is DATA.** The `hold`/`establishing`/`slow_push_in`/`slow_pull_out`/`pan_left`/`pan_right` magic numbers moved out of `src/pipeline/camera.ts` into `library/camera/presets.json` (each a from→to position+zoom ramp + a `default` + an `easing` token). `camera.ts` keeps only the generic expansion mechanism (read the table once, ramp from→to, carry the easing ref) — zero hardcoded recipe magic numbers as the source of truth.

## Verified invariants (all gates green)

- **Determinism (CPU raster):** the 3 demos (`character`/`plain-demo`/`custom-camera-demo`) are byte-identical across cold processes.
- **Value-preservation:** the default kurzgesagt demo = pre-refactor HEAD, byte-identical.
- **Style-clean:** `src/` (code lines) contains NO Kurzgesagt signature hexes (`#ffcf4d`/`#0d1b33`/`#243056`/`#1b2a4a`/…) and NO liveness magic numbers as the SOURCE — they live only in `library/stylekits/*.json`. The only hexes left in `src/` are the neutral fallback greys + generic `#fff`/`#000` defaults + the compositing-mechanism near-black shadow/vignette tints (scaled by the kit's light, not a palette token).
- **No Remotion reimplementation:** easing → `Easing.bezier`; spring → `spring()`.
- **typecheck** clean; **domain-clean grep** + **delete-the-plugin** + **no-plugin-import** still green.

A new **style-clean gate** was added to `.claude/skills/verify-render`.

## Capability gaps (separate roadmap — features, not infections)

Tracked from the audit, each a plugin: **text/typography** (no `text` layer yet) → **footage** (video/Lottie playback) → **alpha/codecs output** (G4) → **nested `clip` comps** → **audio** (M3).

## Capability gaps (separate roadmap — features, not infections)

Tracked from the audit, each a plugin: **text/typography** (no `text` layer yet) → **footage** (video/Lottie playback) → **alpha/codecs output** (G4) → **nested `clip` comps** → **audio** (M3).
