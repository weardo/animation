---
name: producing-documentaries
description: Use when producing a ~5-minute Indian-language (Hinglish) SHORT DOCUMENTARY on ANY subject (history, economy, science, a person, a place, an event, a technology, geopolitics…) in the animation factory — a longer-form, multi-ACT piece (vs a 40-60s reel) built from journalism EVIDENCE: real news-article screenshots (ubiquity montage), real news video clips, Wikimedia archival stills with Ken Burns motion, cinematic maps, footage, stage-aware music/SFX, and आप-respectful direct-address narration. Read it BEFORE building a documentary. It BUILDS ON producing-news-reels (all reel principles carry over) and adds the documentary-specific process: act structure, the evidence content-source CLIs (factory:photo/newsshot/newsclip), Ken Burns, the news-montage pattern, stage-aware audio, and the 5-min render reality.
---

# Producing a short documentary (5-min Hinglish, ANY subject)

**⚠️ TOPIC-NEUTRAL SKILL.** This is a GENERAL documentary-production process — it works for ANY subject
(history, science, economy, a biography, an event, a place, a technology, geopolitics). Concrete examples
below (a border, a stat, "at 18,000 feet") are ILLUSTRATIONS drawn from one build, NOT the domain — swap
in whatever YOUR subject needs. The only fixed elements are the CHANNEL (Hinglish, आप-respectful, the
official-India map WHEN a map shows India) and the craft rules, never the topic.

**⭐ NORTH STAR — MAXIMUM VALUE DENSITY WITHOUT LOSING COMPREHENSION (user's core goal).** Every second must
deliver something worth knowing; nothing is padding. This is NOT "make it longer" — it's "pack more VALUE
per second while staying clear." Consequences that drive every other rule: tight narration (cut filler
words, one idea per breath), FAST visual tempo (no still static > ~1.5s, accelerating montages, quick
cuts), a new fact/insight/turn on nearly every beat, and pacing that's brisk but never confusing (let a
genuinely hard idea breathe for one beat, then move). A DENSE 2.5-min doc beats a padded 4.5-min one; a
GREAT 4.5-min doc is 4.5 min of packed value, not stretched. When in doubt: cut a word, speed a cut, add a
fact.

A documentary is the **SAME factory pipeline as a reel, scaled up**: one `projects/<id>/story.yaml` with
**~30-60 beats grouped into ACTS**, compiled → rendered → published exactly as a reel. **Everything in
`producing-news-reels` applies unchanged** — read it first. This skill adds only what's DIFFERENT for
long-form: act structure, journalism-evidence sourcing, Ken Burns, the ubiquity montage, and stage-aware
audio. Design spec: `docs/superpowers/specs/2026-07-08-documentary-v1-design.md`.

## Carries over from `producing-news-reels` (do NOT re-derive)

Voice (Sarvam shubh/48k/0.9, चाइना-style phonetic TTS fixes) · Mukta font · **`world-in` OFFICIAL India
map** (legally required) + the map toolkit (routes/markers/fly-to) · cinematic-dark look + **tailored
per-clip effects** (bright clips stay bright; localized text scrim, not a full dark crush) · **narration
craft**: ONE-story monologue split into beats + **आप-respectful DIRECT ADDRESS** + rhetorical questions +
an **opinion/comment prompt** + beat-duration-fits-narration · footage **browse+contact-sheet verify** ·
the `publish:` block + `factory:publish` · render.log monitoring + RAM-safe concurrency.

## The operating principle — journalism fair use WITH attribution

A documentary uses **publicly-available media as EVIDENCE** inside brief, attributed, transformative
commentary. Attribution does double duty: **licensing cover + authenticity** (a sourced screenshot IS the
credibility). Guardrails: publicly-accessible only (no paywall/DRM bypass), keep clips/shots BRIEF,
source-attribute on-screen AND in the description, and it must be commentary — not a re-upload. Every
evidence CLI records provenance/attribution automatically.

## 1. STRUCTURE — three acts, ~30-60 beats

Author as comment-grouped acts (a documentary is a JOURNEY, not a 5-beat reel):
- **ACT I — HOOK + THE WORLD** (~45-75s): the make-or-break cold-open (first-frame text hook + a
  pre-commitment question), then establish the stakes/place (e.g. "at 18,000 feet…" — whatever grounds YOUR subject).
- **ACT II — THE CONFLICT / ESCALATION** (~90-140s): the problem, the antagonist, rising tension. The
  ubiquity montage lives here ("everyone is reporting this"). Multiple sub-beats, maps, evidence.
- **ACT III — THE ANSWER + PAYOFF** (~90-140s): the turn/insight (the tech, the move), the resolution,
  the opinion prompt, and a LOOP close returning to the hook visual+text.
Each beat still obeys the reel rules: one visual per beat, connective narration, tailored effects.
**Write the WHOLE ~700-900-word script as one spoken monologue FIRST, then cut it at visual changes.**

## 2. EVIDENCE — the new content sources (all cache-once-offline, attributed)

