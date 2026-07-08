---
name: producing-news-reels
description: Use when producing a premium Indian-language (Hinglish) news / geopolitics EXPLAINER REEL in the animation factory — a vertical 9:16 short with native voiceover, animated maps (routes/markers/fly-to), cinematic-dark visuals, music + sound-effects, and a coherent narrative. Covers the voice engines (Sarvam Bulbul is the channel default), Devanagari/Hinglish typography, the OFFICIAL Government-of-India map (legally required), the geopolitics map toolkit, story STRUCTURE (not stitched facts), the audio-design layer (music bed + SFX + ducking + narration-driven beat durations), and the stale-artifact/verification gotchas. Read it BEFORE building a news-explainer reel so you don't ship a flat, mis-voiced, illegally-bordered, or silent-audio reel.
---

# Producing an Indian-language news-explainer reel

A geopolitics/news reel = a **9:16 vertical short** (~40-60s) built as ONE factory project
(`projects/<id>/story.yaml`). It layers: native **Hinglish voiceover** + **animated maps** +
**cinematic-dark visuals** + **music + SFX** over a **coherent narrative**. Author it like any scene
(read `building-scenes` first), then apply the specifics below. The `hormuz-reel` project is the
reference implementation.

## The positioning (why this niche)

Indian geopolitics/current-affairs content (Prashant Dhawan's "World Affairs" lane) has huge demand
but the incumbents use *simple* visuals. The edge = **that content niche + Johnny-Harris-tier
cinematic maps, in Hinglish**. Maps are the powerhouse of geopolitics-YouTube — make them the star.

## 1. VOICE — Sarvam Bulbul is the channel default

Free/local Indic TTS (IndicF5, indic-parler, Orpheus) all work and are wired, but the natural, young,
energetic Hinglish voice a channel needs lives behind a **paid-but-cheap API**. Ranked:

| Engine | Verdict |
|---|---|
| **`sarvam` (Bulbul v3)** | **USE THIS.** Native Hinglish code-switching, young voices, ₹30/10K chars (~₹3/reel, ₹1000 free credits ≈ 333 reels). One clean generation, no chunking. Needs `SARVAM_API_KEY`. |
| `indicf5` | Near-human but voice-CLONE (needs a reference wav) + ~10 min/line on the iGPU. Quality tier only. |
| `orpheus` | LLM-TTS with emotion tags, runs on the Iris Xe via Vulkan llama.cpp; female-only Hindi, ~1.5 min/line. |
| `indic-parler` | 21 languages, but mature/flat voices. |

**Authoring:** `--engine sarvam --voice shubh` (or aditya/dev/aayan/sunny for young male). Set the
env `SARVAM_API_KEY`. Beat `say:` lines are natural Hinglish — **Sarvam reads Latin loanwords
correctly** ("Strait of Hormuz", "important"), so DON'T transliterate for Sarvam. (Transliterate to
Devanagari ONLY for the local engines, which mangle Latin script.)

**Speaker names carry the accent/age** — a WRONG speaker sounds like the wrong language/age:
`indic-parler` Hindi speakers are **Rohit/Divya/Aman/Rani** — "Aditi" is BENGALI (made Hindi sound
Bengali). Sarvam young voices: shubh/aditya/dev/aayan/sunny.

**Pace:** Sarvam `pace` >1 = FASTER (1.15 is a good reel default). It's read via `SARVAM_PACE` env and
folded into the narration cache key (`style.pace`) so a change re-synthesizes. **If you change pace and
wavs don't re-synth, delete `assets/audio/*.wav`** (a cache-key omission bit this once).

## 2. TYPOGRAPHY — Devanagari needs a DUAL-SCRIPT heavy font

