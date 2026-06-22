---
name: verify-render
description: Use before claiming a render or milestone works, and whenever adding or changing a pipeline pass, rig, generator, or library entry. Enforces determinism (byte-identical re-render), Scene-IR validation, and golden fixtures. Evidence before assertions.
---

# Verify a Render

Never claim "it works" without this. (CLAUDE.md rule 1.)

## Steps

1. **One command, no manual steps:** `script.yaml → out.mp4` via the factory CLI. If any manual step is required, it fails this gate.
2. **Validate the IR:** the Scene IR must pass its Zod schema at the boundary.
3. **Determinism check (do it right — this has bitten us):** render the same script in **two SEPARATE process invocations** (NOT back-to-back in one session — that masks GPU/timing non-determinism), and compare the **decoded video stream**, not the container: `ffmpeg -loglevel error -i a.mp4 -map 0:v -f md5 -` vs the same for `b.mp4`. The container carries a wall-clock `creation_time`, so byte-diffing the file alone gives false negatives/positives. If frames differ, localize (extract PNGs, count differing frames) before concluding.

   **FAST loop (do this first — full videos are slow ~180s):** verify on STILLS, not the whole video — `render <project> --frames auto` renders ~5 PNG frames (~14s, no encode) that are byte-identical to the video's frames. Compare those PNGs across two cold runs (determinism) + eyeball them (correctness). Render the full video only for FINAL validation.

   **Recipe (procedural/SVG):** render with **NO gl backend (`chromiumOptions: {}`) = CPU raster** — deterministic AND disk-safe. NOT `gl:'angle'` (GPU; non-deterministic for blur/alpha-heavy SVG) and NOT software GL (`swiftshader`/`swangle`; balloons the disk). Determinism is a property of CONTENT+BACKEND, not just code — if pixels differ but the layer's JS markup is identical in isolation, suspect the render backend, not the generator. (Pixi/WebGL, if ever used, needs software GL + preserveDrawingBuffer + sync continueRender, and inherits the disk caveat.) If true byte-identical is impossible, record the *closest reproducible* result + caveat — never claim determinism you didn't observe across cold runs.
4. **Visual sanity:** character identity stable across frames (no drift); mesh deform animates; generators render their motion; camera/parallax reads as depth. ALWAYS *look* at a frame — determinism proves consistency, not correctness (a broken rig renders broken byte-identically).
   - **Stale-bundle gotcha:** if a code change doesn't appear in the render (e.g. an old asset/component still shows), Remotion served a cached webpack bundle. `rm -rf node_modules/.cache .remotion` and re-render before concluding anything about the code.
   - **Stale-pipeline-cache gotcha:** the pipeline content-caches Scene IR but the key does NOT include library state — after changing `library/index.json` or a rig's provider, `rm -rf .cache` so the scene re-lowers.
5. **Golden fixtures:** commit a golden Scene-IR JSON (and a small golden frame/hash) for the example; future changes diff against it.
6. **Domain-clean grep (ADR-007 — core specializes in NOTHING):** `src/` must hold ZERO hardcoded domain/demo references — neither subject words (`neuron`/`bead`/`blip`/`pip`/`dragon`/`axon`/`narrator`), nor `M1_REFS`/`M1_RIG_ANIM`/`RIG_CLIP_PLANS`, nor any PROVIDER PLUGIN NAME as logic (`blob-creature`/`dragonbones`). Run it on CODE lines (comments mentioning them are fine — hardcoded *behavior* is not):
   `grep -rnE 'neuron|bead|blip|[^A-Za-z]pip[^A-Za-z]|dragon|axon|narrator|M1_REFS|M1_RIG_ANIM|RIG_CLIP_PLANS|blob-creature' src/ --include='*.ts' --include='*.tsx' | grep -vE ':[0-9]+:\s*(//|\*|/\*)'` → must be EMPTY. Domain/demo knowledge lives ONLY in `plugins/`, `library/`, `examples/`. Provider selection is DATA (catalog `provider:` field) or URI-scheme convention (`proc://`), never a provider name branched on in core.
7. **Delete-the-plugin test (the decoupling proof — stronger than the grep):** the dependency arrow must point plugin→core, never core→plugin. Two checks: (a) `grep -rE "from ['\"].*plugins/" src/` is EMPTY (core imports no plugin); (b) move a built-in plugin dir aside and re-typecheck `src/`:
   `mv plugins/core-generators /tmp/_dtp && mv plugins/core-rigs /tmp/_dtp2 && npx tsc --noEmit; echo $?; mv /tmp/_dtp plugins/core-generators && mv /tmp/_dtp2 plugins/core-rigs` → tsc EXIT must be 0 with the plugins removed. A hollow re-import shell (a plugin that only `import { X } from '../../src/...'`) FAILS this — it proves the implementation still lives in core. (tsconfig `include: ["src"]` scopes the typecheck; plugins are only seen via imports.)
8. **Report honestly:** state what passed, what didn't, and any caveat (per the spec §15 acceptance list). Failures are reported with the actual error output, not summarized away.

   **ADR-007 carve-out on determinism:** when a pass is re-genericized so scenes become author-declared (not compiler-baked), the new output may legitimately DIFFER from old committed bytes. Verify REPRODUCIBILITY across cold processes + correct visuals — NOT byte-equality with the pre-change output.

If something fails: `superpowers:systematic-debugging`, fix, re-run this whole gate.
