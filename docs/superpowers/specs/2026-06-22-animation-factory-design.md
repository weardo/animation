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

**Genuinely ours (small):** the semantic Story IR schema, the Scene IR's *extensions* over Lottie (camera-parallax, generator layers, rig refs, audio cues, morph/filter channels), the generator library, and the thin per-frame compositor glue.

---

## 5. Pipeline Architecture

```
script.yaml
  → P0  Parse + validate          → Story IR (semantic: beats, characters, narration, intent)  [NOW]
  → P2  Entity / asset resolver    → dedup characters & assets into defs                         [NOW]
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

**Key choices:** `{a,k}` unifies static and animated values; `parallax` + `camera` keyframes give 2.5D depth with no 3D engine; `rig_state` is a *thin pointer* (selects/sequences a rig's internal clips, never re-describes bones); `e` names a StyleKit easing so no motion is ever accidentally linear; `provenance` enables content-hash skip + golden diff.

---

## 7. Layer Taxonomy

Four complementary layer families, each the right tool for a kind of motion:

| Layer type | Use | Renderer |
|---|---|---|
| **asset / text** | fixed art, animate transforms (icons, logos, labels) | React/SVG |
| **rig** | constructed characters, **identity-stable**, posed by named clips (no-AI-drift guarantee) | DragonBones via pixi |
| **shape** | vector shapes with morph/path/fill channels (coin→planet match-cuts) | React/SVG + flubber |
| **generator** | procedural/organic/parametric structures (water, fire, smoke, clouds, particles, crowds, neuron bead-strings) — computed per-frame from `params + seed + frame` | React/SVG + d3-shape/noise |

---

## 8. Character Rig Model (DragonBones)

Adopt the **DragonBones JSON format** (free, MIT, code-generable) and render with `pixi-dragonbones-runtime` inside a Remotion-hosted Pixi canvas — **this is the committed rig render path** (chosen over a pure-SVG interpreter specifically to get full mesh deformation). DragonBones natively provides: bone hierarchy, **IK**, **full mesh deformation (FFD)**, skins/slot-attachment swaps, and named animations — covering most of what we'd otherwise hand-roll.

**Full mesh deformation is in scope.** FFD lets bones deform a textured mesh (not just rigidly transform a sprite), which gives bendy/squashy limbs, blobby wobble, and organic warping (e.g. a character melting/stretching, the neuron string's wavy bending) without per-frame art. This is the capability the pure-SVG path could not provide, and the reason Pixi-canvas-in-Remotion is the committed choice.

- **Identity guarantee:** art = fixed atlas; code only changes transforms + attachment swaps + bone poses ⇒ zero per-frame distortion, deterministic, diffable.
- **Determinism in Remotion:** seek the armature to absolute time `frame/fps` each frame; wrap render in `delayRender`/`continueRender`.
- **Lip-sync readiness (later):** reserve `viseme_*` mouth attachments in the skin; the TTS/Whisper stage generates an attachment-swap timeline from word timings — no rig changes, no new art.
- **v1 art:** build rigs from free mix-and-match SVG parts (Humaaans / Open Peeps), bound to DragonBones slots by layer name.
- **"Alive" defaults (StyleKit, see §9):** every character runs idle + breathing + Poisson blink + spring follow-through by default, so even static shots feel alive.

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
| Soft premium finish | **look layer** — soft shadows, glow, gradients, faint grain, per-scene limited palette | SVG filters + palette tokens |

---

## 10. Generator Library

A registry of **parametric generator components**: each is a small module that, given `params + seed + frame`, emits an animated sub-tree (elements + their procedural motion). Deterministic (seed+frame). Extensible: adding a generator = adding one module, no IR or pipeline changes.

Initial set: `wave` (water surfaces), `bead-string` (neurons/chains with traveling pulse + wavy bending + blobby wobble + optional gooey merge), `particles` (dust/foam/bubbles/stars), `crowd` (fields of small characters). Later: `fire`, `smoke`, `clouds`, `energy`.

**Reuse for generators:** `d3-shape` (smooth curves through moving points), `simplex-noise` (organic undulation), `blobshape` (organic blobs), SVG "gooey" filter (merge), `getPointAtLength`/`svg-path-properties` (placement along a path). Pulse propagation is one line: `phase = frame*speed − index*phase_step`.

**Default guidance:** for most shots prefer ingesting a free **Lottie** loop as an asset layer (e.g. water/fire); reach for a procedural generator only when it must react to camera/parallax or be parametrically controlled.

---

## 11. Additional Channels

- **Morph channel** (`morph`): first-class, mid-scene path morphing on any vector/shape layer, with `fill` interpolating alongside. (flubber / MorphSVG.)
- **Filter channel** (`filter`): animatable SVG filters — `turbulence` (feTurbulence + feDisplacementMap) for ripple/flow/shimmer/heat-haze, gooey merge, glow, soft shadow.

---

## 12. Audio / Narration (designed-for now, built later)

Remotion handles audio natively. The Scene IR reserves `audio[]` cues now; the later TTS pass fills them:

- `<Audio>` for VO/music/SFX (multiple tracks, trim, per-frame volume); **muxed into the MP4 automatically** by the renderer.
- **Word-level timing** via `@remotion/install-whisper-cpp` (local Whisper) → drives lip-sync visemes (attachment-swap timeline) *and* captions (`@remotion/captions`). Local + free.
- TTS *generation* is external (any TTS, local or hosted, one-time/offline); Remotion handles placement/sync/mixing.

---

## 13. Asset Strategy

- **v1:** free/open vector assets — **Humaaans / Open Peeps** (mix-and-match SVG character parts), **unDraw** (props/scenes), free **Lottie** loops for ambient effects. This proves the rigged-character + render path with real on-style art, no drawing or AI required, and defines the rig-ready asset contract.
- **Later (P3, offline, one-time):** AI asset-gen — local SDXL + style LoRA + IP-Adapter/ControlNet → layer decomposition (occlusion-aware) → background removal (`rembg`) → vectorization (`vtracer`) → rig-ready layered parts conforming to the same contract. AI never enters the animation loop.

---

## 14. Risks & Unknowns

1. **DragonBones-in-Remotion determinism (#1 de-risk).** Pixi runs in a canvas inside a React/headless-Chrome render; it must be seeked to `frame/fps` and gated by `delayRender`/`continueRender` to stay byte-reproducible. *Prototype this first.* (Replaces the old BeginFrame risk.)
2. **Compositing sub-renderers** (SVG generators + Pixi rig) in one frame — z-order and color consistency between a Pixi `<canvas>` and SVG layers. Mitigation: a single compositor component with explicit z-sorting; M1 exercises Pixi-rig + one SVG generator together (Lottie ingest added in M2).
3. **Layout/timing solver is the real intelligence.** Going from semantic beats to non-overlapping positioned layers + camera moves is hard. Mitigation: ship a dumb deterministic layout (named anchor slots / templates) for M1; make P6–P9 smart later.
4. **Two-IR contract drift.** Mitigation: Zod validation at every arrow, golden IR fixtures per pass, per-stage versioning in cache key.
5. **AI asset-gen quality on a laptop** (later). Mitigation: it's offline/one-time; quantized models + human one-time cleanup of part layers (asset prep, not animation, so it doesn't violate "no manual animation tool").

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

**M2 (next):** more generators (water, particles, crowds), Lottie ingest, morph + filter channels, stagger. **M3+:** AI asset-gen (P3), TTS + lip-sync + captions (P4/P7), smart layout/transitions (P6/P9), LLM script-expander (P1).

---

## 16. Open Questions

- Exact DragonBones↔Humaaans/Open Peeps binding workflow (auto-bind by layer name vs a small manifest), including authoring the FFD mesh for free parts that don't ship with one.
- Story IR DSL ergonomics: how much the human authors vs how much the lite layout/camera passes infer.

*(Resolved: rig render path is **Pixi-canvas-in-Remotion with full mesh deformation** — §8.)*
