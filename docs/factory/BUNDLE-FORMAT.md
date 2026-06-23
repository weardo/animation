# Bundle / Export / Remote-Library Formats

**Date:** 2026-06-23 · **Status:** Specified + implemented. Closes the two deferred ADR-001 follow-ups:
a **specified bundle/export format** and the **`LibraryResolver` remote variant**. All three formats are
deterministic (content-addressed, no wall-clock as a payload input) and offline-first.

There are three portable artifacts. Each is a pure function of committed inputs → re-emitting from the
same inputs yields the same bytes (timestamps are metadata only, never a payload).

---

## 1. Project bundle — `.afbundle/` (`factory:bundle <id> [--zip] [--no-media] [--out <dir>]`)

A SELF-CONTAINED, shareable snapshot of one compiled project (`src/cli/factory-bundle.ts`). Everything
is relative — no absolute paths — so it is portable + re-renderable anywhere.

```
<id>.afbundle/
  bundle.json     ← manifest: bundle_format_version · project id/config · files[] (path + sha1) · content_hash
  project.json    ← project manifest (verbatim)
  scene.json      ← the deterministic compiled Scene-IR timeline (the render input)
  project.lock    ← pinned library deps (byte-identical re-render)
  assets/…        ← every vendored source artifact (fonts, svgs, specs, audio wavs, video, generated PNGs)
```

`bundle.json` lists files **sorted by path**, each with its `sha1` (object-hash over bytes), and a single
`content_hash` over that sorted manifest → same project ⇒ same bundle hash. A missing vendored asset is
WARNed per file but still bundled (honest, never silently dropped). `--zip` also emits `<id>.afbundle.zip`.

## 2. Editorial export — OpenTimelineIO (`export:otio <id>`)

A valid OTIO `.otio` (Timeline/Stack/Track/Clip/Gap/Transition) emitted BY HAND (no Python `opentimelineio`
dep; `src/cli/export-otio.ts`). Scenes → a flat editorial "Scenes" video track (clips + gaps + transitions,
`transition_in.kind` → `SMPTE_Dissolve`/`Custom_Wipe`); `audio[]` → an "Audio" track of `ExternalReference`s;
the full per-scene layer graph rides losslessly in namespaced `metadata["animation-factory"]`. Pure fn of
`scene.json` → round-trips into editors without losing the factory's authoring detail.

## 3. Remote library — publish / fetch (ADR-001 `LibraryResolver` remote variant)

The engine depends on the thin `LibraryResolver` interface (`src/library/interfaces.ts`), **not** on where
the library lives (ADR-001). The remote variant is realized for a local-first user as **publish → fetch a
local mirror**, after which the UNCHANGED `Library` (`src/library/loader.ts`) resolves it — the engine never
changes, only the library's location.

- **`factory:publish-library [--out <dir>]`** (`src/cli/publish-library.ts`) mirrors the whole `library/`
  tree into `<out>/library/…` and writes `<out>/files.json`:
  ```jsonc
  { "files_format_version": "1", "source": "library", "count": N,
    "content_hash": "sha256…",                 // aggregate summary (sha256 over `path\thash` per entry)
    "files": [ { "path": "stylekits/kurzgesagt.json", "hash": "sha256…", "size": 1234 }, … ] }
  ```
  `<out>/` is statically servable (`python -m http.server`, S3, any host). The aggregate `content_hash` is
  derived from the ROUND-TRIPPED file (the exact op fetch uses) so publisher + fetcher agree by construction.
- **`factory:fetch-library <baseUrl> [--into <dir>]`** (`src/cli/fetch-library.ts`) downloads `files.json` +
  every `library/<path>`, **verifies each file's sha256 against the manifest** (the integrity contract;
  aborts on any per-file mismatch), and writes a local mirror under `<into>/library/`. Verified byte-for-byte
  identical to the source. Fetch ONCE, then render fully offline against the mirror — `Library.from(<into>)`
  is a drop-in.

**Determinism / integrity:** per-file sha256 is the hard guarantee (every byte verified on fetch); the
aggregate `content_hash` is a fast summary (a drift there warns, since files already passed per-hash). A
remote registry SERVICE implementing `LibraryResolver` directly is a future drop-in; publish/fetch is the
offline-first realization that fits the local-first constraint today.
