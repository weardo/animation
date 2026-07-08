---
name: producing-news-reels
description: Use when producing a premium Indian-language (Hinglish) news / explainer REEL on ANY subject in the animation factory — a vertical 9:16 short with native voiceover, animated maps (routes/markers/fly-to), cinematic-dark visuals, music + sound-effects, and a coherent narrative. Covers the voice engines (Sarvam Bulbul is the channel default), Devanagari/Hinglish typography, the OFFICIAL Government-of-India map (legally required), the map toolkit, story STRUCTURE (not stitched facts), the audio-design layer (music bed + SFX + ducking + narration-driven beat durations), and the stale-artifact/verification gotchas. Read it BEFORE building a news-explainer reel so you don't ship a flat, mis-voiced, illegally-bordered, or silent-audio reel.
---

# Producing an Indian-language news-explainer reel

A news / explainer reel = a **9:16 vertical short** (~40-60s) built as ONE factory project
(`projects/<id>/story.yaml`). It layers: native **Hinglish voiceover** + **animated maps** +
**cinematic-dark visuals** + **music + SFX** over a **coherent narrative**. Author it like any scene
(read `building-scenes` first), then apply the specifics below. The `hormuz-reel` project is the
reference implementation.

**⚠️ TOPIC-NEUTRAL.** This skill is the CHANNEL's FORMAT + CRAFT — it works for ANY
subject (geopolitics, economy, history, science, technology, a place, a person, an event). The concrete
examples below (a chokepoint, a border, an oil stat, two rival countries) are ILLUSTRATIONS from past
reels, NOT the domain — swap in whatever YOUR topic needs. Fixed = the CHANNEL (Hinglish, आप-respectful
narration, the official-India map WHEN India is shown) + the craft rules; the TOPIC is always yours.

## The positioning (why this niche)

Hinglish explainer / current-affairs content has huge demand, but the incumbents use *simple* visuals.
The edge = **Johnny-Harris-tier cinematic visuals + Hinglish**, on ANY subject. When the topic is
GEOGRAPHIC, maps are the powerhouse — make them the star; for a non-geographic topic, the equivalent HERO
visual (a chart, a diagram, archival footage, a data animation) is the star instead.

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

