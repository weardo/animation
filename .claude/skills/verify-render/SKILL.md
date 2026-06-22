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
6. **Report honestly:** state what passed, what didn't, and any caveat (per the spec §15 acceptance list). Failures are reported with the actual error output, not summarized away.

If something fails: `superpowers:systematic-debugging`, fix, re-run this whole gate.
