---
name: verify-render
description: Use before claiming a render or milestone works, and whenever adding or changing a pipeline pass, rig, generator, or library entry. Enforces determinism (byte-identical re-render), Scene-IR validation, and golden fixtures. Evidence before assertions.
---

# Verify a Render

Never claim "it works" without this. (CLAUDE.md rule 1.)

## Steps

1. **One command, no manual steps:** `script.yaml → out.mp4` via the factory CLI. If any manual step is required, it fails this gate.
2. **Validate the IR:** the Scene IR must pass its Zod schema at the boundary.
3. **Determinism check (do it right — this has bitten us):** render the same script in **two SEPARATE process invocations** (NOT back-to-back in one session — that masks GPU/timing non-determinism), and compare the **decoded video stream**, not the container: `ffmpeg -loglevel error -i a.mp4 -map 0:v -f md5 -` vs the same for `b.mp4`. The container carries a wall-clock `creation_time`, so byte-diffing the file alone gives false negatives/positives. If frames differ, localize (extract PNGs, count differing frames) before concluding. For Pixi/WebGL, the known-good recipe is software GL (`swangle`) + `preserveDrawingBuffer:true` + synchronous `continueRender` (see spec §3 / DECISIONS 2026-06-22). If true byte-identical is impossible, record the *closest reproducible* result and the exact caveat — never claim determinism you didn't observe across cold runs.
4. **Visual sanity:** character identity stable across frames (no drift); mesh deform animates; generators render their motion; camera/parallax reads as depth.
5. **Golden fixtures:** commit a golden Scene-IR JSON (and a small golden frame/hash) for the example; future changes diff against it.
6. **Report honestly:** state what passed, what didn't, and any caveat (per the spec §15 acceptance list). Failures are reported with the actual error output, not summarized away.

If something fails: `superpowers:systematic-debugging`, fix, re-run this whole gate.
