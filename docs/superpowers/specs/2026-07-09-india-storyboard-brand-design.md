# India Storyboard — brand identity system

**Status:** design approved 2026-07-09 · Phase 1 spec
**Goal:** make every reel **instantly recognizable as "India Storyboard"** in the first frame, applied
AUTOMATICALLY by the factory (no per-video work), without hurting the 3-second-hook retention rule. The
brand rides on the channel's existing consistency (cinematic-dark, Mukta type, official-India map, Sarvam
Hinglish voice) and locks it to a fixed identity.

## 1. Brand foundation (fixed identity)

- **Name:** India Storyboard · **tagline:** "Geopolitics & India's Story"
- **Logo:** the existing badge (`~/Documents/India-storyboard-logo-transparent.png`) + a small watermark
  variant for the corner bug — vendored into `library/brand/`.
- **Palette** (sampled from the logo):
  - Saffron `#FA7A1E` (primary accent) · Navy `#16224E` (deep base) · India-green `#159A3C` ·
    Gold `#E6B24A` (premium lines) · Off-white `#F5F7FA` (text) · near-black `#0A0D14` (bg).
- **Type:** Mukta ExtraBold (headlines/handles) — already the Hinglish house font.
- **Signature motif:** the **film-strip / storyboard frame** (the "Storyboard" idea) + a tricolor/gold accent.

## 2. Recognizability mechanisms (hook-first, retention-safe — no front intro)

1. **Corner bug (primary lever).** The logo, small (~13% of frame width), **top-left**, ~85% opacity, on
   EVERY frame. Present from frame 1, never covering the top-center headline or bottom caption.
2. **Branded headline.** Mukta ExtraBold with a signature **gold accent underline** (a short bar under the
   headline) + the tricolor as the accent-color rotation. Consistent position/treatment across reels.
3. **Branded caption pill.** The lifted/transparent captions, tinted to brand: a navy-tinted pill with a
   thin gold top-edge, white text (unchanged legibility).
4. **Branded end-card (last ~1.5s).** The full logo + "India Storyboard" wordmark + `@handle` + tagline
   over the dimmed final footage, that STILL loops back to the hook (a branded sign-off, not a hard CTA
   that tanks completion). A subtle film-perforation strip frames it.

## 3. Architecture — DATA-driven, automatic (fits ADR-008 stylekits)

The brand is a **library stylekit** + a small generic render mechanism, so a story just sets
`style: india-storyboard` and every reel is on-brand with zero per-video work.

### 3.1 `library/stylekits/india-storyboard.json` (DATA)
Extends the existing StyleKit with the brand palette + a new optional **`brand`** sub-table:
```jsonc
{
  "palette": { "accent": "#FA7A1E", "accent2": "#159A3C", "ink": "#16224E", "gold": "#E6B24A",
               "text": "#F5F7FA", "bg": "#0A0D14" },
  "floor": { "shading": false, ... },           // stays plain/flat like the news reels
  "brand": {
    "name": "India Storyboard",
    "handle": "@IndiaStoryboard",               // operator-editable
    "bug":     { "asset": "brand/india-storyboard-bug.png", "corner": "top-left", "widthPct": 13, "opacity": 0.85, "marginPct": 4 },
    "accent":  { "headlineUnderline": "#E6B24A", "captionPill": "#16224E", "captionEdge": "#E6B24A" },
    "endcard": { "enabled": true, "seconds": 1.5, "logo": "brand/india-storyboard-logo.png" }
  }
}
```
Core owns only the `brand` schema (in `StyleKitSchema`); all VALUES live in the JSON (golden rule 7). The
resolved kit already travels in Scene IR `defs.stylekit`, so render reads it there.

### 3.2 Brand-overlay render mechanism (CODE, generic)
A small film-level component (`src/render/BrandOverlay.tsx`), composed in `Composition.tsx` ABOVE the
frame like the post grade: if `defs.stylekit.brand.bug` is present, it renders the bug `<Img>` at the
configured corner/size/opacity on every frame. Pure function of the resolved kit — no domain names, no
per-story wiring. Absent `brand` → strict no-op (byte-identical to today).

### 3.3 Branded framing (CODE, reads the kit)
- `CaptionTrack.tsx` reads `brand.accent.captionPill/captionEdge` when present (else the current default).
- The headline underline is a lowering convention: when a text layer is a headline (`as:"t"`, `at:"top"`)
  and the kit has `brand.accent.headlineUnderline`, lower adds a thin accent bar under it. (Phase 1 may
  instead bake the underline into the brand overlay to avoid touching the generic text path — decided at
  implementation; the simplest that looks right wins.)

### 3.4 End-card (CONVENTION, reuses existing machinery)
A branded end-card is a short final segment appended by a helper: either (a) a reusable `clip` def the
lowering appends, or (b) a `post`-like end overlay for the last N frames. Phase 1 uses the **overlay**
approach (last `endcard.seconds` of the timeline get the logo + wordmark + handle over the dimmed frame),
so it needs no new beat and always loops cleanly. Values from `brand.endcard`.

### 3.5 Make it the default
`producing-news-reels` + the `productionize` pass set `style: "india-storyboard"` by default for news
reels, so both hand-authored and dashboard-generated reels are branded automatically.

## 4. Determinism / safety
- Bug + end-card are pure functions of the resolved kit + frame → deterministic, byte-stable.
- `brand` absent → every mechanism is a strict no-op (existing reels unchanged).
- Vendored logo assets are content-addressed like any `asset://` → self-contained bundles.

## 5. Scope

- **Phase 1 (this spec):** vendor logo/bug → `india-storyboard` stylekit (palette + `brand`) → bug overlay
  → branded caption pill + headline underline → end-card overlay → make it the reel default. Verified on a
  real reel (bug legible + placed, end-card loops, captions on-brand, no regression when `brand` absent).
- **Phase 2 (noted):** sonic sting, animated bug reveal, a thumbnail template, a long-form 2s intro sting.

## 6. Open items (operator)
- Confirm the YouTube **@handle** for the end-card (default `@IndiaStoryboard`).
- Bug corner: **top-left** default (clears the top-center headline + bottom caption); switch to bottom-right
  via the kit if preferred.
