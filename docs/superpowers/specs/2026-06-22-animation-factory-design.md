# Animation Factory — Design Spec

**Date:** 2026-06-22
**Status:** Draft for review
**Topic:** A code-driven, Kurzgesagt-style 2.5D animation pipeline that turns a story script into a rendered video.

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
- (Stylized **mesh / free-form deformation** is **in scope** via DragonBones FFD — see §8 — for bendy limbs, blobby wobble, and organic warping.)
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

**Determinism rule for sub-renderers:** every sub-renderer is driven by Remotion's `useCurrentFrame()` (DragonBones is *seeked* to `time = frame/fps`; Lottie to its frame), wrapped in `delayRender`/`continueRender`. No sub-renderer runs its own clock. This keeps the composite byte-reproducible.

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

Initial set: `wave` (water surfaces), `bead-string` (neurons/chains with traveling pulse + wavy bending + blobby wobble + optional gooey merge), `particles` (dust/foam/bubbles/stars), `crowd` (fields of small characters). Later: `fire`, `smoke`, `clouds`, `energy`.

**Reuse for generators:** `d3-shape` (smooth curves through moving points), `simplex-noise` (organic undulation), `blobshape` (organic blobs), SVG "gooey" filter (merge), `getPointAtLength`/`svg-path-properties` (placement along a path). Pulse propagation is one line: `phase = frame*speed − index*phase_step`.

**Default guidance:** for most shots prefer ingesting a free **Lottie** loop as an asset layer (e.g. water/fire); reach for a procedural generator only when it must react to camera/parallax or be parametrically controlled.

### 10.1 Object detail (hundreds of small shapes) & the shape budget

Kurzgesagt objects are densely detailed — many tiny shapes (craters, spots, foliage, sparkle, grain) per object. This is supported two ways, and is primarily a **render-budget** concern, not an art one.

- **Authored detail:** an asset SVG or a rig part texture may contain arbitrarily many shapes (it is just art). Use SVG `<symbol>` + `<use>` for repeated motifs to keep markup small.
- **Procedural detail:** a **`scatter` generator** distributes N small shapes over a region/path/surface with seeded variation (count, size/rotation jitter, palette color, optional per-element twinkle/drift). Reuse `poisson-disc-sampling` for even distribution; deterministic from `seed`.

**Detail × performance strategy (laptop-honest, deterministic):**

| Detail kind | Strategy | Rationale |
|---|---|---|
| static, high-count | **bake/flatten** → one cached, content-hashed group or rasterized sprite | one draw vs thousands of live DOM nodes |
| animated, high-count | **Pixi `ParticleContainer`** (GPU instancing) on a canvas layer | scales to thousands; SVG DOM does not |
| repeated motif | SVG `<symbol>` + `<use>` | dedup markup |
| surface-bound (spots on a deforming creature) | **bake into the rig part texture** → deforms with FFD automatically | avoids animating thousands of shapes on a moving mesh |
| any | a per-scene **shape budget**, with a logged warning when exceeded (no silent truncation) | matches the "no silent caps" rule; keeps laptop render times bounded |

Status: **M2 + ongoing performance concern.** Authored multi-shape assets work from day one; the `scatter` generator, baking, and Pixi instancing land in M2. Determinism holds (seeded scatter, content-hashed bakes).

---

## 11. Channels, Effects & Post-processing

- **Morph channel** (`morph`): first-class, mid-scene path morphing on any vector/shape layer, with `fill` interpolating alongside. (flubber / MorphSVG.)
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

```jsonc
"light":   { "dir":120, "elevation":60, "color":"#fff6e0", "intensity":0.8, "ambient":0.35 },
"shading": { "form":true, "contact_shadow":true, "rim":0.3, "ao":true, "glow":0 },
"fill":    { "gradient": { "type":"radial", "stops":[["#ffd86b",0],["#f08c2e",1]], "angle":120 } }
```

Status: **M2 (look), reserved-in-IR now** — `light`/`shading`/gradient-fill fields exist in the Scene IR from the start so adding the model changes nothing upstream.

