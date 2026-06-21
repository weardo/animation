---
name: verify-render
description: Use before claiming a render or milestone works, and whenever adding or changing a pipeline pass, rig, generator, or library entry. Enforces determinism (byte-identical re-render), Scene-IR validation, and golden fixtures. Evidence before assertions.
---

# Verify a Render

Never claim "it works" without this. (CLAUDE.md rule 1.)

## Steps

1. **One command, no manual steps:** `script.yaml → out.mp4` via the factory CLI. If any manual step is required, it fails this gate.
2. **Validate the IR:** the Scene IR must pass its Zod schema at the boundary.
3. **Determinism check:** render the same script **twice** to different files; compare hashes (`object-hash`/`sha256`). They must match. If headless WebGL prevents byte-identical output, record the *closest reproducible* result and the exact caveat — do not claim determinism you didn't observe.
4. **Visual sanity:** character identity stable across frames (no drift); mesh deform animates; generators render their motion; camera/parallax reads as depth.
5. **Golden fixtures:** commit a golden Scene-IR JSON (and a small golden frame/hash) for the example; future changes diff against it.
6. **Report honestly:** state what passed, what didn't, and any caveat (per the spec §15 acceptance list). Failures are reported with the actual error output, not summarized away.

If something fails: `superpowers:systematic-debugging`, fix, re-run this whole gate.