- **`factory:photo "<q>" --source wikimedia|pexels [--list N] [--index n] [--orientation portrait]`** —
  stills. **Wikimedia** = REAL subjects (a person, a place, an object, an event, an institution — whatever the VO names) with
  CC/PD + author attribution; **Pexels** = generic mood b-roll. BROWSE (`--list`) + pick a specific one;
  the page title is the content signal. Use with **Ken Burns**: `{ asset: <id>, as: still, args: { z: 1,
  kenburns: "in" } }`.
- **`factory:newsshot "<url>" --id <id> [--selector "<css>"] [--width 1200] [--height 1600]`** — a public
  news-article screenshot (Remotion's Chromium via puppeteer-core). Powers the **UBIQUITY MONTAGE**.
  `--selector` crops to the headline/article node (drop site chrome). VERIFY the shot (extract a frame +
  look) — a 404/consent page is useless. Use REAL, current article URLs (find them via WebSearch).
- **`factory:newsclip "<url>" --id <id> --section <start>-<end>`** — a BRIEF public news video clip via
  yt-dlp → light footage proxy (event evidence). Keep `--section` short. → `{ footage: <id>, as: broll }`.
- **Ken Burns** (`kenburns: "in"|"out"|"in-slow"|"out-slow"` or `{from,to}` scale %) — a slow zoom on a
  still so it isn't dead. THE way to make archival photos + screenshots feel alive. Default "in" = 100→112.

## 3. THE UBIQUITY MONTAGE (the documentary's signature evidence device)

To signify "the whole world is reporting this" / consensus: **5-8 RAPID beats of ~0.6-1.0 s each**, each a
`newsshot` (or a headline card) with a **hard cut** (no transition) + a whip/click SFX per cut, often with
a subtle `kenburns` push. Front-load it in Act II to establish the stakes are real + widely-covered. Keep
each shot on-screen just long enough to register a logo + headline. Attribute the publishers in the
description.

## 4. STAGE-AWARE AUDIO — score/SFX/transitions follow the PLOT (not one flat loop)

A 5-min doc must not ride one loop. Use the EXISTING capability, staged:
- **Per-act music** via the story-level layered **`audio[]` tracks** (each `{src, at, duration, volume,
  fade_in, fade_out, loop}`): a DIFFERENT bed per act, **crossfaded** at act boundaries (outgoing
  `fade_out` overlapping incoming `fade_in`). Arc: Act I sparse/ambient → Act II rising tension → the turn
  a swell/impact → Act III climax → a calmer resolution outro. All auto-duck under VO. Source a few
  royalty-free beds (Incompetech CC-BY is curl-able; credit in the description) into `assets/audio/`; the
  built-in synth beds are too thin for long-form.
- **SFX mapped to STORY FUNCTIONS**: `riser` INTO a reveal/act-turn; `boom`/impact ON the central turn or
  a key stat; a low drone under a tension passage; `ding`/`pop` on a marker/fact pop; whip/click per
  montage cut. "Every STORY BEAT has an audio gesture."
- **Transitions matched to plot**: HARD CUTS inside a montage; short cross-dissolves within an act; a
  longer **fade + whoosh/impact at ACT boundaries** (the chapter break). Reserve the biggest transition
  for the turn.
- **Mix**: music ducks ~0.3 under VO; SFX accent without masking narration; verify audible (mean ≫ −60 dB)
  and VO never buried.

## 5. WORKFLOW (the order that works)

1. **Research + ground the facts** (WebSearch) — a documentary must be accurate; collect REAL article URLs
   for the montage + the verifiable facts. Attribute contested claims as stated positions.
2. **Write the full script** as one आप-respectful direct-address monologue (~700-900 words), 3 acts.
3. **Source evidence** to match: footage (browse+verify), Wikimedia stills, news screenshots (verify each),
   1-2 news clips, music beds. Everything cached + attributed.
4. **Author beats** (~30-60) in acts, with the montage, KB stills, maps, footage, tailored effects, SFX,
   per-act `audio[]`, transitions.
5. **Synth once → read cue durations → fit each beat** (= say + ~0.9s); verify 0 overlaps in scene.json.
6. **VERIFY LOOK ON `--frames` STILLS** across the acts BEFORE the slow full render.
7. **Full render** — a 5-min doc ≈ 9,000 frames ≈ **25-35 min** (monitor via render.log). Verify the
   artifact (duration, audio audible, montage reads, attributions present).
8. **Review with the user, then publish** (evidence-based, outward-facing → confirm before public).

## 5b. CRAFT REFINEMENTS (from the first doc's review, 2026-07-08 — bake these in)

**⭐ SHOW WHAT YOU'RE SAYING — VISUAL/NARRATION SYNC IS THE IMPACT (user's core rule).** At every beat, the
image on screen must MATCH the exact thing the VO is naming RIGHT NOW — the entity, the place, the event,
the emotion. Name a specific thing → show THAT thing; cite a place → show that place; say "at its lowest / a collapse"
→ show the decline/aftermath, NOT a celebratory image; say "hundreds of X" → show MANY, not one. A mismatch (a smiling ceremony under a
somber line) breaks the spell; a match lands the point. TEST each beat: "does the picture prove the words?"
If not, re-source the visual or re-cut the line. This is WHY per-entity sourcing + exact event imagery
matter. When the exact visual doesn't exist, use a LABELED stand-in (text names the specific system over
illustrative footage) — honest, and still roughly synced — never a visual that CONTRADICTS the words.
**CONTEXT-SPECIFICITY (deeper than "show the category").** Match the SUBJECT'S context, not just the noun:
narrating about country/org A's tech → show A's, NOT another nation's clearly-LABELLED hardware (a clip
captioned with someone else's equipment CONTRADICTS the VO). Distinguish LOOK-ALIKES: an entertainment
drone LIGHT-SHOW ≠ a military drone swarm; a parade ≠ a battle. When stock/Wikimedia lack the exact subject,
**`factory:newsclip` a fair-use clip from public YouTube** (`yt-dlp "ytsearch10:<exact subject>"` → pick a
candidate → pull a brief `--section` → verify on a contact sheet). A clip carrying the subject's OWN on-
screen label (e.g. "…from the Indian Army") strengthens both fair-use and authenticity.