**⚠️ PRONUNCIATION EXCEPTIONS — proper nouns with a common HINDI name.** The "reads Latin correctly"
rule breaks for words that ALSO have a native Hindi reading: the Latin **"China"** gets read as Hindi
**चीन/चीना ("cheena")**, not English "chai-na" — and it VARIES run-to-run (temperature 0.9 is stochastic),
so a re-synth can flip it. FIX: spell such words PHONETICALLY in Devanagari to lock the English sound
deterministically — **"China" → "चाइना"** (chai-na). (Keep the Latin spelling in the `publish` description/
tags — that's text, not TTS.) When a name sounds wrong, audition 3-4 Devanagari spellings on one line +
montage them (like the voice audition) and pick. Likely culprits: country/city names with Hindi exonyms.

**Speaker names carry the accent/age** — a WRONG speaker sounds like the wrong language/age:
`indic-parler` Hindi speakers are **Rohit/Divya/Aman/Rani** — "Aditi" is BENGALI (made Hindi sound
Bengali). Sarvam young voices: shubh/aditya/dev/aayan/sunny.

**v3 DELIVERY TUNING (the storytelling lever — set 2026-07-08 after an audition).** Bulbul v3 has NO
emotion field; the expressiveness knobs are **speaker + `temperature` + `pace` + 48 kHz + punctuation**.
Channel defaults are now `speaker=shubh, temperature=0.9, pace=1.15, sample_rate=48000` — the flat
`temperature 0.6` / `24000` v3-defaults sounded lifeless; **0.9 + 48 kHz is a real, free delivery jump**
on the SAME voice (verified by A/B audition, `voice-audition/`). All three (pace/temperature/sample_rate)
are folded into the narration cache key (`style.*`) so a change auto-re-synthesizes; override per-render
via `SARVAM_TEMPERATURE` / `SARVAM_PACE` / `SARVAM_SAMPLE_RATE` env. Temperature is capped in practice
(~1.2 errors); 0.7 = steadier, 1.0 = more dramatic. **Bulbul v3 beats ElevenLabs/Cartesia for Indic in
Sarvam's blind study — it IS the best Hinglish storyteller; don't switch engines, tune this one.**
**PROSODY IS DRIVEN BY THE TEXT:** v3 runs an LLM text-analysis layer that infers emphasis/pauses/pacing
from punctuation → write SHORT PUNCHY lines, `…` for suspense, `?` for the hook, not long flat sentences.
To audition voices: loop `scripts/tts/sarvam_synth.py --speaker <name> --temperature <t> --sample-rate 48000`
over the 43 v3 speakers (young male: shubh/aditya/dev/aayan/sunny/advait) on one line + montage them.
**If you change pace/temp and wavs don't re-synth, delete `assets/audio/*.wav`** (cache-key omission bit this once).

## 2. TYPOGRAPHY — Devanagari needs a DUAL-SCRIPT heavy font

**Noto Sans Devanagari has ZERO Latin letters** — so Hinglish like "आज की Technology" splits into two
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
  lanes/corridors that draw on along the great-circle. THE signature visual (e.g. show a flow/supply-route funnelling through a chokepoint → the dependency is
  *visible*; or any path between two points).
- **`markers`** — `[{ coord: [lon,lat], label, color, radius }]` + `markers_pop` — ports/cities/
  chokepoints, pop in. Coords are geographic → align exactly with the country geometry.
- **fly-to** — `center_to`, `scale_to`, `fly: { duration, easing }` — pan/zoom across the map in a beat.
  UNDERUSED — a map should almost never sit still; a slow push or a pan to the subject adds life for free.
- **⚠️ ANIMATED BORDERS (`draw_on`) — DO NOT use on a CHOROPLETH map (it BREAKS the coloring).** Tested
  2026-07-08: adding `draw_on`/`draw_on_stroke`/`draw_on_fill` to a `world-in` choropleth made the whole map
  go DARK — the country highlight FILLS vanish (the draw-on ramp + per-feature stagger suppresses every
  polygon's fill for 100+ frames). Keep choropleth maps as INSTANT clean fills (they already look great).
  `draw_on` is for non-choropleth feature maps only. To make a choropleth "feel alive" use MOTION that
  DOESN'T touch the fills: `markers_pop`, a `routes` arrow with its own `draw_on` (a separate path — that
  works), `fly-to` (a slow push/pan), and `glow`.
- **⭐ PROJECTION — go beyond flat.** `projection:` accepts **`orthographic`** (a dramatic 3D **GLOBE** — the
  Johnny-Harris "spin to the region" establishing shot), `naturalEarth1`, `equalEarth`, `azimuthalEqualArea`,
  and `mercator` (the flat default). Open a doc/reel on an orthographic globe, then cut to a tight mercator
  region. (A globe rotation can be animated via fly-to's `center_to`.)
- **texture** — `graticule: {step,color,opacity}` (lat/lon grid) + `ocean: "#..."` (filled sea). NOTE: a
  RELIEF/terrain/hillshade look + GRADIENT (non-flat) polygon fills are NOT built yet — a future feature
  (raster elevation under the vectors / wire the paint-shading system to map polygons). For now, richness
  = draw-on borders + globe + fly-to + graticule + glow + tight framing.
- **region zoom** — `fit: false` + `projection: mercator` + `center: [lon,lat]` + `scale: N` (higher =
  tighter). NOTE: the preset defaults `fit: true` — you MUST set `fit: false` to use center/scale. **Zoom
  TIGHT to the relevant region** — a broad map (whole hemisphere) reads as unfocused; frame just the
  countries/region the beat is about, not a whole hemisphere.
- **`labels`** — `{ "<Country A>": "<Country A>", "<Country B>": "<Country B>", … }` (feature name → text) names countries at
  their projected centroid. **Name the relevant countries on every map beat** — an unlabeled map is
  disorienting. English names read naturally in Hinglish and help the algorithm.
- **Legible land:** non-highlighted land must be LIGHT enough to read against the dark ocean — use
  `fill`/`no_data_fill` ≈ `#223249` + `stroke` ≈ `#3a516c` (NOT `#141c28`, which vanishes into the sea).
  Highlighted countries still pop via their vivid choropleth fill.

## 5. CINEMATIC-DARK look (Johnny Harris)

- **Palette:** near-black bg (`#0a0d14`), dark land (`#141c28`), one hot accent per beat (amber
  `#ffb020` / red `#ff4438` / teal `#2ee6a6`), white text (`#f5f7fa`). Highlighted country = vivid fill.
- **Depth:** a story-level `post:` grade — `color_grade` (contrast ~1.18) + `vignette` (~0.6) + `grain`
  (~0.055). This gives the cinematic feel; DON'T rely on giant blurred "glow" circle shapes (they
  misbehaved — a green-filled glow rendered amber and washed the frame). Vignette + map glow effects
  are enough.
- **Type:** huge Mukta ExtraBold, `drop_shadow` for legibility over maps, subtle `glow` on accent text.
- **Footage over emojis/flat beats.** WHERE YOU'RE NOT ANIMATING (a "prices skyrocket" / "meanwhile" /
  establishing beat), use REAL graded footage, NOT an emoji (⛔🔥) or a bare word on a color — emojis read
  as "template", footage reads as "production". `factory:footage` fetches free stock clips from Pexels
  (`PEXELS_API_KEY`, free, commercial-safe) → content-addressed cache → `footage: <id>` in a story. Great
  for a cinematic opening (a tanker/ocean shot under the hook), a fuel-station "prices" beat, or the loop
  close. Keep it SPARSE (opening + close) so the maps stay the star.
