# Gemini Free-Tier Integration — Nano Banana imagegen + search-grounded research

**Date:** 2026-07-10
**Status:** approved (design)

## Goal

Use Google's **free-tier** Gemini models to make reels more engaging, without breaking the local-first /
determinism rules or requiring paid budget. Two capabilities, both **gated by `GEMINI_API_KEY`** (free, no
card, from AI Studio) — **inert and fully backward-compatible when the key is absent**.

1. **Nano Banana (`gemini-2.5-flash-image`, ~500 img/day free) → an `imagegen` backend.** Fills the AI-image
   gap (the SD/OpenVINO path was broken + deleted): custom illustrations, stylized backdrops for footage-less
   topics, and a consistent recurring brand mascot. Better quality than offline SD-Turbo, zero disk cost.
2. **Gemini 2.5 Flash + Google-Search grounding → richer research.** Fixes the biggest weak link: research
   comes back `thin` too often (GDELT is flaky). Search-grounded Gemini pulls specific, current, cited facts.

## Architecture fit (unchanged rules)

- **Determinism (golden rule 1/2):** the stochastic Gemini call runs ONCE OFFLINE at build into a
  CONTENT-ADDRESSED cache (hash of inputs, skip-if-exists); the render/replay reads the FIXED cached artifact
  (PNG / FactSheet JSON), so output stays byte-deterministic. Same pattern as TTS/whisper/imagegen today.
- **AI touches only the offline library** (golden rule 2): images land as `asset` catalog entries; facts land
  in the research cache. No provider/runtime change.
- **Graceful + gated:** no key, quota exhausted, or API error → fall back to today's behavior
  (Wikimedia/footage for images; `claude -p` + GDELT for research). The build NEVER fails.

## Design

### Shared client — `src/cli/gemini.ts`
- `geminiText(prompt, {search?, model?, systemInstruction?})` → `{ text, sources[] }`. Optional
  `tools:[{google_search:{}}]` for grounding; returns grounding source URLs.
- `geminiImage(prompt, {model?})` → a PNG `Buffer | null` (decodes the response `inlineData` base64).
- Both read `GEMINI_API_KEY`; return null / throw a typed "no key" error when absent. Model ids are
  env-overridable (`GEMINI_TEXT_MODEL` / `GEMINI_IMAGE_MODEL`) so a rename doesn't require a code change.
  Light throttle (free tier ~10 RPM) + one retry on 429/5xx.

### Nano Banana imagegen — `src/cli/imagegen.ts`
- Add a `gemini` backend: content-address {prompt, model, size, seed?} → cached PNG (skip-if-exists) → else
  `geminiImage(prompt)` → write PNG → register the `asset` catalog entry (existing provenance flow).
- Backend selection: `--backend gemini` / `IMAGEGEN_BACKEND=gemini`, or auto = gemini when `GEMINI_API_KEY`
  set. No key → the existing deterministic-placeholder behavior (no regression).
- The asset-scout gets a `gen:<prompt>` resolution path (peer of `wiki:`/`newsshot:`) so the architect can
  request a generated illustration for a beat when no real photo/footage fits; failure → footage fallback.

### Search-grounded research — `agents/research.ts`
- When `GEMINI_API_KEY` is present, gather the corpus via `geminiText(topic, {search:true})` FIRST (current,
  cited facts) and fold its text + source URLs into the existing corpus, THEN distill to the FactSheet (same
  strict-JSON schema, same cache). No key → the current GDELT + seed-article path, unchanged.
- Bump `research` PROMPT_VERSION; the grounded corpus makes `confidence:"sourced"` far more often + fills
  `sourceUrls` with real citations (which the data-viz/newsshot beats already consume).

## Verify

- Build both behind the key; with NO key set, confirm byte-identical behavior to today (a no-op gate).
- With a key: generate one real image (eyeball it) + one grounded FactSheet (check it's `sourced` with real
  citations). Confirm the cached artifacts replay deterministically across two cold renders.

## Non-goals / honest limits

- Not offline (Nano Banana/Gemini are online). Veo video-gen stays out (paid/pricey).
- Free-tier rate limits (10 RPM Flash / ~500 img/day) — fine for a few reels/day; throttled, not parallel-bombed.
- Free tier may train on inputs — acceptable for a public news channel; the key is env-only, never committed.
