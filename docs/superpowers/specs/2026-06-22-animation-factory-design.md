# Animation Factory — Design Spec

**Date:** 2026-06-22
**Status:** In build — M1 complete; **M2 complete (vocabulary fast-track, 2026-06-22)**; **M3 — narration DONE (2026-06-22) + remaining-backlog fast-track DONE (2026-06-23): captions · SFX-from-events · music bed + ducking · track-matte clipPath · generator presets · factory:bundle/list · OTIO export**. **§0 reconciles the spec with what's actually built** (the design evolved via `docs/factory/ADR-001`, `ADR-002`, and `docs/factory/DECISIONS.md`).
**Topic:** A code-driven, Kurzgesagt-style 2.5D animation pipeline that turns a story script into a rendered video.

---

## 0. Current State (reconciled 2026-06-22)

Where this section conflicts with later sections, **this section wins** (later sections are the original design; the system has since evolved). Detail lives in `ADR-001`, `ADR-002`, and `DECISIONS.md`.

### Three pillars (ADR-001)
- **Engine** (generic): timeline · compositor · camera/parallax · shading · render host (Remotion) · determinism. Knows a layer *contract*, never how pixels are made.
- **Library** (shared): content-addressed, versioned, reusable assets (characters, generators, backgrounds) — `library/index.json` catalog + per-entry manifests.
- **Project** (per-video): `projects/<id>/` = a **self-contained, reproducible bundle** — `project.json` (manifest) · `story.yaml` (source) · `scene.json` (compiled timeline) · `project.lock` (pinned deps) · `assets/` (vendored sources) · `media/` (outputs). `library : project :: npm package : app`. Container follows **OTIO `.otiod` / dotLottie** (manifest + timeline + vendored assets; dir form now, zip later).

### Style is selectable library DATA (ADR-008 — DONE 2026-06-22)
The "house style" is **not core code** — it is a **selectable library `stylekit` entry** (`library/stylekits/*.json`, catalog `kind:stylekit`). The core (`src/ir/stylekit.ts`) owns only the generic **`StyleKitSchema`** (palette tokens · easings · `motion`{spring/idle/breathing/blink/…} · light · shading · a `floor`{liveness,parallax,shading,nonLinearMotion} bool object) + the easing helper fns (→ Remotion `Easing.bezier`) + a STYLE-CLEAN `NEUTRAL_STYLEKIT` fallback (greys, standard easings, floor OFF). **Kurzgesagt is the DEFAULT PRESET, not a mandate** (`library/stylekits/kurzgesagt.json`, byte-identical to the old hardcoded look); a story selects it via optional Story-IR `style` (default `"kurzgesagt"`). Lowering resolves the kit through the library, seeds `defs.palette`/`defs.easings`, AND carries the whole resolved kit in the Scene IR as **`defs.stylekit`** — render-time reads motion/liveness/shading/floor from the IR, never a core constant. **The quality FLOOR is OPT-OUT** (ADR-008 I3): `library/stylekits/plain.json` turns all four `floor` toggles off for a flat/technical look (`shading=false`→no §11.1 shading; `parallax=false`→flat; `liveness=false`→providers skip idle/breathe/blink; `nonLinearMotion=false`→linear allowed). **Camera is DATA + arbitrary keyframes** (ADR-008 I4): the named-move recipe table (`hold`/`slow_push_in`/`pan_*`/…) moved out of `src/pipeline/camera.ts` into `library/camera/presets.json` (the pass keeps only the generic from→to expansion), AND the Story-IR `camera` may carry explicit `{a,k}` position/zoom keyframes that pass straight through — any move, not just a preset. Verified: 3 demos byte-identical cross-process, default kurzgesagt = pre-refactor HEAD byte-identical, `src/` style-clean (no signature hexes / liveness magic numbers as source). **The core is now neutral on FORMAT, DOMAIN, and STYLE.**

### Plugin foundation (ADR-005 — DONE) + pure engine (ADR-006 — DONE) + domain-agnostic compiler (ADR-007 — DONE 2026-06-22)
The engine core is a **minimal plugin system that specializes in NOTHING — in the back-end AND the front-end AND code location** (ADR-006/007). The core (`src/engine/`) owns generic extension-point **registries** + an `EngineAPI`; **capability is contributed by plugins (code)**, content stays in the **library (data)**. Two live extension points — `generators` · **`providers`** — plus four stubs (`effects`/`transitions`/`layerTypes`/`passes`). ADR-006 **removed the `characterStyles` point and renamed `rigProviders` → `providers`**: a `rig` is just "a provider-rendered generic layer" — core knows no `character`/`style`/scene-type/subject. The built-ins ship AS CORE PLUGINS (`plugins/`): **core-generators**, **core-rigs** (registers the `dragonbones` provider), **blob-creature** (registers the `blob-creature` provider — the first provider among many; future `chart`/`widget`/`diagram` are peers). `loadPlugins()` (run by the composition root `render-entry.tsx` + the factory) validates each `plugin.json`, orders by `deps`, and calls `register(api)` to populate the registries before render. **Every new capability — providers, effects, transitions, text, color, IR passes — is authored AS A PLUGIN**, not a core edit; presets/assets stay library data.

**ADR-007 (DONE) — domain-agnostic compiler.** The two domain infections ADR-006 left in the FRONT-END + code LOCATION are gone: (1) **the lowering pass** (`src/pipeline/lower.ts`) is now a generic `StoryIR→SceneIR` transform that builds a scene's layers ENTIRELY from each beat's declared `show[]` (asset/generator/shape/rig, dispatched by which field is set) — the M1 demo (`M1_REFS`, `buildBeadStringLayer`, the forced `background+bead+rig`, `narrator`/`M1_RIG_ANIM`, `bead-string` special-casing) is deleted; nothing is force-injected. (2) **The generator + rig CODE physically lives in plugins** (`plugins/core-generators/*`, `plugins/core-rigs/*`) — core keeps only the generic sockets (`src/render/GeneratorLayer.tsx` + the `GeneratorComponentProps` contract + the provider-dispatch); the plugin manifest (`plugins/enabled.ts`) + composition root (`render-entry.tsx`) live OUTSIDE `src/`. (3) **The Story IR demoted `characters` → a generic `cast`** (named refs → a library entry + optional provider); "character" is just a cast entry whose ref resolves to a rig, not a schema entity. Provider selection is DATA (catalog `provider:` field) or URI-scheme convention (`proc://`), never a provider name branched on in core. **Two decoupling invariants are now permanent `verify-render` gates:** a **domain-clean grep** (`src/` code holds zero demo/subject/provider-name words) and the **delete-the-plugin test** (move a built-in plugin dir aside → `src/` still typechecks; `grep "from .*plugins/" src/` is empty — the dependency arrow is plugin→core). The compiler can now compile ANY story (infographic, chart, still, abstract, character) because it hardcodes none of them.

### Providers (ADR-001 → ADR-005 plugins → ADR-006 generic)
Rig layers dispatch by `rigDef.provider` (an opaque id, NOT a domain "kind"), resolved through the engine `providers` registry (populated by the provider plugins — no hardcoded branch). The compositor sees only: *a `rig` layer → a provider id + an OPAQUE `spec` → the provider renders it.* Today: **`blob-creature` (PRIMARY)** — a provider PLUGIN that OWNS its `CharacterSpec` (`plugins/blob-creature/spec.ts`) + builder (`character.ts`) + renderer (`renderer.tsx`); it validates the layer's opaque spec itself and draws code-only flat-vector creatures (pure SVG/DOM, deterministic on any GL backend); and **`dragonbones` (optional/legacy)** — vendor skeletons via Pixi (`core-rigs`). New sources (chart/infographic/diagram) = new provider plugins behind the same `ProviderProps` interface; no engine/IR change. The core IR's rig def is `{ uri, provider, spec? }` with `spec` OPAQUE (`z.record(unknown)`).

### Asset factory (ADR-002 → ADR-006 plugin-owned)
The factory is plugin-owned source-material tooling (ADR-006): the character-specific generator lives in `plugins/blob-creature/generator.ts`. `factory:gen <spec.json>` is a thin core CLI that **dispatches to the active provider plugin's `generate(...)`** → validate CharacterSpec (Zod) → generalized builder (`characterMarkup`) → write canonical spec + `rsvg` preview + register a content-addressed library entry (`kind:rig`, `provider:blob-creature`). **One builder + N specs = N creatures.** Any provider plugin MAY ship its own `generate(...)` (a chart plugin → a ChartSpec generator). Data-driven specs now; AI-assisted spec generation is a future front-end.