**Noto Sans Devanagari has ZERO Latin letters** — so Hinglish like "China की Weakness" splits into two
mismatched fonts (Devanagari in Noto, Latin falling back to thin DejaVu). Fix: **Mukta ExtraBold**
(`public/fonts/Mukta-ExtraBold.ttf`, OFL, dual-script Devanagari+Latin+digits) — one heavy font for all
Hinglish text. Set per text layer: `font: "Mukta", fontUri: "asset://fonts/Mukta-ExtraBold.ttf"`.
Captions already register a Devanagari face (`CaptionTrack.tsx`). Fonts vendored: DejaVu, Noto Sans
Devanagari (+Bold/Black), Mukta (ExtraBold/Bold) — all commercial-safe.

## 3. THE MAP — use `world-in` (OFFICIAL India), never `world-map`

**LEGALLY REQUIRED for an Indian channel:** India must render with the Government-of-India boundary
(J&K, Ladakh, Arunachal Pradesh). The generic `world-map`/Natural Earth shows *de-facto* boundaries =
**illegal in India, gets content removed**. Use the **`world-in`** generator-preset (a world basemap
with the dissolved Survey-of-India/LGD India swapped in). `generator: world-in` in every map beat.

**Winding-order gotcha (if you ever rebuild `world-in`):** d3-geo uses SPHERICAL winding to decide a
polygon's interior. Shapely's dissolve output must be re-oriented **clockwise** (`orient(sign=-1.0)`)
or d3 fills the COMPLEMENT (whole globe minus India → the frame goes solid fill). See the build steps
in the `world-in` commit.

## 4. MAP TOOLKIT — routes, markers, fly-to, texture (the geopolitics kit)

The `map` generator (core-dataviz) has a full toolkit, all authored as DATA, all pure fns of frame:
- **`routes`** — `[{ coords: [[lon,lat]...], arc: true, arrow: true, glow, draw_on }]` — shipping
  lanes/corridors that draw on along the great-circle. THE signature visual (e.g. show China's oil
  funneling through the Malacca chokepoint → the "weakness" is *visible*).
- **`markers`** — `[{ coord: [lon,lat], label, color, radius }]` + `markers_pop` — ports/cities/
  chokepoints, pop in. Coords are geographic → align exactly with the country geometry.
- **fly-to** — `center_to`, `scale_to`, `fly: { duration, easing }` — pan/zoom across the map in a beat.
- **texture** — `graticule: {step,color,opacity}` (lat/lon grid) + `ocean: "#..."` (filled sea).
- **region zoom** — `fit: false` + `projection: mercator` + `center: [lon,lat]` + `scale: N` (higher =
  tighter). NOTE: the preset defaults `fit: true` — you MUST set `fit: false` to use center/scale.

## 5. CINEMATIC-DARK look (Johnny Harris)

- **Palette:** near-black bg (`#0a0d14`), dark land (`#141c28`), one hot accent per beat (amber
  `#ffb020` / red `#ff4438` / teal `#2ee6a6`), white text (`#f5f7fa`). Highlighted country = vivid fill.
- **Depth:** a story-level `post:` grade — `color_grade` (contrast ~1.18) + `vignette` (~0.6) + `grain`
  (~0.055). This gives the cinematic feel; DON'T rely on giant blurred "glow" circle shapes (they
  misbehaved — a green-filled glow rendered amber and washed the frame). Vignette + map glow effects
  are enough.
- **Type:** huge Mukta ExtraBold, `drop_shadow` for legibility over maps, subtle `glow` on accent text.

## 6. NARRATIVE — a STORY, not stitched facts

