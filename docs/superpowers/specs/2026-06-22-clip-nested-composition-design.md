# Nested Composition (`clip`) — Design

**Date:** 2026-06-22 · **Status:** DONE (implemented + verified 2026-06-22). Implements spec §13.3 (reusable nested compositions) + the M2 `clip` item (`environment` is the named follow-on). Verified: byte-identical across two cold processes; one clip used twice with different `args` renders distinctly yet each reproducibly; a clip-containing-a-clip (depth ≥ 2: lower-third → badge → {shape,text,generator}) renders; domain-clean / style-clean / delete-the-plugin all green; typecheck clean; existing demos unaffected. Demo: `examples/clip-demo.yaml` → `projects/clip-demo`.

## Principle — adopt the editing-tool convention, don't invent

A `clip` is a **pre-composition**, exactly as in the tools we already align with — and we model it on their structure rather than a custom one:

| Concept | Our `clip` | The convention we copy |
|---|---|---|
| A reusable nested comp | `clip` | After Effects **pre-comp** · Lottie **precomposition** · Premiere/DaVinci **nested sequence / compound clip** |
| Shared definition + N instances | `defs.clips[id]` + `clip` layers with `ref` | **Lottie** `assets[]` (precomp) + a precomp layer's `refId` (our IR is a Lottie superset) |
| Per-instance parameters | exposed `params` set via `args` | AE **Essential Graphics / Master Properties** · Premiere **.mogrt** controls |
| Local timeline + group transform | `<Sequence from>` + a transform/opacity/effects group | AE precomp layer (own timeline, transform, effects on the whole) · Remotion **`<Sequence>` + component** |

Nothing here is novel: a clip is the precomp; `params` are Essential-Graphics controls; the render is a Remotion `<Sequence>`. We supply only the *wiring* into our IR.

## 1. Library (data) — the precomp definition

`library/clips/<name>/<name>.clip.json`, catalog `kind: clip` (already reserved):

```jsonc
{
  "params": {                              // the EXPOSED controls (Essential Graphics / mogrt)
    "title":  { "type": "string", "default": "Hello" },
    "accent": { "type": "color",  "default": "accent" },   // a palette token or hex
    "count":  { "type": "number", "default": 0 }
  },
  "duration_frames": 90,                   // the clip's own (local) length
  "layers": [                              // ordinary Scene-IR layer TEMPLATES (recursive: may contain `clip` layers)
    { "type": "shape", "id": "card",  "fill": { "$param": "accent" }, "shape": { ... } },
    { "type": "text",  "id": "label", "content": "{{title}}", "anim": { "preset": "rise" } },
    { "type": "text",  "id": "stat",  "content": { "$param": "count" }, "anim": { "preset": "count_up" } }
  ]
}
```

- **Param references** in templates: `{ "$param": "name" }` for any value, or `"…{{name}}…"` for string interpolation. Only **exposed** params are overridable (the Essential-Graphics rule) — a property not wired to a `$param` is fixed by the clip author.
- `params` are typed + defaulted, validated with Zod at the boundary (string · number · color · boolean · enum).

## 2. Story IR — instantiate (`show[].clip`)

Mirrors `show[].shape/text/generator`:

```yaml
- clip: lower-third@1.0.0
  as: title1                 # instance handle → the clip layer id (namespaces its internals)
  at: bottom-left            # placement anchor → transform.position (via layout pass)
  from: 12                   # OPTIONAL start frame within the scene (local-timeline offset)
  args: { title: "Neurons", accent: accent2, count: 86 }
  # transform/z/effects (scale/rotation/opacity/effects[]) also accepted in args — apply to the WHOLE unit
```

## 3. Scene IR — Lottie-style shared def + reference

- `defs.clips[clipId] = { params, duration_frames, layers }` — the resolved precomp **definition**, stored **once** (Lottie `assets` precomp).
- A new recursive layer in the union:
  ```
  ClipLayer = { type:'clip', id, ref, z, transform?, effects?, parallax?, from?, duration_frames?, args? }
  ```
  (Lottie precomp layer `refId` + transform + our `args` = Master Properties.) `layers` recursion lives in the *def*, so the def can reference other clips → arbitrary nesting.

## 4. Resolution (pure lowering pass)

1. Resolve each `show[].clip` ref from the library (content-addressed; pinned in `project.lock`).
2. Put its (param-aware) def in `defs.clips[ref]` **once** (deduped — N instances share one def, the Lottie/AE model). Recurse: a def's own `clip` layers resolve their refs into `defs.clips` too (cycle-detect via the dep set; depth cap).
3. Emit one `clip` **layer** per `show[].clip` instance: `{ ref, args, transform (from `at`/scale/…), from, z, effects }`.
4. **No per-instance expansion in the IR** — the def stays shared; args ride on the instance. (Keeps the IR DRY, exactly like a Lottie file with one precomp used many times.)

## 5. Render (the compositor — borrow Remotion)

A `clip` layer renders (recursively, via the existing `LayerView` dispatch):

```
def = defs.clips[layer.ref]
<Sequence from={layer.from ?? 0} durationInFrames={layer.duration_frames ?? def.duration_frames}>
  <group transform={layer.transform/opacity} + effects[]>      // whole unit moves/effects/parallax together
    {def.layers.map(t => LayerView(resolveParams(t, {...def.defaults, ...layer.args}), ctx'))}
  </group>
</Sequence>
```

- `<Sequence>` gives the **local frame** (resets to 0 inside) + time-shift — reuse-over-invent.
- `resolveParams` substitutes `$param`/`{{}}` from `args` (over the def's defaults) — pure, deterministic (the Essential-Graphics override).
- **Namespacing:** inside the clip, each inner layer's effective id = `layer.id + "/" + innerId` and any **seed** derives from `hash(layer.id + "/" + innerId)` — so the same clip used twice gets distinct, deterministic seeds + non-colliding ids.
- Recursion: a `clip` layer inside `def.layers` hits the same `LayerView` path → nesting to any depth, no special machinery.

## 6. Determinism & the standing gates

- Pure: resolved defs + args + Sequence local frame + derived seeds + CPU raster → byte-identical.
- Generic: clips are library DATA + a generic recursive layer → **domain-clean / style-clean / delete-the-plugin** gates all still hold (no core specialization).
- New verify: a demo that uses one clip **twice with different args** → byte-identical cross-process, and the two instances render **distinctly** (args differ) yet each reproducibly; plus a **clip-containing-a-clip** case (depth ≥ 2).

## 7. MVP scope vs follow-ons

- **MVP:** library clip defs + exposed `params` + `show[].clip` + shared `defs.clips` + `clip` layer (ref + args + transform + effects + local `from`/`duration`) + recursive render + namespacing + determinism.
- **Follow-ons:** `environment` (a scene-template clip = a full background+ambience bundle — just a clip used as a backdrop) · time **trim/remap** of a clip layer (AE time-stretch) · inline clip defs authored in a story (vs library-only) · exposing a clip's *timeline markers* to the parent.

## 8. Files touched (implementation preview)

`src/ir/scene.ts` (ClipLayer + `defs.clips`) · `src/ir/story.ts` (`show[].clip`) · `src/library/{catalog,loader}.ts` (`toClip(ref)`, like `toStyleKit`) · `src/pipeline/lower.ts` (resolve + dedupe into `defs.clips`, emit clip layers, recurse) · `src/render/Scene.tsx` + a `ClipLayer.tsx` (Sequence + group + `resolveParams` + recursive dispatch) · one `library/clips/*` + `examples/clip-demo.yaml`. No plugin, no core specialization.