- **⚠️ TAILOR THE EFFECTS TO EACH CLIP — there is NO one-size grade (user: "dark circle shadow doesn't
  always suit").** A blanket `darken + heavy vignette + full-frame dark scrim` CRUSHES a bright hero shot
  (a blue-sky port, a sunny sea). Match the treatment to the footage + mood: a BRIGHT clip keeps a LIGHT
  grade (`brightness ~0.9, contrast ~1.1`), little/no per-clip `vignette` (≤0.25), and — for text
  legibility — a **LOCALIZED scrim BAND behind the text only** (a `rect` ~1080×360 at the text's y,
  `opacity ~0.4` + a `blur` to soften its edges), NOT a full-frame dark overlay; rely on the text's own
  `drop_shadow`+`glow`. A MOODY clip (stormy sky, night) can take a darker grade + light vignette. Keep
  the story-level `post` vignette modest (~0.4) on footage-heavy reels so bright clips aren't crushed.
- **VERIFY EVERY CLIP — and BROWSE, don't take the first (user: "not always the first clip is best").**
  Pexels ranks by loose relevance → the top hit is often wrong: "fire"→fireworks, "military soldiers"→
  NAPOLEONIC REENACTORS, "warship"→a marina/just-water pan. Workflow: (1) `factory:footage "<q>" --list 8`
  prints candidates with **id, dims, duration, poster + mid-preview URLs, and the PAGE URL** — the page
  title/slug is the STRONGEST content signal (e.g. `.../indian-coast-guard-vessel-in-sea-patrol-...` = an
  actual Indian navy ship). (2) Pick a specific one: `--video-id <id>` (or `--index <n>`), not index 0.
  (3) VERIFY with a MULTI-FRAME CONTACT SHEET, never one frame — a subject is often revealed LATE (a clip
  that looks like "just water" pans to the ship): `ffmpeg -i c.mp4 -vf "fps=6/$DUR,scale=200:355,tile=6x1"
  -frames:v 1 sheet.png` then read it. Prefer honest, on-subject b-roll (a real Indian vessel, a real
  port) — credibility is the channel; never fake war footage.

## 6. NARRATIVE — a STORY with a VIRAL structure (biggest quality + growth lever)

A reel of disconnected fact-sentences feels cheap. Use **storytelling STAGES with connective tissue**:
HOOK → SETUP → STAKES → TURN → ESCALATION → THE MOVE → THE COUNTER → INSIGHT → PAYOFF+LOOP. Pick ONE
clear thesis; bridge beats (a "लेकिन असली सवाल…" TURNS the viewer forward; a "और…?" sets up the next stakes — the
emotional climax for YOUR subject). **Keep every fact verifiable.**

**⚠️ WRITE THE NARRATION AS ONE CONTINUOUS MONOLOGUE, THEN SPLIT IT INTO BEATS (the #1 narration bug).**
The trap: authoring each beat's `say` line IN ISOLATION → you get 5 self-contained HEADLINES stitched
together, not one person telling one story. It sounds incoherent even when each line is individually
dramatic (user caught this: "they sound like individual headlines stitched together"). THE FIX — write
the WHOLE script first as if speaking it in one breath, THEN cut it at the visual changes. **Beats are
where the VISUAL changes, not where the SENTENCE resets.** Then every beat MUST connect to the previous:
- **Pronoun/callback carry-over:** name a thing once, then refer back — "एक छोटा सा देश…" → next beat
  "रातों-रात *यही* Guyana…" (not re-introducing "Guyana" cold). Don't restate; advance.
- **Cause→effect chain:** "…11 अरब बैरल तेल।" → "*लेकिन इतनी दौलत ने* एक दुश्मन खड़ा कर दिया…" → each
  beat is the CONSEQUENCE of the last, joined by लेकिन / क्योंकि / तो / देखते ही देखते / नतीजा.
- **Zoom-out / stakes-raise connective:** "*अब ये लड़ाई सिर्फ दो देशों की नहीं थी* — पूरा नक्शा दांव पर था…".
- **Quote the antagonist** for drama instead of narrating it flatly: "Venezuela बोला — ये हिस्सा है तो मेरा।"
- **Closing device that lands on NOW + closes the hook loop:** "*और आज?* …ठीक बारूद के ढेर पर।" (echoes the
  hook's flashpoint → the visual+verbal LOOP). Don't just stop on a fact.
- **Conversational narrator POV**, like explaining to a friend ("सोचो…", "देखते ही देखते"), NOT a news ticker.
- The on-screen TEXT stays punchy headlines (scannable on mute); the VO is the flowing STORY — different jobs.
- **TEST before rendering:** read all `say` lines top-to-bottom as ONE paragraph. If it doesn't sound like
  one continuous story a person is telling, it's still headlines — rewrite the connectors, not the facts.

**⚠️ TALK TO THE VIEWER — DIRECT ADDRESS, not a monologue (the #2 narration lever, research-backed).** A
coherent monologue still NARRATES PAST the viewer. The engagement jump is making them feel *spoken to* —
a parasocial "a friend is explaining this to me" feeling that lifts watch-through. Convert third-person
statements into second-person conversation:
- **⚠️ REGISTER: address them with RESPECTFUL आप/आपको/आपका — NEVER तू/तुम/तुझे** (informal = disrespectful to an
  audience; user rule). Imperatives take the आप-form: सोचो→सोचिए, देखो→देखिए, समझो→समझिए, रुको→रुकिए, बताओ→बताइए,
  याद रखना→याद रखिए। Inclusive "we" (चलिए/आइए समझते हैं) makes it a shared journey. "India ने ये किया" → "अब समझिए
  India ने क्या किया"; "ये खतरनाक है" → "सोचिए, ये आपके लिए क्या मायने रखता है".
- **Ask the viewer questions** (rhetorical, then answer): "क्यों? क्योंकि…", "अगर ये बंद हो जाए, तो? …", "फिर क्या हुआ?".
- **PRE-COMMITMENT hook** (top ~7s): make them guess/answer along → psychological investment → they stay for
  the reveal. "एक second रुकिए — आपको क्या लगता है India ने क्या किया?" then pay it off later.
- **Conversational imperatives / narrator POV**: "देखिए", "ज़रा सोचिए", "ध्यान से सुनिए", "समझिए", "मान लीजिए आप India हैं…".
- **Takeaway close the viewer can carry** (more shareable than a flat fact): "तो अगली बार जब कोई कहे '…', याद
  रखिए — …" — this also closes the hook loop.
- **ASK FOR THEIR OPINION → drives COMMENTS (the strongest engagement signal for reach).** Weave a GENUINE
  opinion question that invites a reply: "आपको क्या लगता है — क्या ये दांव काम करेगा? नीचे comment में बताइए।",
  "आप उनकी जगह होते तो क्या करते?", "किसका पलड़ा भारी — X या Y? बताइए।" This is the ONE in-video
  CTA that's ENCOURAGED (unlike "subscribe करो", which breaks the loop and tanks completion — keep that in
  the DESCRIPTION). Best placement: a beat BEFORE the final loop line, or fold the opinion question INTO the
  close so it doubles as the loop. Make it a real, debatable question tied to the story — not a generic
  "comment below". A reel that sparks an argument in the comments gets pushed harder.
- **Pattern-break at drop-off zones** (~30/50/70%): shift rhythm/energy or drop a "लेकिन रुको, यहाँ twist है…".
- Keep facts verifiable + the flow coherent — direct address is HOW you say it, on top of the one-story rule,
  not instead of it. TEST: does it sound like someone TALKING TO ME, or reading AT me? If the latter, add
  a "you"/a question/an imperative.

**The proven YouTube-Shorts patterns (India, 2026) — bake these in:**
- **HOOK (0-3s) is make-or-break.** 70% retention at 3s ≈ 5× more viral. And **92% watch on MUTE** → the
  ON-SCREEN TEXT hook must hit in the FIRST FRAME (fast `anim: { preset: fade, duration: 5 }`, not a slow
  rise). Hook types: curiosity-gap / bold claim ("एक रास्ता, जो पूरी दुनिया हिला सकता है"), "No/Stop"
  ("ये मत समझना…"), stat-shock (a striking number, e.g. "20% X, एक छोटी सी वजह से"), identity-call ("अगर आप ये समझते हैं…").
  Start Hindi, end on an English keyword — natural AND helps the algorithm categorize.
- **FLOW = escalation.** Each beat raises stakes; fast visual tempo (fly-tos, route draws, marker pops =
  the "filmy" hero-zoom/whip-pan energy).
- **CLOSE = a LOOP, not a CTA.** CUT the in-video "Follow करो!" — a 3s CTA BREAKS the loop and tanks
  completion. Instead end on a LOOP: the last beat RETURNS to the hook's visual + repeats the hook TEXT
  verbatim (recontextualized by the narration) → visual + verbal loop → rewatches (which the algorithm
  rewards). Put the "follow / subscribe" CTA in the video DESCRIPTION. End mid-momentum, never on a hard
  period + black frame.
- **LENGTH.** 20-25s peaks completion for simple content — but a value-dense GEOPOLITICS EXPLAINER
  legitimately runs ~40-50s (depth is the draw); don't gut the content to chase 25s. Offer a separate
  tight "viral cut" (~30s) only if max reach is the goal.

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
- **MONITOR via the render log — every render now writes `projects/<id>/media/render.log`** (truncated
  per run): all stage lines (compile/narrate/sfx/music/vendor/done/errors) + fine-grained per-frame
  video progress, wall-clock stamped. `tail -f projects/<id>/media/render.log` is the canonical way to
  answer "is it rendering / where is it / did it stall?" — a frame count that stops advancing while the
  process lives = a HANG at that exact frame (map it to the beat). The terminal shows throttled 5% steps;
  the log is the full record. (This replaced ad-hoc scratchpad logging — it's always on, always there.)
- **FOOTAGE HANG (root-caused 2026-07-08) — now auto-fixed at the source.** A HEAVY raw clip (a 33-39 MB
  high-bitrate/4K Pexels download) makes Remotion's `<OffthreadVideo>` balloon the Rust compositor's RAM;
  on a swap-pressured box the decode BLOCKS at **0% CPU** and the whole render hangs (looks identical to a
  RAM thrash but isn't — 0% CPU = *blocked*, a thrash burns CPU). `factory:footage` now AUTO-TRANSCODES
  every fetched clip to a light h264/yuv420p proxy (≤1920px bounding box, CRF 26, 2500k peak cap, muted,
  ~2-6 MB) that replaces the served file — so a fresh fetch can never re-introduce the hang. Isolation
  proof: footage-alone, GPU-alone, GPU+footage all render fine with light proxies; only the fat source
  stalls. If you ever hand-place a video, downscale it the same way (`ffmpeg -vf "scale='min(iw,1920)'…"
  -crf 26 -maxrate 2500k -pix_fmt yuv420p -an`). ffmpeg-missing → the proxy step warns + keeps the raw
  file (never fails).
- **Players cache previews.** VS Code's built-in player AND VLC show a stale cached copy after a
  re-render — close the tab/window and reopen, or use `mpv <file>` (reads fresh). This caused a whole
  false "audio is broken" investigation.
- **VLC "can't play any video" on this box** = VLC 3.0 hardware-decode (Intel VA-API) broken vs the
  bleeding-edge ffmpeg 8. Fix (already applied): `avcodec-hw=none` in `~/.config/vlc/vlcrc`.
- **RENDER PERFORMANCE (a reel is ~3-5 min, not 10).** GPU (Iris Xe / `gl:'angle'`, `[GPU/perceptual]`)
  is now the DEFAULT — no flag needed; `--no-gpu` forces the CPU byte-exact path (only the determinism/
  golden gate needs it — the GPU tier is verified with VMAF, not cmp). The real speed lever is
  WORKERS vs RAM: each headless-Chrome render worker balloons, and too many on a low-free-RAM box THRASH
  swap (that was the ~7-min render — 14 workers on 1.7 GB free). Concurrency now auto-caps (reserve 4 GB
  + 2 GB/worker + hard-cap 6); `RENDER_CONCURRENCY=N` overrides. **Don't `rm -rf .cache` for a story-ONLY
  edit** — it forces a needless recompile; clear it only after a plugin/library/pass change. Narration/
  SFX/music are cached (instant on re-render). A hung render leaves the OLD file — check mtime+duration.
- **Clean stale audio assets.** `assets/audio/` accumulates a hashed wav per script version — after big
  rewrites, `find assets/audio -name '*.wav' -delete` (keep the vendored music) + `rm -rf .cache`, then
  re-render, so no orphaned/old audio lingers.
- **Sourcing assets:** fonts → Google Fonts GitHub raw (OFL). Music → Incompetech direct (CC-BY). SFX →
  synthesize (deterministic) or have the user download a Pixabay/Mixkit pack. Gated HF models
  (AI4Bharat) need an HF token; large HF downloads WEDGE at ~768 MB → `HF_HUB_ENABLE_HF_TRANSFER=1`.

## 9. UPLOAD-READY METADATA — author a `publish:` block in story.yaml

Make each reel publish-ready from the story itself: a top-level **`publish:`** block compiles into
`project.json` (the manifest) as pure metadata — it NEVER touches scene.json/frames, so it can't affect
determinism. Fields (all optional, all default; `title` falls back to the story `title`):
`title` (≤100) · `description` (full box text — hook + "Follow for…" + Sources + Credits + Disclaimer) ·
`tags[]` · `hashtags[]` · `category` ("News & Politics") · `language`/`caption_language` ("hi-IN") ·
`privacy` (private|unlisted|public) · `made_for_kids` · `playlist` · `license` · `thumbnail` · `credits`.
So a finished reel ships with title/description/tags/language ready to paste into the YouTube upload
form — no re-deriving. **Always fill the description with SOURCES + CREDITS (Pexels + music + map) + a
DISCLAIMER** attributing any contested claim (e.g. a territorial dispute) as a stated position, not fact.
(The `publish` block is validated by `PublishSchema` in `src/ir/story.ts`; it's carried to the manifest by
`render.ts` on compile.)

**AUTO-PUBLISH → `factory:publish <project>`** (extensible platform layer, `src/publish/`; YouTube today,
Instagram/TikTok = future adapters). Reads the manifest's `publish` block + `out.mp4`. **DRY-RUN by
default** (no upload) — pass `--yes` to upload; visibility defaults to **unlisted** (public is explicit).
YouTube needs a one-time OAuth setup + `--auth` (see `docs/factory/PUBLISHING.md`). ⚠️ Google force-locks
API uploads to private/unlisted until the OAuth app is verified — so the practical flow is upload-unlisted
→ glance in Studio → click Publish. Quota ≈ 6 uploads/day free.

## 10. DOCUMENTARIES → see the `producing-documentaries` skill

A ~5-min short documentary is the SAME pipeline scaled to multi-ACT + journalism evidence sources (factory:photo/newsshot/newsclip + Ken Burns + ubiquity montage + stage-aware audio). ALL reel principles here carry over. Use the dedicated **`producing-documentaries`** skill for the doc-specific process.

## The channel is production-DONE; the leap not yet built

Voice, fonts, cinematic visuals, official-India map, the geopolitics map toolkit, music, SFX, and a
proven narrative structure are all reusable infrastructure — a new reel is a new `story.yaml`. The
un-built next milestone is **auto-scripting**: a verified news item → this `story.yaml` automatically
(via `claude -p`). That's the "channel produces them daily" leap and deserves its own brainstorming →
spec → build cycle. The narrative STAGES + beat-duration-fits-narration rules above are its spine.
