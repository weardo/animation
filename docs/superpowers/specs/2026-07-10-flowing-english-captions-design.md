# Flowing English Captions (karaoke-flow) — Design

**Date:** 2026-07-10
**Status:** approved (design)

## Goal

On-screen subtitles that **flow with the narration** — short English phrases that light up word-by-word in
rhythm with the voice — so a **muted viewer reads along**. Subtitles are **always English**; narration stays
Hinglish/English. Not exact per-word sync — **phrase-accurate flow** is the target.

## Why (user intent, 2026-07-10)

Static long-sentence subtitles in the narration language (Hinglish/Devanagari) don't serve a muted viewer or a
non-Hindi reader. The channel's draw is the Hinglish *voice*; English *captions* widen reach and mute-viewing.

## Non-goals

- Exact per-word lip-tight sync (explicitly not required).
- Translating the narration itself (voice stays Hinglish).
- New ML models (reuse the existing whisper alignment).

## Design

All steps are **offline, content-addressed cached, deterministic** (the established narrate/research pattern).

### 1. English caption text — a translation pass (new)
`agents/caption-english.ts` (or a step in the narrate pass): for each beat's `say`, produce clean, punchy
**English** caption text via `claude -p`, cached by hash(say + PROMPT_VERSION). If the narration is already
English (`SARVAM_LANG`/lang starts `en`), skip translation and use `say` verbatim.

### 2. Flow timing — reuse the whisper alignment (no new ML)
The narrate pass already force-aligns the narration wav → `[{word,start,end}]` (seconds, cached). We do NOT need
the Hindi word *text* — only the real **speech timeline** (first speech start, per-word progression, last end).
Map each English word `i` of `M` onto that timeline **proportionally**: `start(i) = hindiTimeline(i/M · N)`
(interpolated across the N real Hindi word-starts). This rides the actual speech pace (pauses, speed) so English
flows as the narrator speaks. Fallback (no alignment): even-split across the cue window (existing behavior).

### 3. Chunking into readable phrases
Group the English words into short lines (~3-6 words), breaking at sentence punctuation (`. , ! ?`) or a max
length. The render shows the **chunk containing the active word** (a rolling phrase window), not the whole line.

### 4. Render — a new `flow` caption mode (brand-themed)
`CaptionTrack.tsx` gains `mode: 'flow'`: shows the current chunk with **accent-pop** highlighting —
- active word: brand **saffron** (`brand.accent`, default `#FA7A1E`), heavier/slightly larger
- already-spoken words in the chunk: full white
- upcoming words in the chunk: dimmed (~45% opacity)
Font **Mukta** (Latin), positioned per the current caption placement (higher, semi-transparent pill), English
is Latin script. Pure function of frame → deterministic.

### 5. Defaults & wiring
`productionize`/render default **reels** to English-flow captions. A flag (`--caption-mode line|words|flow` /
`--caption-lang`) switches back to line/narration-language. Absent alignment or translation → graceful fallback
(even-split flow, or narration-language line), never a failed build.

## IR / touch points

- `CaptionCue`: add `mode: 'flow'`; reuse `wordsTimed[]` (English words + `at` frames); optional `accent`.
- `agents/caption-english.ts`: the translation pass (claude -p, cached).
- narrate/caption pass: build flow cues (translate → chunk → proportional-time from the whisper envelope).
- `CaptionTrack.tsx`: the `flow` render (accent-pop, Mukta, brand accent).
- `productionize.ts` / `render.ts`: default reels to English-flow; keep the switch flags.

## Determinism / verify

Translation + timing are cached content-addressed (run-once, replay). Render is a pure fn of frame. Verify on
stills across two cold processes (byte-identical), and eyeball that the highlight tracks the phrase. Missing
whisper/translation → deterministic fallback, build never fails (the existing caption gate).

## Honest limits

- Sync is **phrase-accurate, not exact-per-word** (by design).
- Translation quality depends on `claude -p`; cached once per beat.
- whisper alignment isn't bit-exact across machines → the **cached** JSON is the deterministic record.