The single biggest quality lever. A reel of disconnected fact-sentences feels cheap. Use **storytelling
STAGES with connective tissue**: HOOK → SETUP → STAKES → TURN → ESCALATION → THE MOVE → THE COUNTER →
INSIGHT → PAYOFF → CTA (~10 beats, ~50s). Pick ONE clear thesis. Bridge beats: "लेकिन असली डर China को…"
(*but the real fear is China's*) TURNS the viewer forward; "और भारत? भारत ने जवाब दे दिया…" sets up the
rivalry. Make the emotional climax an India-vs-China angle for this audience. **Keep every fact
verifiable** (e.g. Malacca Dilemma is a real term; ~80% of China's oil imports transit Malacca).

## 7. AUDIO DESIGN — music + SFX + ducking, and beat-durations that FIT

- **Music bed:** `music: { ref: "audio/<track>.mp3", gain: 0.6, duck: 0.32, fade: 16 }` — auto-ducks
  under the VO. The built-in math beds (`drone`) are near-inaudible (−39 dB) — use a **licensed
  royalty-free track** vendored to `assets/audio/`. Incompetech (Kevin MacLeod) is directly
  downloadable (CC-BY → **credit in the video description**); Pixabay/Mixkit are no-attribution but
  JS-only (not curl-able — user must download). Normalize the track (`loudnorm=I=-16`) so it's audible.
- **SFX:** the built-in recipes (`src/cli/sfx.ts`) were upgraded to cinematic quality — whoosh
  (pink-noise swoosh), thud/boom (sub-bass pitch-drop impacts), pop (UI), ding (bell), riser (tension
  build). Author per beat: `sfx: [{ name: whoosh, at: 2 }, { name: pop, at: 8 }, …]` (frame offsets)
  timed to transitions / text rises / route draws / marker pops / impacts. **Every animation should
  have a sound** — it's ~half of perceived polish. To swap in real sourced SFX, drop files into
  `library/sfx/<name>.wav` (skip-if-exists by name → they override the synthesized ones).
- **BEAT DURATIONS MUST FIT THE NARRATION.** Sarvam's output length VARIES run-to-run and doesn't scale
  linearly with pace, so *estimating* durations upfront → overlapping voice across transitions. The
  reliable recipe: synth once, READ the actual cue `duration_frames` from `scene.json`, then set each
  beat `duration = narration_seconds + ~0.9s` (gives a tight ~0.35s pause; the 16f transition eats the
  rest). Verify 0 overlaps in `scene.json` before the full render.

## 8. OPERATIONAL GOTCHAS (these bit repeatedly)

- **Verify the ARTIFACT, not the intent.** `out.mp4` is written ONLY on render *completion* — a hung or
  killed render silently leaves the OLD file. Always check `stat -c %y out.mp4` (mtime) + `ffprobe`
  duration on disk before claiming a change shipped.
- **Players cache previews.** VS Code's built-in player AND VLC show a stale cached copy after a
  re-render — close the tab/window and reopen, or use `mpv <file>` (reads fresh). This caused a whole
  false "audio is broken" investigation.
- **VLC "can't play any video" on this box** = VLC 3.0 hardware-decode (Intel VA-API) broken vs the
  bleeding-edge ffmpeg 8. Fix (already applied): `avcodec-hw=none` in `~/.config/vlc/vlcrc`.
- **GPU render is fine for reels.** `--gpu` (Iris Xe / `gl:'angle'`, `[GPU/perceptual]`) renders the
  blur-heavy scenes fast without crashing. Non-deterministic, but irrelevant for upload-once content.
  CPU (`RENDER_CONCURRENCY=2`) is the reliable fallback; on this box free RAM gates concurrency.
- **Clean stale audio assets.** `assets/audio/` accumulates a hashed wav per script version — after big
  rewrites, `find assets/audio -name '*.wav' -delete` (keep the vendored music) + `rm -rf .cache`, then
  re-render, so no orphaned/old audio lingers.
- **Sourcing assets:** fonts → Google Fonts GitHub raw (OFL). Music → Incompetech direct (CC-BY). SFX →
  synthesize (deterministic) or have the user download a Pixabay/Mixkit pack. Gated HF models
  (AI4Bharat) need an HF token; large HF downloads WEDGE at ~768 MB → `HF_HUB_ENABLE_HF_TRANSFER=1`.

## The channel is production-DONE; the leap not yet built

Voice, fonts, cinematic visuals, official-India map, the geopolitics map toolkit, music, SFX, and a
proven narrative structure are all reusable infrastructure — a new reel is a new `story.yaml`. The
un-built next milestone is **auto-scripting**: a verified news item → this `story.yaml` automatically
(via `claude -p`). That's the "channel produces them daily" leap and deserves its own brainstorming →
spec → build cycle. The narrative STAGES + beat-duration-fits-narration rules above are its spine.
