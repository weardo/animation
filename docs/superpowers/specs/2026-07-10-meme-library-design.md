# Meme Library + Meme-Edit — Design

**Date:** 2026-07-10
**Status:** approved (design) — building the initial catalog

## Goal

A reusable **meme library** the reel pipeline can pull from to do "meme-edit" humour — reaction GIFs, sound
stings, video-clip reactions, Bollywood dialogue drops, format memes (zoom+sting, then-vs-now) — dropped at
the right beat and refined over videos. Start with **100-200 curated units**, geopolitical + universal +
Bollywood/desi (NO domestic-partisan).

## Architecture (mirrors clip:/newsshot:/wiki:)

- **The library is a CATALOG** (`library/memes/*.json`): each UNIT = metadata (name, humour type(s), format,
  when-to-use, vibe, tags) + a **fetch-ref** (how to get the media). The unit is the reusable, versioned thing.
- **Media is fetched with attribution** — free APIs (Giphy/Tenor GIFs, Myinstants/Freesound sounds), yt-dlp
  for public clips (fair-use commentary, like `clip:`), or FLUX-generated originals. The **free/legal units
  are also pre-downloaded** into `library/memes/media/` (content-addressed, skip-if-exists) so a build replays
  a FIXED file → deterministic (golden rule 1). Copyright-heavy units stay fetch-on-demand + attributed.
- **Pipeline use:** the architect/humour engine can place `meme:<unit-id>` on a beat; the scout resolves it to
  the media (a GIF/sound/clip overlay or a reaction cut), with graceful fallback. (Integration is a later phase.)

## Unit schema

```
{ id, name,
  humour: [<type>...],        // satire | irony | roast | butt-of-joke | repetition | deadpan | hyperbole |
                              // pun | observational | anticlimax | incongruity | reaction | parody
  format,                     // reaction-gif | sound | clip | image-macro | zoom-sting | then-vs-now |
                              // freeze-frame | expectation-vs-reality | overlay | callback
  use,                        // WHEN to drop it (the comedic trigger)
  vibe,                       // the emotion it conveys
  tags: [...],                // universal | geopolitical | bollywood | desi | pakistan | china | cricket | ...
  source: { kind, ref },      // kind: giphy | tenor | myinstants | freesound | ytclip | generate ; ref = query/prompt
  license }                   // attribution / license note
```

## Legal stance (honest)

Memes rely on recognised, often COPYRIGHTED source material. We minimise exposure: prefer free-API + generated
+ short fair-use commentary clips (attributed on-screen + in the description); NEVER scrape Know Your Meme
(copyrighted DB, ToS). A domestic-partisan carve-out is excluded by choice. Each unit records its license.

## Phases

1. **Catalog (now):** the schema + a curated 100-200-unit catalog across the humour types / formats / veins.
2. **Fetch machinery:** `meme:<id>` resolution — Giphy/Tenor/Myinstants/Freesound/yt-dlp/FLUX adapters +
   content-addressed media cache + attribution (mirrors newsclip/newsshot).
3. **Pipeline integration:** architect/humour place `meme:<id>` at the right beat; scout resolves; refine.

## Non-goals

Domestic-partisan mockery. Hoarding copyrighted files. A meme on a tragedy/victim beat (the tone gate still applies).