### Determinism (updated)
Same Scene IR ⇒ byte-identical video. Render with **`gl: 'angle'`** — procedural scenes are SVG/DOM-deterministic (the GL backend doesn't affect them). **DO NOT use software GL** (`'swiftshader'`/`'swangle'`): it balloons Chromium CacheStorage to ~26GB and crashes (DECISIONS 2026-06-22). Software GL was only ever needed for WebGL/DragonBones FFD determinism — another reason procedural is primary.

### Build status
- **DONE:** pipeline (parse→lower→layout→camera→validate) · Remotion render · library + per-project lockfile · **Shading & Depth (§11.1)** · **multi-scene storytelling + transitions (§11.2, 2026-06-22)** · **`scatter` generator (§10/§10.1, 2026-06-22)** · **first-class `shape` layer — `@remotion/shapes` primitives + `flubber` path morph + `@remotion/paths` utilities, solid/linear/radial fills, stroke (§11, ADR-003 #1, 2026-06-22)** · **layer `effects[]` channel — composable, animatable per-layer effect stack via SVG/CSS filters + `@remotion/motion-blur`, authored AS THE `core-effects` PLUGIN populating the engine `effects` extension point (blur/glow/drop_shadow/color_grade/turbulence/displace/vignette/grain/motion_blur); composes on top of §11.1 shading + parallax; deterministic (ADR-003 #2, 2026-06-22)** · procedural provider + **asset factory** + **projects** · determinism/disk fixes · **plugin foundation (ADR-005, 2026-06-22): engine extension-point registries + EngineAPI + plugin.json + loader; generators/rig-providers/blob-creature migrated as core plugins; demos byte-identical** · **pure engine (ADR-006, 2026-06-22): engine specializes in NOTHING — `characterStyles` removed, `rigProviders`→`providers`, `src/factory` deleted, `CharacterSpec`/builder/generator owned by the `blob-creature` provider plugin, rig def `{provider, spec(opaque)}`; all 6 demos re-lowered + byte-identical** · **domain-agnostic compiler (ADR-007, 2026-06-22): the front-end + code location now specialize in NOTHING too — `src/pipeline/lower.ts` builds layers ENTIRELY from each beat's `show[]` (M1 `M1_REFS`/`buildBeadStringLayer`/forced `background+bead+rig`/`bead-string` special-casing deleted), Story IR `characters`→generic `cast`, `src/generators`+`src/rig` REMOVED from core (live in `plugins/core-generators`+`plugins/core-rigs`), last provider-name leaks purged from loader/render (provider is DATA + URI-scheme), generic `lockRefsForScene`; gated by the new domain-clean grep + delete-the-plugin test; demos re-authored to declare their own layers + verified reproducible cross-process** · **author-controlled format + style-as-data (ADR-008, 2026-06-22): I1 output format (aspect/size/fps) from the story; I2 StyleKit is selectable library DATA (`StyleKitSchema` in core, Kurzgesagt + plain VALUES in `library/stylekits/*.json`, carried in Scene IR as `defs.stylekit`); I3 quality FLOOR is opt-out (`plain` kit → flat); I4 camera recipes are DATA (`library/camera/presets.json`) + arbitrary `{a,k}` keyframes; core neutral on FORMAT/DOMAIN/STYLE; default kurzgesagt byte-identical to pre-refactor HEAD** · **first-class `text`/typography layer — generic core layer kind + vendored deterministic font (`@font-face` + `delayRender`, no CDN) + kinetic presets (fade/rise/stagger/typewriter/count_up) via `interpolate`/`spring` + `@remotion/layout-utils` box-fit (§11.3, 2026-06-22)** · **nested composition (`clip`) — a PRE-COMPOSITION modeled on AE pre-comp / Lottie precomposition (a SHARED `defs.clips[ref]` def + `clip`-layer `refId`) + AE Essential-Graphics / .mogrt exposed `params` overridden per instance via `args` + a Remotion `<Sequence>` for the local timeline; lowering resolves+dedupes+recurses defs into `defs.clips` (cycle-detect + depth cap), emits ONE shared-ref `clip` layer per instance; render substitutes `$param`/`{{}}` (pure `resolveParams`), namespaces inner ids `<clipLayerId>/<innerId>` + derives per-instance generator SEEDS from a hash of that id (so one clip used twice renders DISTINCTLY yet each byte-identically), recurses through the SAME `LayerView` (clip-in-a-clip, depth ≥ 2); no Remotion primitive reimplemented; domain/style-clean + delete-the-plugin still green (§13.3, ADR-003, 2026-06-22)** · **painting style (ADR-009, 2026-06-23): a subject-independent PAINTED look = an OPTIONAL stylekit `paint` DATA sub-table + a generic shading MECHANISM (`src/render/paint.ts`) applied to every shape/asset layer, gated by `floor.shading` — AUTO `culori` shade-ramp form-shading gradients, a lit-side rim, reused core-effects grain/glow, and scene atmosphere (dark backdrop + focal pool + vignette + per-layer depth grade); the `kurzgesagt-nature` stylekit DATA tuned to the reference; content stays dumb (the STYLE carries the look). Verified byte-identical cross-process; `plain` (floor.shading off) renders flat; gates green; default demos unaffected (§11.1 extension)** · **library-breadth + finishing-passes batch (2026-06-23): M7a + M7b + M7c + M8a + M8b** — **M7a ADR-001 formal interfaces:** `LibraryResolver` (storage seam) + `AssetRefResolver` (library-side ref→def adapter) as explicit TS interfaces in `src/library/interfaces.ts`; `Library implements` both (compile-time assertion, ZERO behavior change); ADR-001 marked Integrated/DONE. **M7b icon library:** `factory:ingest-icons` ingests open-license SVGs (lucide-static, ISC) OFFLINE → core-objects `ObjectSpec` (`kind:"icon"`, geometry only) under the `icons` catalog namespace, content-addressed + provenance/license; the provider-schema validator is injected by a repo-root entry (like `factory:gen`) so `src/` imports no plugin; renders as a form-shadeable badge+glyph. **M7c `map` generator (core-dataviz):** geographic maps via `d3-geo` (projections + `geoPath`) + `topojson-client` — geometry is DATA (inline TopoJSON/GeoJSON in params, selected via a `world-map` generator-preset → `library/maps/`), domain-clean (no country hardcoded), choropleth + draw-on, pure→deterministic. **M8a `post[]` grade:** the reserved Story-IR/Scene-IR `post[]` is now wired to a FILM-LEVEL effect stack in `Composition.tsx` wrapping the whole composited frame, REUSING the same core-effects ops (`resolveEffects`/`applyEffects`) the per-layer `effects[]` use — absent/empty → strict no-op, dropped on `--alpha`, pure→deterministic. **M8b paint follow-ons:** softer 4-stop ramp + per-silhouette ramp orientation (radial for round/blobby, linear-along-major-axis for elongated) + aerial perspective (far layers haze their whole fill ramp TOWARD the atmosphere colour, silhouette-perfect). Verified: `tsc` clean + all standing gates green; demo scripts `examples/{icon,map,post}-demo.yaml`**.
- **✅ M2 COMPLETE (vocabulary fast-track, 2026-06-22):** **content & animation vocabulary buildout (ADR-003), Tier-A-first** — ✅ `@remotion/shapes`+`@remotion/paths`+`flubber` morph (shape layer) · ✅ `effects[]` via SVG/CSS filters + motion blur (the **core-effects plugin**) · ✅ generators (scatter, water, particles, fire, crowd) · ✅ `clip` (nested pre-composition — §13.3) · ✅ **`environment`** (a library clip used as a full-scene backdrop — a lowering convention reusing the clip machinery) · ✅ **compositional rigs `attach`/`parts` (§8.1)** — `attach` resolves a child layer onto a parent rig MOUNT (rig-manifest `mounts` → Scene-IR rig def; pure per-frame world-anchor in `src/render/attach.ts`, `inherit` selects channels); `parts` is an opaque per-rig variant map the provider interprets · ✅ text/typography (§11.3) · ✅ **color-script (§11.4)** — per-beat `mood`/`palette` resolved over the stylekit base + OKLab interpolation across transitions via `culori` (`src/pipeline/color-script.ts`); per-scene `palette` override carried in Scene IR · ✅ **footage layer** (`<OffthreadVideo>` / `@remotion/lottie`, frame-seeked, deterministic) + **compositing** (per-layer `blend` = CSS `mix-blend-mode`; track `matte`/`mask` = SVG mask / CSS `mask-image`, applied generically in the layer wrapper — `src/render/compositing.tsx`) · ✅ **transitions completion + the `core-transitions` PLUGIN** — iris/mask (SVG reveal), match-cut/morph-match (flubber shared-element), camera-continuous as real presentations; the transition mapping moved OUT of core `Composition.tsx` INTO the engine `transitions` extension point (the stub is now live; Composition resolves `transitions.get(kind)`) · ✅ **object/prop specs (the `core-objects` provider plugin)** + ✅ **data-viz (the `core-dataviz` `chart` generator: bar/line/pie via `d3-shape`/`d3-scale`, animatable draw-on)** · ✅ **alpha/codec output** (`--alpha` transparent VP9/yuva420p or ProRes 4444 or PNG-sequence; `--codec`/`--format` mp4/webm/gif; default stays h264 mp4). Verified: `tsc` clean + all standing gates (domain-clean / style-clean / core-imports-no-plugin / delete-the-plugin) + the `examples/m2-demo.yaml` mega-demo (exercises every feature) byte-identical across two cold processes + frames eyeballed.
- **🔊 NARRATION MVP DONE (2026-06-22):** the first M3 capability — **OFFLINE TTS → cached content-addressed wav → Scene-IR `audio[]` cue → Remotion `<Audio>` → muxed mp4 (h264+aac)** (§12, ADR-003 #9 PARTIAL). Engine-abstracted + swappable (`src/cli/narrate.ts`): **espeak-ng** default (deterministic, always available); **Coqui XTTS v2** wired via an isolated venv with espeak-ng fallback. Golden rule 2 posture: TTS runs OFFLINE at build (like `factory:gen`/the font), never at render. Golden rule 1: the wav is synthesized ONCE (skip-if-exists), so a re-render replays the FIXED wav — verified BOTH decoded video AND audio streams byte-identical across two cold processes; silent demos unaffected (`--no-audio`); domain/style-clean + delete-the-plugin still green; disk flat. Demo: `examples/narration-demo.yaml`.
- **✅ REMAINING-BACKLOG FAST-TRACK DONE (2026-06-23):** the rest of the M3 audio stack + the deferred compositing/library/interop follow-ups, Tier-A-first. **(A1) CAPTIONS (§11.3/§12)** — narration-synced on-screen subtitles DERIVED from the same authored `say` text + cue window (deterministic, NO whisper): a Scene-IR `captions[]` cue (`line` whole-line or `words` even-split karaoke) → `src/render/CaptionTrack.tsx` (bottom-centre readable pill in a Remotion `<Sequence>`); default-on with narration (`--no-captions`/`--caption-mode words`). **(A2) SFX-FROM-EVENTS (§12)** — a sound effect attached to an element entrance (`show[].sfx`) or a beat accent (`beat.sfx[]`) → `kind:"sfx"` `audio[]` cues at the event frame (`src/cli/sfx-pass.ts`); the SFX palette (tick/pop/whoosh/ding/thud/click) is SYNTHESIZED OFFLINE by ffmpeg lavfi math into the shared `library/sfx/` cache (`src/cli/sfx.ts`, no downloads) and played via `<Audio>`. **(A3) MUSIC BED + DUCKING (§12)** — a story-level `music` bed (built-in ffmpeg-synthesized `calm`/`drone`/`uplift` in `library/music/`, or an asset ref) → ONE `kind:"music"` cue spanning the timeline, `<Loop>`-tiled, DUCKED per-frame from `gain`→`duck` (linear `fade` ramps) while any narration window overlaps — pure-by-frame duck math (`duckingAt` in `Composition.tsx`), deterministic. **(A4) TRACK-MATTE finished (ADR-003)** — a LAYER matte whose SOURCE is a SHAPE now builds a real geometry stencil from the source shape's path (`shapeClipGeometry` in `ShapeLayer.tsx`), composited as a STATIC `mask-image` data-URI (NOT a live `clip-path` — see DECISIONS 2026-06-23: live clip-path drifted ~51 dB across cold `renderMedia` processes; the data-URI mask is the proven byte-identical asset-matte path), superseding the deferred no-op. **(B) GENERATOR PRESETS (ADR-004 DONE)** — a `generator-preset` is a library entry (`kind:generator-preset`: a named generator + locked params, `library/generators/*.preset.json`); the resolver expands a `show[].generator` that names a preset to its `{gen, params}` (layer args override preset defaults); `factory:gen-preset` registers one. Examples: `starfield`, `dust-motes`. **(C) factory:bundle/list** — `factory:bundle <project>` produces a self-contained shareable bundle (scene.json + lock + vendored assets + media, cf. OTIO `.otiod`/dotLottie); `factory:list` lists library entries by kind + projects. **(D) OTIO EXPORT** — `export:otio <project>` emits an OTIO-aligned timeline JSON (scenes→tracks, layers/clips→clips with source ranges + transitions; OTIO concepts only, no OTIO lib). Verified (BATCHED): `tsc` clean + `examples/remaining-demo.yaml` mega-demo (every feature) byte-identical across two cold processes for BOTH the decoded video stream AND the decoded audio stream (md5) + the muxed audio AUDIBLE (mean −23 dB, well above the −60 dB silent floor) + stills eyeballed (star-clipped matte, captions, starfield preset, hero) + domain-clean / style-clean / delete-the-plugin all green.
- **LATER (M3+, remaining):** **lip-sync** (viseme/mouth-shape from audio) · **whisper-precision captions** (real word-timestamp alignment — beyond the deterministic even-split) · **LLM script-expander** (P1; needs an engine decision) · **smart layout/camera director** (P6/P9) · AI asset-gen (P3) · **Tier-B GPU enablement** (GL Transitions / Pixi filters / three / skia, gated on deterministic GPU capture).
- **ADR follow-ups:** ~~formalize `AssetProvider`/`LibraryResolver` TS interfaces~~ **DONE (M7a, 2026-06-23)** — `LibraryResolver` + the library-side `AssetRefResolver` are formal interfaces in `src/library/interfaces.ts`; `Library implements` both. Remaining: the `LibraryResolver` REMOTE variant + a specified bundle/export format.

### Content & animation vocabulary (ADR-003)
The full editor vocabulary (transitions, effects, shapes, text, color, masks, audio, generators, data-viz, 3D) is **adopted from free libraries through our families, not invented** ("families are sockets; libraries are plugs"). Two sourcing tiers, gated by determinism:
- **Tier A — adopt now** (deterministic, disk-safe, DOM/SVG/CSS/CPU): `@remotion/shapes`+`@remotion/paths`, `@remotion/transitions`, SVG/CSS filters, `@remotion/motion-blur`/`noise`, GSAP (free plugins), `flubber`, `culori`/`d3`, `@remotion/google-fonts`/`layout-utils`/`captions`/`media-utils`, Iconify/unDraw/Open Peeps/Lottie.
- **Tier B — opt-in, gated on deterministic GPU capture** (free but WebGL → non-deterministic + disk-balloon): GL Transitions (123 GLSL), PixiJS filters, pmndrs/postprocessing, `@remotion/three`/`skia`.
The complete inventory + build backlog (every category, nothing skipped) is **ADR-003**. The M2 buildout executes that backlog Tier-A-first.

---

## 1. Problem & Goal

Generating animation by AI image/video models is **unstable**: characters distort frame-to-frame and motion cannot be controlled. We want the opposite property — **deterministic, controllable, identity-stable** animation produced entirely from **code + assets**, with **no human-interaction animation tool** (no After Effects, no manual keyframing in an editor).

**Goal:** an *animation factory* — input a story/script, build an "animation world," and record a video out of it. The system must:

- Produce **high-quality Kurzgesagt-style 2.5D** output (flat vector, bold flat colors + gradients, shape-assembly characters, layered parallax depth, gentle camera moves, snappy eased motion, rich organic ambient motion).
- Keep stable, **constructed (rigged) characters** that never distort across frames.
- Be a **modular pipeline** so new processing stages (AI script-expander, TTS narration, smarter layout, AI asset-gen) can be inserted later without rewrites.
- Run **on a laptop, local-first, lightweight**, with **no ongoing LLM/cloud budget** (AI is used offline/one-time only, never per-frame).
- Add **audio/voice narration later** (designed-for now, built later).

### Non-goals (explicitly out of scope)

- Physically-accurate **cloth/fluid simulation** (Navier–Stokes/SPH) — wrong tool for stylized 2D.
- (Stylized **mesh / free-form deformation** is available via the *optional* DragonBones provider, but the **primary path is procedural** — squash/stretch + organic shapes from code, §0. DragonBones FFD is legacy, not required.)
- Real-time interactivity / a game engine. Output is recorded video.
- True 3D geometry. Depth is faked via 2.5D parallax (add a 3D backend only if a hard requirement ever appears).
- AI generating frames or driving motion at runtime. AI only ever touches the *offline asset library* and (later) the *script→IR front-end*.

---

## 2. Core Principles

1. **Separate identity from motion.** *What a character looks like* (assets, fixed) is separate from *how it moves* (deterministic code). Art is immutable sprites/SVG paths; code only changes **transforms** and **part-swaps**. The eye-dot in frame 600 is byte-identical to frame 1 because it is never re-synthesized. This is the structural answer to AI drift.
2. **Compiler architecture.** `story script → Story IR → Scene IR → frames → MP4`. Each stage is a pure `IR_n → IR_{n+1}` pass (seeded RNG, no wall-clock), individually testable, content-hash cacheable, and golden-diffable.
3. **The IR and rig format are the moat; the renderer is a host we feed.** Own the scene/timeline contract; reuse standards for the pieces inside it.
4. **Reuse over invent.** Adopt standard formats and maintained libraries everywhere possible; hand-write only thin glue and the genuinely-novel semantic layer.
5. **Determinism.** Same IR ⇒ byte-identical MP4. This unlocks caching and regression testing, and is the property the whole pipeline rests on.

---

## 3. Stack Decision

**Remotion is the host/orchestrator/encoder.** It owns the timeline, the deterministic frame clock, layer compositing, camera/parallax transforms, audio, and MP4 encoding (incl. batch via `renderMedia`). The Scene IR *is* a Remotion composition's `inputProps` — **no translation layer between IR and renderer.**

Rationale (given a solo developer, "don't build from scratch," license is a non-issue): Remotion gives us deterministic render + audio + FFmpeg muxing + batch render out of the box, is the most LLM-authorable engine (React), and has official agent skills + MCP. This *deletes* the original plan's highest-risk item (a hand-rolled deterministic frame-capture loop).

### Remotion as compositor — sub-renderers run *inside* it

| Layer kind | Renderer (inside Remotion) | Build vs reuse |
|---|---|---|
| asset / shape / text | React + SVG | thin glue (ours) |
| **Lottie** (pre-made vector loops: water, fire, ambient) | `@remotion/lottie` / `lottie-web` | ♻️ reuse |
| **rig** (characters: skeletal + IK + **full mesh deformation/FFD**) | `pixi-dragonbones-runtime` in a Pixi `<canvas>` (committed render path) | ♻️ reuse |
| **generator** (neurons, particles, smoke, crowds) | React/SVG + `d3-shape` + `simplex-noise` + `blobshape` | ours (thin) |

**Determinism rule for sub-renderers (verified recipe, 2026-06-22):** every sub-renderer is driven by Remotion's `useCurrentFrame()` (DragonBones is *seeked* to `time = frame/fps`; Lottie to its frame). For the Pixi/WebGL rig, byte-identical output across **cold, independent** runs requires all three: (1) **software GL** — `chromiumOptions.gl: 'swangle'` (hardware `'angle'` rasterizes non-deterministically across runs); (2) **`preserveDrawingBuffer: true`** on the Pixi init (so the screenshot reads the rendered buffer regardless of compositing timing); (3) **synchronous `continueRender`** right after `app.render()` (rAF-based gating interacts with Remotion's controlled frame clock and reintroduces non-determinism). No sub-renderer runs its own clock.

### Rejected / deferred engines

- **Remotion BeginFrame custom capture / PixiJS-as-host** — only needed if the BSL license ever became a problem (solo dev → it doesn't). Keep Scene IR backend-agnostic so a Pixi host *could* be swapped in, but do not build it.
- **Raw Lottie as top-level format** — no skeletal rig, no camera-parallax, no generators, no audio cues, painful to author/transform programmatically (it's an After Effects export target). Adopt its *data model* and keep it as an ingestable asset type, not as the scene IR.
- **Rive / Spine editor formats** — editor-authored binaries violate "no manual tool" / per-seat cost. (DragonBones is the free, code-generable alternative.)

---

## 4. Reuse-vs-Invent Ledger (IR & subsystems)

Verified against the 2026 landscape. Standards adopted so we extend rather than invent:

| Concern | Decision | Source/lib |
|---|---|---|
| Property/keyframe/easing/layer model | **Scene IR = Lottie superset** (use Lottie schema where it overlaps; round-trippable) | Lottie (Linux Foundation spec) |
| Skeletal character rig (bones, IK, mesh deform, skins) | **DragonBones JSON format + runtime** | DragonBones (MIT) + `pixi-dragonbones-runtime` |
| Schema definition + validation + types + JSON-Schema | **Zod** (single source → TS types + runtime validation + JSON-Schema export for the future LLM front-end) | `zod`, `zod-to-json-schema` |
| Editorial/scene sequencing concepts | **Align Story IR with OTIO** (tracks/clips/transitions/markers); optional export adapter later — not a runtime dep | OpenTimelineIO (ASWF) |
| Render + audio + mux + batch | **Remotion** | `remotion`, `@remotion/*` |
| Reusable nested timelines (clips/environments) | **Remotion nested compositions** (pre-comp pattern) | reuse; see §13.3 |
| Scene/clip transitions + match-cuts | `@remotion/transitions` (+ `flubber` for morph-match) | reuse; see §11.2 |
| Text fit/measure + captions + fonts | `@remotion/layout-utils`, `@remotion/captions`, `@remotion/google-fonts` | reuse; see §11.3 |
| Palette interpolation (color-script) | `culori` / `d3-interpolate` (OKLab) | reuse; see §11.4 |
| Motion blur | `@remotion/motion-blur` | reuse |
| GPU effects on the rig canvas | **Pixi filters** (glow/bloom/blur/displacement) | reuse |
| Full-frame color grade / post | SVG/WebGL filters + FFmpeg filter pass | reuse |
| Gradients + per-object shading/depth | SVG `linear/radialGradient` + `feDropShadow`/`feGaussianBlur` (+ optional `feDiffuse/SpecularLighting`); Pixi filters on rig | reuse; see §11.1 |
| Easing curves | Remotion `Easing` + `bezier-easing` | reuse |
| Springs / secondary motion | Remotion `spring()` (+ `popmotion`) | reuse |
| IK (where not using DragonBones) | `ikjs` / `IK.ts` | reuse |
| SVG path morphing | `flubber` / GSAP MorphSVG (free) | reuse |
| Noise (sway, saccades, organic motion) | `simplex-noise` | reuse |
| Smooth curves through moving points | `d3-shape` (curveCatmullRom/Basis) | reuse |
| Blobby organic shapes | `blobshape` / `blobs` | reuse |
| Word-level timing for lip-sync (later) | `@remotion/install-whisper-cpp` (local Whisper) | reuse, local/free |
| v1 character/prop art | **Humaaans / Open Peeps / unDraw** (free, mix-and-match SVG parts) | reuse |
| Content-hash caching | `object-hash` + cache dir (no DAG framework) | reuse |
| Library / registry / versioning | content-addressed store + `library/index.json` catalog + `animation.lock` (npm-style); optional npm packaging — **no custom registry server** | reuse patterns; see §13.2 |
| Many instances of one rig (crowds) | **DragonBones factory** (parse once, spawn many) | reuse |
| High-count object detail (scatter + instancing) | `poisson-disc-sampling` (even scatter) + SVG `<symbol>`/`<use>` + **Pixi `ParticleContainer`** (animated) + baked sprites (static) | reuse; see §10.1 |

**Genuinely ours (small):** the semantic Story IR schema, the Scene IR's *extensions* over Lottie (camera-parallax, generator layers, rig refs, audio cues, morph/filter channels), the generator library, and the thin per-frame compositor glue.

---

## 5. Pipeline Architecture

```
script.yaml
  → P0  Parse + validate          → Story IR (semantic: beats, characters, narration, intent)  [NOW]
  → P2  Entity / asset resolver    → resolve name@version → content hash (via index + lockfile),
                                      build dependency DAG, dedup, set up rig instancing → defs   [NOW]
  → P5  Scene builder (lowering)   → Scene IR (concrete layers, keyframes, camera)               [NOW]
  → P6  Layout (lite: named anchors) → positions, no-overlap                                     [NOW-lite]
  → P8  Camera director (lite)     → camera keyframes from beat intent                            [NOW-lite]
  → V   Validate Scene IR (Zod)                                                                   [NOW]
  → P10 Render (Remotion host + sub-renderers) → frames (+ audio muxed)                           [NOW]
  → out.mp4   (content-hashed, golden-diffable)

  Inserted later, each as a pure IR→IR pass with no neighbor changes:
    P1 LLM script-expander (Story IR → Story IR)
    P3 AI asset-gen (offline SDXL → decompose → vectorize → rig-ready parts)
    P4 TTS narrator (narration → wav + Whisper word-align)
    P7 Timing/sync solver (align keyframes to word timings)
    P9 Rich transition compiler
    smart P6 (intelligent layout)
```

- Each stage: pure function, seeded RNG, no wall-clock. Cache key = `hash(pass_id + pass_version + input_subtree + config)`.
- Validation (Zod) runs at every IR boundary; golden IR fixtures per pass; per-stage versioning in the cache key.
- Orchestration is plain typed function composition + content-hash caching (no heavyweight DAG framework at this scale).

---

## 6. The Two-Layer IR

### 6.1 Story IR (semantic, human/LLM-authorable; YAML; Zod-validated)

High-level intent: beats, characters, narration, camera *intent* (not pixels/frames). OTIO-aligned sequencing concepts (a beat ≈ a clip on a track). No frame numbers, no coordinates.

```yaml
title: "How neurons talk"
characters:
  narrator: { rig: narrator_bird, palette: warm }
beats:
  - id: b1
    say: "Your brain is a network of neurons."
    show: [ { generator: bead-string, as: neuron_chain } ]
    camera: slow_push_in
  - id: b2
    say: "When one fires, a pulse travels down the chain."
    action: [ { on: neuron_chain, do: pulse_travel } ]
    camera: hold
```

### 6.2 Scene IR (concrete, deterministic; JSON = Remotion `inputProps`; Lottie superset)

Adopts Lottie's `{a,k}` animated-property model (`a`=animated?, `k`=value or keyframes; keyframes carry bezier easing handles) and GSAP-style label positioning. Extends Lottie with: `camera`/`parallax`, `rig` layers (DragonBones refs), `generator` layers, `audio` cues, and `morph`/`filter` channels.

```jsonc
{
  "scene_ir_version": "1.0",
  "config": { "w":1920, "h":1080, "fps":30, "duration_frames":2700 },
  "defs": {
    "palette": { "bg":"#1b2a4a", "accent":"#ffcf4d", "ink":"#0d1b33" },
    "easings": { "smooth":[0.4,0,0.2,1], "pop":"backOut" },
    "assets":  { "server_icon": { "uri":"asset://server.svg", "kind":"svg" },
                 "river_loop":  { "uri":"asset://river.lottie.json", "kind":"lottie" } },
    "rigs":    { "narrator":    { "uri":"rig://narrator_bird.dbones.json", "kind":"dragonbones" } }
  },
  "audio": [   // empty in M1; filled by the LATER TTS pass
    { "id":"vo_b1", "kind":"tts", "src":"cache://…wav", "at":0, "duration_frames":540,
      "transcript":"Your brain is a network of neurons.", "align":[] }
  ],
  "scenes": [{
    "id":"b1", "at":0, "duration_frames":540,
    "labels": { "reveal":90 },
    "camera": {
      "position": { "a":1, "k":[ {"t":0,"s":[0,0],"e":"smooth"}, {"t":120,"s":[200,0]} ] },
      "zoom":     { "a":1, "k":[ {"t":0,"s":1.0,"e":"smooth"}, {"t":120,"s":1.15} ] }
    },
    "layers": [
      { "id":"L_bg",     "type":"asset", "ref":"bg_gradient", "z":0, "parallax":0.2 },
      { "id":"L_neuron", "type":"generator", "gen":"bead-string", "z":4, "seed":7,
        "path":"asset://axon_curve.svg#path",
        "params": { "beads":9, "bead_radius":14, "blobbiness":0.35,
                    "pulse":{ "amp":0.25, "speed":1.4, "phase_step":0.6 },
                    "wave":{ "amp":10, "speed":0.8 }, "gooey":true, "fill":"#ffcf4d", "glow":true } },
      { "id":"L_morph",  "type":"shape", "z":5,
        "morph": { "a":1, "k":[ {"t":0,"d":"asset://coin.svg#path","e":"smooth"},
                                {"t":45,"d":"asset://earth.svg#path"} ] },
        "fill":  { "a":1, "k":[ {"t":0,"s":"#ffcf4d"}, {"t":45,"s":"#4d9fff"} ] } },
      { "id":"L_narr",   "type":"rig", "ref":"narrator", "z":10,
        "transform": { "position": {"a":1,"k":[{"t":0,"s":[400,540]},{"t":540,"s":[1500,540]}]},
                       "opacity":  {"a":1,"k":[{"t":0,"s":0,"e":"pop"},{"t":12,"s":100}]},
                       "scale":    {"a":1,"k":[{"t":0,"s":0,"e":"pop"},{"t":12,"s":100}]} },
        "rig_state": { "clips":[{"anim":"idle","loop":true},{"anim":"wave","at":60}],
                       "pose":{"expression":"curious"} } }
    ],
    "stagger": [ { "group":["d1","d2","d3"], "offset_frames":6 } ],
    "transition_in": { "kind":"morph", "from":"server_icon", "to":"cloud_icon", "dur":15 }
  }],
  "provenance": { "story_ir_hash":"sha256:…", "passes":["lower@1.0","layout@0.4"] }
}
```

**Key choices:** `{a,k}` unifies static and animated values; `parallax` + `camera` keyframes give 2.5D depth with no 3D engine; `rig_state` is a *thin pointer* (selects/sequences a rig's internal clips, never re-describes bones); rig layers compose via `parts` (intra-rig variant selection) and `attach` (inter-rig scene-graph parenting) — see §8.1; `e` names a StyleKit easing so no motion is ever accidentally linear; any layer may carry an animatable `effects[]` stack and a scene may carry a `post[]` grade (§11); a scene carries one `light` and layers carry `shading` + gradient fills for per-object depth (§11.1); `provenance` enables content-hash skip + golden diff.

---

## 7. Layer Taxonomy

Four complementary layer families, each the right tool for a kind of motion:

| Layer type | Use | Renderer |
|---|---|---|
| **asset** | fixed art, animate transforms (icons, logos, props) | React/SVG |
| **text** | typography with kinetic-reveal presets + auto-fit + (later) narration sync | React/SVG (§11.3) |
| **rig** | constructed characters, **identity-stable**, posed by named clips (no-AI-drift guarantee) | DragonBones via pixi |
| **shape** | vector shapes with morph/path/fill channels (coin→planet match-cuts) | React/SVG + flubber |
| **generator** | procedural/organic/parametric structures (water, fire, smoke, clouds, particles, crowds, neuron bead-strings) — computed per-frame from `params + seed + frame` | React/SVG + d3-shape/noise |
| **clip** | a reusable *nested composition* — a self-contained animated Scene-IR fragment (its own layers + timeline) placed/scaled/parameterized by the parent (a "brain-cell animation" dropped into many videos) | Remotion nested composition (§13.3) |

---

## 8. Character Rig Model (DragonBones)

Adopt the **DragonBones JSON format** (free, MIT, code-generable) and render with `pixi-dragonbones-runtime` inside a Remotion-hosted Pixi canvas — **this is the committed rig render path** (chosen over a pure-SVG interpreter specifically to get full mesh deformation). DragonBones natively provides: bone hierarchy, **IK**, **full mesh deformation (FFD)**, skins/slot-attachment swaps, and named animations — covering most of what we'd otherwise hand-roll.

**Full mesh deformation is in scope.** FFD lets bones deform a textured mesh (not just rigidly transform a sprite), which gives bendy/squashy limbs, blobby wobble, and organic warping (e.g. a character melting/stretching, the neuron string's wavy bending) without per-frame art. This is the capability the pure-SVG path could not provide, and the reason Pixi-canvas-in-Remotion is the committed choice.

- **Identity guarantee:** art = fixed atlas; code only changes transforms + attachment swaps + bone poses ⇒ zero per-frame distortion, deterministic, diffable.
- **Determinism in Remotion:** seek the armature to absolute time `frame/fps` each frame; wrap render in `delayRender`/`continueRender`.
- **Lip-sync readiness (later):** reserve `viseme_*` mouth attachments in the skin; the TTS/Whisper stage generates an attachment-swap timeline from word timings — no rig changes, no new art.
- **v1 art:** build rigs from free mix-and-match SVG parts (Humaaans / Open Peeps), bound to DragonBones slots by layer name.
- **"Alive" defaults (StyleKit, see §9):** every character runs idle + breathing + Poisson blink + spring follow-through by default, so even static shots feel alive.

### 8.1 Compositional rigs & objects

There is **no separate "object" concept**: a prop with moving parts is a small rig, a static prop is an asset layer, a vehicle is a rig. Characters and objects live in the **same composition graph** and compose by the same rules. Composition happens at two levels:

- **Intra-rig (inside one rig).** DragonBones supports **sub-armatures** (a slot's attachment can itself be a child armature) and **skins/slot-swaps**. A modular character (head A + body B + outfit C) is therefore *one self-contained rig* with variant axes; the runtime handles nesting transparently. The Scene IR only **selects parts** via a `parts` field on a rig layer.
- **Inter-rig (between rigs in a scene).** The animation layer adds **scene-graph parenting/attachment**: a rig layer can `attach` to a named **bone or slot** of another layer (prop in hand, hat on head, character on vehicle). Transforms compose down the tree (camera → layer → parent bone → child). `attach.bone` follows a bone (own draw order); `attach.slot` injects into the parent's draw order.

Each rig is **self-describing** via its library manifest, which declares **mount points** (bones/slots that may be attached to) and **variant axes** (swappable parts), so a rig is a typed black box, not something whose internals are poked:

```jsonc
{ "id":"person_base", "version":"1.2.0", "kind":"rig", "format":"dragonbones",
  "mounts":   { "handR":{"bone":"handR"}, "head_top":{"bone":"head"} },
  "variants": { "head":["head_round","head_oval"], "outfit":["lab_coat","hoodie"] },
  "deps":     ["atlas/person_base@1.2.0"],
  "provenance": { "source":"OpenPeeps", "license":"CC0" } }
```

Scene IR usage (part selection + attachment):

```jsonc
{ "id":"L_hero",  "type":"rig", "ref":"person_base",
  "parts": { "head":"head_round", "outfit":"lab_coat", "palette":"warm" } }
{ "id":"L_sword", "type":"rig", "ref":"sword", "z":11,
  "attach": { "to":"L_hero", "bone":"handR", "inherit":["position","rotation","scale"] } }
{ "id":"L_hat",   "type":"rig", "ref":"hat",
  "attach": { "to":"L_hero", "slot":"head_top" } }
```

---

## 9. Motion-Quality Layer — the Kurzgesagt "house style" (StyleKit)

A shared `StyleKit` module every scene draws from, so quality is a consistent, tunable constant rather than per-scene hand-tuning. Quality is the **floor**, not an upgrade: a plainly-authored scene already comes out polished.

| Kurzgesagt signature | System | Implementation |
|---|---|---|
| Snappy, never-linear motion | curated **easing library** (anticipation + overshoot) | Remotion `Easing` + named curves |
| Pop-in with life | **squash & stretch** on entrances/impacts | `spring()` on scale |
| Follow-through / "alive" | **damped springs** on appendages; **breathing**; **Poisson blink**; **seeded simplex micro-sway** + saccades | `spring()` + `simplex-noise` |
| Cascading reveals | **stagger** (per-index offset delays) | `<Sequence>` offset = `index * staggerFrames` |
| Shape transformation | **SVG path morph** (first-class, mid-scene) | `flubber` / MorphSVG |
| 2.5D depth | **parallax + depth-of-field** (far layers blur/desaturate) + gentle camera push-in | per-layer `parallax` + camera keyframes |
| Ambient richness | **generator library** (particles, dust, organic motion) | §10 |
| Soft premium finish | **look layer** — soft shadows, glow, gradients, faint grain, per-scene limited palette | SVG filters + palette tokens (§11 `effects`/`post`) |
| Premium motion feel | **motion blur** on fast moves (shutter-angle) — biggest lever vs stiff tweens | `@remotion/motion-blur` |
| Per-object depth (the Kurzgesagt look) | **Shading & Depth** (§11.1) — default-on supporting gradient shapes (contact shadow, form shade, rim, AO, glow) from a single scene `light` + layer `z`; gradient fills everywhere | SVG gradients + lighting filters |

---

## 10. Generator Library

A registry of **parametric generator components**: each is a small module that, given `params + seed + frame`, emits an animated sub-tree (elements + their procedural motion). Deterministic (seed+frame). Extensible: adding a generator = adding one module, no IR or pipeline changes.

Initial set: ✅ `bead-string` (neurons/chains with traveling pulse + wavy bending + blobby wobble + optional gooey merge) · ✅ `scatter` (procedural density — starfields/dust/foliage/sparkle/crowds, §10.1) · ✅ `water` (stacked translucent scrolling wave bands + foam) · ✅ `particles` (dust/foam/bubbles/stars — looping drift/rise/fall field) · ✅ `fire` (layered flickering flames + warm gradient + rising smoke) · ✅ `crowd` (fields of small head+body creatures with idle bob + blink-squash). Later: `smoke`, `clouds`, `energy`.

**Reuse for generators:** `d3-shape` (smooth curves through moving points), `simplex-noise` (organic undulation), `blobshape` (organic blobs), SVG "gooey" filter (merge), `getPointAtLength`/`svg-path-properties` (placement along a path). Pulse propagation is one line: `phase = frame*speed − index*phase_step`.

**Default guidance:** for most shots prefer ingesting a free **Lottie** loop as an asset layer (e.g. water/fire); reach for a procedural generator only when it must react to camera/parallax or be parametrically controlled.

### 10.1 Object detail (hundreds of small shapes) & the shape budget

Kurzgesagt objects are densely detailed — many tiny shapes (craters, spots, foliage, sparkle, grain) per object. This is supported two ways, and is primarily a **render-budget** concern, not an art one.

- **Authored detail:** an asset SVG or a rig part texture may contain arbitrarily many shapes (it is just art). Use SVG `<symbol>` + `<use>` for repeated motifs to keep markup small.
- **Procedural detail (✅ built):** the **`scatter` generator** distributes N small shapes over a region with seeded variation — motif (`dot`/`star`/`blob`), per-element size/color/rotation/phase, distribution (jittered even `grid` or seeded `random`), and per-element `twinkle`/`drift`/`pulse` driven by `frame + phase`. Even coverage via a near-square jittered grid (poisson-disc-like); deterministic from `seed`. Enforces the shape budget below (clamp + `console.warn`, no silent truncation).

**Detail × performance strategy (laptop-honest, deterministic):**

| Detail kind | Strategy | Rationale |
|---|---|---|
| static, high-count | **bake/flatten** → one cached, content-hashed group or rasterized sprite | one draw vs thousands of live DOM nodes |
| animated, high-count | **Pixi `ParticleContainer`** (GPU instancing) on a canvas layer | scales to thousands; SVG DOM does not |
| repeated motif | SVG `<symbol>` + `<use>` | dedup markup |
| surface-bound (spots on a deforming creature) | **bake into the rig part texture** → deforms with FFD automatically | avoids animating thousands of shapes on a moving mesh |
| any | a per-scene **shape budget**, with a logged warning when exceeded (no silent truncation) | matches the "no silent caps" rule; keeps laptop render times bounded |

Status: **`scatter` generator DONE (2026-06-22)**; baking + Pixi `ParticleContainer` instancing are the remaining ongoing performance work. Authored multi-shape assets work from day one. Determinism holds (seeded scatter — verified byte-identical across two cold renders; content-hashed bakes to come). Shape budget = 2000 elements/layer (`SCATTER_SHAPE_BUDGET`), clamped + warned.

---

## 11. Channels, Effects & Post-processing

- **Morph channel** (`morph`): **✅ IMPLEMENTED (2026-06-22, ADR-003 #1).** First-class, mid-scene path morphing on the `shape` layer, with `fill` interpolating alongside. The `morph` channel holds keyframed SVG path `d` strings (`{a,k}`); `src/render/ShapeLayer.tsx` locates the active segment for the frame and interpolates the two `d` strings with **`flubber`** (resamples differing point counts), eased through the StyleKit (never linear), while the `fill` colour interpolates on the same window. Geometry source precedence: `morph` wins over a `shape` primitive. Verified byte-identical across two cold render processes (`gl:'angle'`, project `projects/shapes-demo`). **Primitives** (the other half of the shape socket): `shape: { kind, …params }` selects a `@remotion/shapes` maker (rect/circle/ellipse/triangle/star/polygon/pie/heart); `@remotion/paths` (`getBoundingBox`) frames morph paths. **Fill** is a solid (animated) colour OR a linear/radial gradient lowered to an SVG `<defs>` gradient whose id is derived deterministically from the layer id; **stroke** is an optional colour+width. Parallax + the §11.1 shading/effects wrappers are applied by `<Scene>` exactly like other layers.
- **Layer effects stack** (`effects[]`): an ordered, animatable per-layer effect stack — glow, drop-shadow, blur, color-adjust, displacement/`turbulence` (feTurbulence+feDisplacementMap for ripple/flow/heat-haze), gooey merge, and **motion blur**. (The earlier single `filter` channel folds into this stack.) Reuse: SVG filters (CPU, per-SVG-layer), **Pixi filters** (GPU, for the rig canvas), `@remotion/motion-blur`.
- **Composition/scene post stack** (`post[]`): full-frame grade applied after compositing — color-grade/LUT, vignette, bloom, grain, chromatic aberration, light leaks. Reuse: SVG/WebGL filters + an FFmpeg post pass.
- **Transitions**: wipes/slides/fades/custom between scenes and clips via **`@remotion/transitions`** (the `transition_in`/`transition_out` fields lower to these).

```jsonc
"effects": [ { "kind":"glow", "k":{"intensity":{"a":1,"k":[{"t":0,"s":0},{"t":12,"s":0.8}]}} },
             { "kind":"drop_shadow", "blur":8, "opacity":0.25 },
             { "kind":"motion_blur", "shutter":180 } ],
"post":    [ { "kind":"color_grade","lut":"warm" }, { "kind":"vignette","amount":0.2 },
             { "kind":"grain","amount":0.05 }, { "kind":"bloom","threshold":0.8 } ]
```

**Motion blur** is a StyleKit default on fast moves — it is the largest single quality lever separating premium motion graphics from stiff tweens, and Remotion provides it natively.

### 11.1 Shading & Depth (per-object supporting gradient shapes)

Kurzgesagt depth is **compositional, not post-processing**: every object carries a small stack of supporting gradient shapes (contact shadow, form shade, rim, AO, glow), all consistent with one scene light. This is a **systematic, default-on layer of the compositor** — derived automatically per object, not hand-authored.

- **Scene-level `light`** (single source): `{ dir, elevation, color, intensity, ambient }`.
- **Per-layer `shading`** (default-on via StyleKit; overridable): generates supporting shapes from the object's silhouette + light + `z`:

| Supporting shape | Purpose | Derived from |
|---|---|---|
| `contact_shadow` | seats the object on ground/bg (soft gradient blob) | silhouette + light dir + `z` |
| `form` | volume on the body (lit→dark gradient overlay, masked to silhouette) | silhouette + light dir |
| `rim` | bright edge on the lit side | silhouette + light dir |
| `ao` | darkening where objects meet | overlap + `z` |
| `glow` | emissive halo | object + intensity |

- **Compositor per-object order (back→front):** `contact_shadow → object → form overlay → rim/highlight → glow`.
- **Gradients are first-class, animatable fills** everywhere (linear/radial, palette-tokened): `fill: { gradient: { type, stops, angle } }`.
- **Between-layer depth** (already in §9): far layers get atmospheric tint/desaturate + blur via parallax `z`.

Reuse: native SVG `<linearGradient>`/`<radialGradient>`, `feDropShadow`/`feGaussianBlur` (soft shadows), optional `feDiffuseLighting`/`feSpecularLighting` (form), Pixi filters on the rig canvas. Deterministic — pure functions of `light + z + silhouette`.

**✅ PAINTING extension (2026-06-23, ADR-009 / `2026-06-23-painting-style-system-design.md`).** The §11.1 model now also does **real form-shading**, driven by an OPTIONAL stylekit `paint` sub-table (`defs.stylekit.paint`, DATA in `library/stylekits/*.json` — absent → flat, so the default look is unchanged) and a generic mechanism in `src/render/paint.ts` applied to EVERY shape/asset layer, gated by `floor.shading`: a solid `fill` token becomes an SVG gradient whose stops are an **AUTO shade-ramp** of that fill via **`culori`** (OKLab L±`shadowL`/`highlightL` + warm-highlight/cool-shadow hue shift) along `lightDeg` (linear/radial) — the shape paints itself volumetric with zero per-token authoring; a **rim** is a lighter inner stroke (the ramp highlight) masked to the lit side; **texture** (grain) + **glow** are emitted as the **core-effects `grain`/`glow`** ops (reused, not reimplemented); and scene **atmosphere** (`<Atmosphere>` dark backdrop gradient + warm focal pool, vignette scaled by `paint.atmosphere.vignette`, + a per-layer **depth grade** darkening/desaturating far layers) sits the world in an atmospheric space. Pure (culori + SVG + seeded turbulence) → byte-identical cross-process; verified on the forest-cross-section study (`examples/forest-study.yaml`).

```jsonc
"light":   { "dir":120, "elevation":60, "color":"#fff6e0", "intensity":0.8, "ambient":0.35 },
"shading": { "form":true, "contact_shadow":true, "rim":0.3, "ao":true, "glow":0 },
"fill":    { "gradient": { "type":"radial", "stops":[["#ffd86b",0],["#f08c2e",1]], "angle":120 } }
```

Status: **M2 — IMPLEMENTED (2026-06-22).** Compositor (`src/render/shading.tsx` + `Scene.tsx`): scene-level directional light wash + vignette (`SceneLook`), per-object contact shadow seated by the light, and a silhouette-following rim/AO/glow CSS filter — default-on via StyleKit (`DEFAULT_LIGHT`/`DEFAULT_SHADING`), overridable per layer, background-exempt. Deterministic (static styles; byte-identical across separate processes). **Approximations / deferred:** per-object *form-shade masked to silhouette* is approximated by the scene-level directional wash + rim (not a true per-silhouette gradient overlay yet); **gradient fills** (first-class linear/radial on shape/generator layers) are typed in the IR but not yet rendered; far-layer atmospheric tint not yet added.

### 11.2 Transitions & match-cuts

Scene/clip boundaries are first-class. `transition_in`/`transition_out` (and a `transition` between scenes) lower to concrete effects:

| Kind | Mechanism |
|---|---|
| `cut` / `fade` / `wipe` / `slide` / `iris` | `@remotion/transitions` (reuse) |
| `mask` / `shape-reveal` | SVG mask animated open (StyleKit easing) |
| `morph-match` | a shape **morphs across the boundary** (coin→planet) via `flubber`/MorphSVG |
| `match-cut` | a **shared element keeps position/scale/rotation across the cut** for continuity — linked by `match: { from:"L_x@sceneA", to:"L_y@sceneB" }` |
| `camera-continuous` | the camera move carries across the cut (shared camera keyframes) |

Match-cuts and camera-continuous transitions are the Kurzgesagt "seamless idea-to-idea" feel; both are deterministic (the compositor interpolates the linked element / camera across the boundary). **✅ M2 DONE (2026-06-22):** `match-cut`/`morph-match` bridge the cut with a `flubber`-morphed shared-element shape over a crossfade; `camera-continuous` shares one uninterrupted translate+scale through the boundary; `iris`/`mask` are real SVG reveals — all registered by the `core-transitions` plugin into the engine `transitions` extension point (core `Composition.tsx` resolves via the registry, no hardcoded switch).

Status: **IMPLEMENTED (2026-06-22) — multi-scene storytelling + transitions.** The lowering pass (`src/pipeline/lower.ts`) now maps **one beat → one scene** and sequences them on the GLOBAL timeline: each scene's `at` is cumulative (`at[i] = at[i-1] + dur[i-1] − overlap[i]`), `duration_frames` comes from the beat's `duration` (seconds/frames, default `DEFAULT_BEAT_SECONDS`), and `config.duration_frames = Σ duration_frames − Σ overlaps`. Each beat's `transition` lowers to the scene's `transition_in` (first beat's is dropped). The compositor (`src/render/Composition.tsx`) renders the whole `scenes[]` as one continuous film via **`@remotion/transitions` `TransitionSeries`**: a `.Sequence` per scene + a `.Transition` (overlap = `transition_in.duration`) before each scene whose inbound transition is non-`cut`; a `cut`/absent transition butts segments together (hard cut). `fade`/`wipe`/`slide` use their dedicated presets (timed by the StyleKit "smooth" bezier so no transition is linear); `iris`/`mask`/`morph-match`/`match-cut`/`camera-continuous` fall back to `fade()` for now (their proper SVG-mask / flubber / shared-element compositors land in later milestones). `Root.tsx`'s `calculateMetadata` recomputes the same `Σ dur − Σ overlaps` and throws if it disagrees with `config.duration_frames` (no silent truncation). **Determinism:** verified byte-identical across two separate render processes (decoded video-stream MD5) on `gl:'angle'` with the procedural provider — `TransitionSeries` and `linearTiming` are pure functions of the frame clock. Verified projects: `projects/blip-story` (4 scenes, fade·fade·slide, 366f) and `projects/neuron-story` (3 scenes).

### 11.3 Text & kinetic typography

A first-class `text` layer (split out from `asset` in the taxonomy): `{ type:"text", content, font, style, fit?, anim }`.

- **Style:** palette-token color (ties into the color-script, §11.4), weight, size.
- **Fit:** auto-size/wrap to a box via `@remotion/layout-utils` (`fitText`/`measureText`) so labels never overflow — no manual sizing.
- **Animation presets (`anim`):** per-word / per-char **stagger reveals**, typewriter, pop-in, slide-up, and **number count-up** — built on StyleKit easing + the stagger system.
- **Narration sync (later, M3):** word-timings from local Whisper drive per-word reveal/highlight; captions via `@remotion/captions`.
- **Fonts:** bundled/local fonts (or `@remotion/google-fonts`), loaded via `delayRender` before render for determinism.

Reuse: `@remotion/layout-utils`, `@remotion/captions`, `@remotion/google-fonts`. **M2** (kinetic reveals) / **M3** (narration-synced text).

### 11.4 Color-script (palette-per-beat / mood)

The emotional color arc of a video (warm intro → cold problem → hopeful resolution) is a **first-class color-script**, not ad-hoc per-shape colors.

- **Story IR:** each beat may declare a `mood`/`palette` → the arc across the whole video.
- **Scene IR:** `defs.palette` is a **token set**, and **every fill, gradient, and `light.color` references a token** (single source) — so swapping the palette recolors the entire scene coherently.
- **Mood shifts:** palettes **interpolate across a transition** in a perceptual color space, so a mood change reads as a smooth global shift.
- **Library:** named `palette` / `stylekit` entries are reusable units (§13).

Reuse: `culori` / `d3-interpolate` (OKLab perceptual interpolation). Deterministic. **M2.**

> The visual effects model deliberately mirrors the audio model (§12): `effects[]` ↔ per-track audio FX, `post[]` ↔ the audio mix bus, and SFX-from-events ↔ `effects[]` triggered by animation — both picture and sound are driven by the same animation events for coherence.

---

## 12. Audio, Narration & Sound Design (narration + captions + SFX + music/ducking DONE; lip-sync + whisper-precision later)

Remotion handles audio natively. The Scene IR carries `audio[]` cues (narration/sfx/music) + a parallel visual `captions[]` track. The whole audio stack below is now BUILT (narration 2026-06-22; captions/SFX/music+ducking 2026-06-23); only lip-sync and whisper-precision word alignment remain.

- ✅ **Narration (DONE 2026-06-22)** — OFFLINE TTS synthesizes each beat's `say` into a **content-addressed, cached wav** at BUILD time (golden rule 2: voice never touches frames/runtime — exactly like `factory:gen` source material / the vendored font), the compile path emits a `kind:"narration"` `audio[]` cue at the beat's scene start, the compositor plays it via `<Audio>` in a `<Sequence from={cue.at}>`, and `renderMedia` muxes it (h264+aac). The TTS engine is **abstracted + swappable** (`src/cli/narrate.ts`): **espeak-ng** is the deterministic always-available DEFAULT; **Coqui XTTS v2** is wired via an isolated venv (`.venv-tts/bin/tts`, needs its own Python 3.11 env) and FALLS BACK to espeak-ng with a warning if missing — the cached wav is the deterministic artifact regardless of which engine produced it. **Determinism (golden rule 1):** the engine runs ONCE (skip-if-exists), so a re-render replays the FIXED wav → BOTH the decoded video AND audio streams are byte-identical across cold processes, even though a TTS engine may be stochastic. Compile entry: `src/cli/narrate-pass.ts` (wiring) + `src/cli/render.ts` (`--engine`/`--voice`/`--wpm`; `--no-audio` to skip). Demo: `examples/narration-demo.yaml` → `projects/narration-demo`.
- ✅ **Captions / subtitles (DONE 2026-06-23, §11.3/§12)** — narration-synced ON-SCREEN text, DERIVED from the SAME authored `say` line + the SAME narration cue window, so it is deterministic WITHOUT whisper (we authored the text). The narrate pass emits a `captions[]` cue (parallel to `audio[]`); `src/render/CaptionTrack.tsx` renders a styled, readable bottom-centre pill in a Remotion `<Sequence from={cue.at}>`. Two cadences: `line` (whole line for the window, default) or `words` (cumulative even-split karaoke — a deterministic step function of the local frame, no whisper timestamps). Default-on with narration; `--no-captions` / `--caption-mode words`. Dropped on an `--alpha` render (captions belong to the finished film). We deliberately did NOT pull `@remotion/captions` (its value is grouping a whisper TOKEN STREAM — the precision path is the deferred follow-up).
- ✅ **SFX-from-events (DONE 2026-06-23, §12)** — a sound effect attached to an EVENT lowers to a `kind:"sfx"` `audio[]` cue at that event's frame (`src/cli/sfx-pass.ts`): `show[].sfx` (an element entrance → the scene start) and `beat.sfx[]` (a beat accent → scene start + offset). The SFX palette (tick/pop/whoosh/ding/thud/click) is SYNTHESIZED OFFLINE by `ffmpeg` lavfi math sources + envelopes into the shared content-stable `library/sfx/<name>.wav` cache (`src/cli/sfx.ts`) — NO external sourcing, deterministic (no random seed), skip-if-exists — then copied into the project assets and played via `<Audio>`. Remotion muxes every `<Audio>` (narration + sfx + music) into one aac track; we never reimplement mixing (ADR-003).
- ✅ **Music bed + ducking (DONE 2026-06-23, §12)** — a story-level `music` directive (a built-in ffmpeg-synthesized ambient bed `calm`/`drone`/`uplift` in `library/music/`, or an asset ref) → ONE `kind:"music"` cue spanning the timeline (`src/cli/music-pass.ts`), `<Loop>`-tiled to fill any length (the cached bed stays a few seconds → disk-safe), and DUCKED while VO speaks: a pure per-frame `volume(frame)` dips from `gain`→`duck` with linear `fade`-frame ramps whenever a narration window overlaps the global frame (`duckingAt` in `Composition.tsx` — needs only the narration windows, so it is byte-deterministic; overlapping windows take the MAX dip; sfx accents do NOT duck). `--no-music` skips it. **The `<Audio volume>` hook the narration MVP reserved is now the live ducking control.**
- **Word-level timing** via `@remotion/install-whisper-cpp` (local Whisper) → the **deferred PRECISION path**: drives lip-sync visemes (attachment-swap timeline) *and* whisper-accurate caption word-alignment (beyond today's deterministic even-split). Local + free.
- TTS/SFX/music *generation* is offline + cached; Remotion handles placement/sync/mixing/looping/ducking.
- **Audio-reactive visuals:** `@remotion/media-utils` `visualizeAudio`/`getAudioData` for beat-synced motion (future).
- **AUDIO-must-be-audible verify gate (DECISIONS 2026-06-23):** a build with audio is verified BOTH for cross-process determinism (decoded video md5 AND decoded audio md5 byte-identical) AND for AUDIBILITY (`ffmpeg volumedetect` mean loudness well above −60 dB — a present-but-silent track is a regression).

---

## 13. Asset & Rig Library — Strategy, Reuse & Composition

### 13.1 Sourcing

- **v1:** free/open vector assets — **Humaaans / Open Peeps** (mix-and-match SVG character parts), **unDraw** (props/scenes), free **Lottie** loops for ambient effects. This proves the rigged-character + render path with real on-style art, no drawing or AI required, and defines the rig-ready asset contract.
- **Later (P3, offline, one-time):** AI asset-gen — local SDXL + style LoRA + IP-Adapter/ControlNet → layer decomposition (occlusion-aware) → background removal (`rembg`) → vectorization (`vtracer`) → rig-ready layered parts conforming to the same contract. AI never enters the animation loop.

### 13.2 The library (reuse-first; package-manager patterns, not a custom registry)

The library is the durable, compounding asset. It grows; past videos must not change. Mechanisms:

| Concern | Mechanism |
|---|---|
| **Addressing** | human name + semver → resolved to a **content hash** (`object-hash`). `rig://person_base@1.2.0` ↔ `cache://sha256:…` |
| **Catalog** | `library/index.json` — namespaced (`characters/ props/ backgrounds/ generators/ kits/`), tagged, carrying each entry's manifest metadata. Local-first, no service. |
| **Deterministic re-renders** | `animation.lock` (npm-style lockfile) pins exact resolved hashes per project, so the library can evolve without altering past output; upgrades are opt-in per project. |
| **Dedup + instancing** | P2 resolver builds the dependency DAG, dedups shared sub-assets, and uses the **DragonBones factory** to parse a rig once and spawn many instances (crowds, repeated props) from shared data. |
| **Compounding reuse (presets/recipes)** | a **preset** is a named, reusable composed unit that references other entries — build a character/scene-template once, reuse everywhere; a preset is itself a cacheable library entry. |
| **Sharing (optional)** | a library namespace may be published as an npm package / versioned folder — reuse npm, don't build a registry server. |

```jsonc
// kits/narrator_bird.preset.json — composed once, reused across stories
{ "id":"narrator_bird", "kind":"preset", "base":"bird_base@2.0.0",
  "parts": { "beak":"beak_short", "palette":"warm" },
  "attachments": [ { "ref":"glasses@1.0.0", "mount":"head_top" } ] }
```

**Why the lockfile matters:** it reconciles "growing library" with "deterministic renders." Each video records the exact hashes it was built from, so improving a library rig never silently changes old videos. Composition and reuse reinforce each other: typed mount points + variant axes (§8.1) let presets compose rigs safely, and content-addressing makes a composed preset just another dedup-able entry — reuse compounds upward (parts → rigs → presets → scene templates).

### 13.3 Reusable units at every granularity (nested compositions)

The library holds reusable **kinds** at every granularity — not just static art, but finished *animations* and whole *scenes*. This is the "make a character / a brain-cell animation / a laboratory scene once, reuse in any video" requirement.

| Kind | What it is |
|---|---|
| `asset` | static SVG/Lottie/image |
| `rig` | skeletal DragonBones unit |
| `preset` | a *composed* character/object (rig + parts + attachments + palette) |
| **`clip`** | a reusable *animated* Scene-IR fragment with typed `params` + named slots (a "brain-cell animation") |
| **`scene-template` / `environment`** | a composed scene: background + props layout + camera presets + named **anchors** to drop characters/clips into (a "laboratory") |
| `generator` | parametric procedural component |
| `stylekit` / `palette` / `easing-set` | look + motion constants |

**Mechanism = nested compositions (reuse Remotion's native nesting; the After Effects "pre-comp" idea).** A `clip` is a self-contained sub-timeline placed/scaled/parameterized by its parent; an `environment` is a larger fragment exposing **anchors** (scene-scale analogue of rig mount points) where presets/clips drop in. The library is therefore **fractal**: part → rig → preset → clip → scene → video, every level a named, versioned, content-addressed entry — so a finished video is itself reusable.

```jsonc
// Scene IR: place a finished animation, parameterized (not copied)
{ "id":"L_braincell", "type":"clip", "ref":"brain_cell_pulse@1.0.0", "z":6,
  "at":"@reveal", "time_scale":1.0,
  "args": { "color":"#4d9fff", "speed":1.2 },          // typed params
  "overrides": { "L_caption": { "text":"neuron" } } }  // override inner slots by id
```

```yaml
# Story IR: compose a new video from reusable units
beats:
  - id: b1
    environment: laboratory                            # reuse the whole scene
    place:
      - { character: scientist, at: bench }            # reuse a composed character (preset)
      - { clip: brain_cell_pulse, at: screen, args: { color: blue, speed: 1.2 } }  # reuse a finished animation
    camera: establishing
    say: "Inside every neuron…"
```

**Reuse with overrides, not copies:** `clip`/`environment` accept `args` + `overrides`, so one entry serves many videos without divergence. **Determinism:** a clip's output is a pure function of `(version + args + overrides + seed)`, and that tuple is folded into its content hash — so two parameterizations are distinct, correctly-cached entries, and pinning a version (lockfile) freezes a reused animation exactly.

---

## 14. Risks & Unknowns

1. **DragonBones-in-Remotion determinism — RESOLVED in M1 (2026-06-22).** Pixi runs in a canvas inside a React/headless-Chrome render. The verified recipe is in §3 ("Determinism rule for sub-renderers"): **software GL (`swangle`) + `preserveDrawingBuffer:true` + synchronous `continueRender`**. NOTE: the M1 spike's initial claim (hardware `'angle'` + rAF gating) was **disproven by independent cross-run verification** — it held only within a single session; cold runs diverged (~all frames via GPU float variance, then ~3/150 via a paint-commit race). Lesson: always verify determinism across **separate process invocations**, not back-to-back in one run, and compare the **decoded video stream** (not just the container, which carries a wall-clock timestamp).
2. **Compositing sub-renderers** (SVG generators + Pixi rig) in one frame — z-order and color consistency between a Pixi `<canvas>` and SVG layers. Mitigation: a single compositor component with explicit z-sorting; M1 exercises Pixi-rig + one SVG generator together (Lottie ingest added in M2).
3. **Layout/timing solver is the real intelligence.** Going from semantic beats to non-overlapping positioned layers + camera moves is hard. Mitigation: ship a dumb deterministic layout (named anchor slots / templates) for M1; make P6–P9 smart later.
4. **Two-IR contract drift.** Mitigation: Zod validation at every arrow, golden IR fixtures per pass, per-stage versioning in cache key.
5. **AI asset-gen quality on a laptop** (later). Mitigation: it's offline/one-time; quantized models + human one-time cleanup of part layers (asset prep, not animation, so it doesn't violate "no manual animation tool").
6. **Shape-count / detail performance.** Hundreds of shapes per object × many objects × every frame can crater SVG-DOM render time on a laptop (§10.1). Mitigation: bake static detail (cached, content-hashed), Pixi `ParticleContainer` for animated detail, `<symbol>`/`<use>` for motifs, and a per-scene shape budget with logging. Prototype the SVG-vs-Pixi crossover threshold in M2.

---

## 15. Milestone 1 — Minimal Vertical Slice

**Goal:** smallest slice that exercises *every architectural seam* — Story IR → Scene IR → Remotion host (+ DragonBones sub-renderer **with mesh deformation** + a **generator** sub-renderer) → MP4 — deterministically. No LLM, no TTS, no smart solver; free assets allowed.

**Scope (one 5-second, 1920×1080, 30fps scene):**
- One **DragonBones character** (free sample or Humaaans/Open Peeps parts bound to DragonBones slots): idle clip + damped-spring head bob + Poisson blink, **plus one mesh-deformed (FFD) element** — e.g. a bendy/squashy limb or wobble — to prove full mesh deformation in the render path.
- One **generator layer** — a `bead-string` (neuron chain): traveling pulse + wavy bending + blobby beads — to prove the procedural/organic generator family end-to-end.
- One **background** layer with a `parallax` value (proves 2.5D depth).
- One **camera move:** slow push-in (`zoom` 1.0→1.15) + slight pan, driving the parallax differential.
- Authored as **Story IR YAML** (one beat) → run **P0, P2, P5, lite-P6, lite-P8, V** → emit Scene IR JSON.
- **Render** via Remotion (`renderMedia`), compositing the Pixi/DragonBones rig and the SVG generator, both driven by `useCurrentFrame()` → `out.mp4`.

**Acceptance (done-when):**
1. `script.yaml → out.mp4` runs with a single command; no manual steps in the animation loop.
2. Character identity is pixel-stable across frames (eyes/body never drift) — visually confirmed.
3. **Mesh deformation animates correctly** (the FFD element bends/wobbles) and the **generator** renders its traveling pulse — visually confirmed.
4. Re-running produces a **byte-identical MP4** (same content hash) — proves determinism (Pixi + generator both seeded/frame-driven) + caching/golden tests.
5. Scene IR validates against its Zod schema and is human-readable/diffable.

**M2 — ✅ COMPLETE (2026-06-22):** ✅ **Shading & Depth model** (§11.1), ✅ **multi-scene storytelling + transitions** (§11.2 — beat→scene sequencing on the global timeline + `@remotion/transitions` `TransitionSeries`; ✅ iris/mask/match-cut/morph-match/camera-continuous now REAL presentations — no longer fade fallbacks — resolved through the engine `transitions` registry populated by the **`core-transitions` plugin**), ✅ **reusable `clip` nested composition** (§13.3 — shared `defs.clips` + `clip`-layer refs + Essential-Graphics `params`/`args` + Remotion `<Sequence>` local timeline; per-instance namespacing/seeding → one clip used twice renders distinctly yet byte-identically; recursion to depth ≥ 2), ✅ **kinetic typography** (§11.3), ✅ **`environment`** (a library clip used as a full-scene backdrop — a lowering convention reusing the clip machinery, no new nesting), ✅ **compositional rigs** — `attach` (inter-rig scene-graph parenting onto a rig MOUNT, `inherit`-selected channels, pure per-frame world-anchor) + `parts` (opaque per-rig variant selection the provider interprets), ✅ **more generators** (water, particles, fire, crowd) + **data-viz** (the `core-dataviz` `chart` generator — bar/line/pie via `d3-shape`/`d3-scale`, draw-on), ✅ **object/prop specs** (the `core-objects` provider plugin), ✅ **footage / Lottie ingest** (`<OffthreadVideo>` + `@remotion/lottie`, frame-seeked), ✅ **morph channel** (shape layer), ✅ **layer `effects[]` + motion blur** (core-effects plugin), ✅ **compositing** (per-layer `blend` mix-blend-mode + track `matte`/`mask` SVG-mask, applied generically in the layer wrapper), ✅ **color-script / palette-per-beat** (§11.4 — `mood`/`palette` over the stylekit base + OKLab interpolation via `culori`), ✅ **alpha/codec output** (`--alpha` / `--codec` / `--format`). Deferred to M3+/Tier-B: rig instancing/crowds via the DragonBones factory + Pixi instancing + the SVG-vs-Pixi shape-budget crossover (§10.1), presets-as-library-entries. **M3+:** full **audio + sound design** (TTS, lip-sync, captions, **narration-synced text**, SFX-from-events, mixing — P4/P7), composition **`post[]`** grade, AI asset-gen (P3), smart layout (P6/P9), LLM script-expander (P1), **Tier-B GPU enablement** (GL Transitions / Pixi filters / three / skia).

> Even at one rig, M1 resolves assets **through the library registry + `animation.lock`** (name@version → content hash), so the deterministic-addressing seam is exercised from the start; full composition (attach/presets/instancing) lands in M2.

---

## 16. Open Questions

- Exact DragonBones↔Humaaans/Open Peeps binding workflow (auto-bind by layer name vs a small manifest), including authoring the FFD mesh for free parts that don't ship with one.
- Story IR DSL ergonomics: how much the human authors vs how much the lite layout/camera passes infer.

*(Resolved: rig render path is **Pixi-canvas-in-Remotion with full mesh deformation** — §8.)*