The first doc "held attention"; these notes make the next one sharper:
- **OPENERS — warm + natural, not formulaic.** "एक second रुकिए…" read as CRINGE. The Guyana "दोस्तों…" opener
  felt natural. Open like a person talking to friends: "दोस्तों…", "ज़रा एक बात सोचिए…", a bold stat, or a
  direct image — NOT a canned "रुकिए/wait" gimmick. Still आप-respectful, still a curiosity hook.
- **RISER SFX DISCIPLINE — a riser marks a REAL buildup, not every beat.** Overusing `riser` deadens it.
  Reserve it for genuine escalations (into the turn, a reveal, an act climax); most beats just need a soft
  `whoosh` on the cut. One well-placed riser > five reflexive ones.
- **MUSIC — more variety + dynamics that follow the PHASE.** One bed per act isn't enough; the score should
  BUILD and RELEASE with the story (tension rising into the turn, a release/resolve after). Source a wider
  bed library (Incompetech CC-BY: e.g. "Ghost Story", "Long Note Two", "Echoes of Time", "Anguish", "The
  Descent", "Impact Prelude", "Heavy Interlude") and pick beds whose OWN arc matches the beat; layer a low
  drone under tension, swell at the turn, drop to sparse at the reveal.
- **NEWS MONTAGE — hard cuts, accelerating, with a per-cut SFX (NOT a fade).** The fade-in did not suit the
  montage. Rules: (1) HARD CUTS only (no `transition` between montage beats). (2) A punchy SFX PER CUT — a
  camera **shutter**/click or a short glitch/whoosh, not silence. (3) **ACCELERATE EXPONENTIALLY** — the
  classic montage speeds up: e.g. 1.2s → 0.9s → 0.7s → 0.5s → 0.35s → 0.25s, each shot faster than the last,
  SFX tightening with it, resolving into the next beat. (4) DON'T hold the first shot long — get moving.
- **STILLS — never static > ~1.5s.** A motionless image reads as "delayed/dead". Every still needs motion:
  a stronger Ken Burns (bigger scale delta or a pan), OR a faster beat, OR quicker cuts between stills. If a
  still must sit, push the KB harder.
- **ONE PROPER, CLEAR, CENTERED VISUAL PER NAMED ENTITY/EVENT.** When the VO names 2-3 things (drones,
  systems, people, places), show a SPECIFIC, sharp, centered image/clip for EACH — not one blurry generic
  stand-in (the low-res off-center drone was weak). Source per-entity: `factory:photo "<the exact named subject>"`
  for EACH; verify it IS the actual subject, high-res, well-framed. For EVENTS, get the EXACT imagery of
  THAT event, not a generic stand-in. If the VO says "many/hundreds", the visual must show MANY. Reject low-res (<800px) for a full-frame KB shot.
- **TEXT-EFFECT VARIETY (all BUILT — use them).** Text `anim.preset` supports: `fade`, `rise`,
  `stagger` (per word/char), **`typewriter`** (`{ preset: typewriter, cps: 14 }` — types the string out),
  **`count_up`** (`{ preset: count_up, from: 12, to: 140, duration: 40 }` — animates a stat number). Use
  typewriter for a headline/quote reveal, count_up for a "12 → 140" stat pop, rise/stagger for
  titles. Variety keeps on-screen text alive across 30+ beats. Montage per-cut SFX (also BUILT): **`shutter`**
  (camera snap) or **`glitch`** (digital stutter) — one per montage cut, tightening as the montage accelerates.
- **VERTICAL-FIRST, but frame for it.** 9:16 is the target (a horizontal 16:9 cut is a future option). In
  vertical: center subjects, crop stills/footage to keep the subject in the 9:16 safe area, bigger type,
  the montage screenshots cropped to the headline (use `--selector`).

## 6. Scope (v1) — what's built vs deferred

BUILT: the evidence CLIs (photo/newsshot/newsclip), Ken Burns, the montage + act + stage-audio
conventions. DEFERRED to v2: kinetic typography (animated pull-quotes/lower-thirds/stat callouts) and
automated act-pacing/music-swell tooling — for now, place stat callouts as normal `text` beats + author
the audio staging by hand.