### 11.2 Transitions & match-cuts

Scene/clip boundaries are first-class. `transition_in`/`transition_out` (and a `transition` between scenes) lower to concrete effects:

| Kind | Mechanism |
|---|---|
| `cut` / `fade` / `wipe` / `slide` / `iris` | `@remotion/transitions` (reuse) |
| `mask` / `shape-reveal` | SVG mask animated open (StyleKit easing) |
| `morph-match` | a shape **morphs across the boundary** (coin→planet) via `flubber`/MorphSVG |
| `match-cut` | a **shared element keeps position/scale/rotation across the cut** for continuity — linked by `match: { from:"L_x@sceneA", to:"L_y@sceneB" }` |
| `camera-continuous` | the camera move carries across the cut (shared camera keyframes) |

Match-cuts and camera-continuous transitions are the Kurzgesagt "seamless idea-to-idea" feel; both are deterministic (the compositor interpolates the linked element / camera across the boundary). **M2.**

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

## 12. Audio, Narration & Sound Design (designed-for now, built later)

Remotion handles audio natively. The Scene IR reserves `audio[]` cues now; the later TTS pass fills them:

- `<Audio>` for VO/music/SFX (multiple tracks, trim, per-frame volume); **muxed into the MP4 automatically** by the renderer.
- **Word-level timing** via `@remotion/install-whisper-cpp` (local Whisper) → drives lip-sync visemes (attachment-swap timeline) *and* captions (`@remotion/captions`). Local + free.
- TTS *generation* is external (any TTS, local or hosted, one-time/offline); Remotion handles placement/sync/mixing.
- **Sound design synced to animation:** the lowering pass emits **SFX cues from animation events** (pop on appear, whoosh on camera move, impact on squash) so sound tracks motion automatically rather than being hand-placed. SFX are library entries (`asset` kind) like any other.
- **Mixing:** per-track levels, music **ducking under VO**, and fades via Remotion per-frame `volume`; deeper processing (EQ/reverb/normalize) via prepared audio or an FFmpeg filter pass at mux.
- **Audio-reactive visuals:** `@remotion/media-utils` `visualizeAudio`/`getAudioData` for beat-synced motion.

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

1. **DragonBones-in-Remotion determinism (#1 de-risk).** Pixi runs in a canvas inside a React/headless-Chrome render; it must be seeked to `frame/fps` and gated by `delayRender`/`continueRender` to stay byte-reproducible. *Prototype this first.* (Replaces the old BeginFrame risk.)
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

**M2 (next):** **Shading & Depth model** (§11.1 — scene `light` + default-on per-object supporting gradient shapes + gradient fills), compositional rigs (`attach` between rigs, `parts` selection, presets), **reusable `clip` + `environment` nested compositions** (make-once/reuse-everywhere with args+overrides), rig instancing/crowds (DragonBones factory), object detail (`scatter` generator + baking + Pixi instancing + shape budget, §10.1), more generators (water, particles), Lottie ingest, morph channel, **layer `effects[]` + motion blur + transitions/match-cuts (§11.2)**, **kinetic typography (§11.3)**, **color-script / palette-per-beat (§11.4)**, stagger. **M3+:** full **audio + sound design** (TTS, lip-sync, captions, **narration-synced text**, SFX-from-events, mixing — P4/P7), composition **`post[]`** grade, AI asset-gen (P3), smart layout (P6/P9), LLM script-expander (P1).

> Even at one rig, M1 resolves assets **through the library registry + `animation.lock`** (name@version → content hash), so the deterministic-addressing seam is exercised from the start; full composition (attach/presets/instancing) lands in M2.

---

## 16. Open Questions

- Exact DragonBones↔Humaaans/Open Peeps binding workflow (auto-bind by layer name vs a small manifest), including authoring the FFD mesh for free parts that don't ship with one.
- Story IR DSL ergonomics: how much the human authors vs how much the lite layout/camera passes infer.

*(Resolved: rig render path is **Pixi-canvas-in-Remotion with full mesh deformation** — §8.)*
