# Humour Engine — Design

**Date:** 2026-07-10
**Status:** proposed (design) — awaiting review

## Goal

Add **sparse, well-calibrated humour** to news reels for an Indian audience — **without the AI writing jokes
from scratch** (it's bad at that). Humour is *arranged* from a curated kit and *filtered* by an automated
judge, so it works despite the LLM's weakness at wit, timing, and cultural grounding.

## Research basis (2026)

- LLMs are formulaic, weak at punchlines/timing/cultural grounding; personas barely help.
  ([ACM C&C 2025](https://dl.acm.org/doi/10.1145/3698061.3734388), [arXiv 2502.07981](https://arxiv.org/pdf/2502.07981))
- Comedians use LLMs for **setups**, reserve **punchlines** for human intuition → AI does setup, a **kit**
  supplies the punchline pattern. ([arXiv 2502.07981](https://arxiv.org/pdf/2502.07981))
- **HumorPlanSearch** (SOTA): a Humor-Chain-of-Thought (plan the incongruity) + retrieval of proven
  strategies + an **iterative judge-driven revision loop**. ([arXiv 2508.11429](https://arxiv.org/pdf/2508.11429))
- Scaffolding the process ("LLMs *with* humor skills") reaches human-caption parity; raw prompting doesn't.

## User decisions

- **Surfaces:** all three — wry narration asides (`say` + English subtitle), ironic on-screen headline/visual,
  and the hook + close.
- **Not always Indian:** humour may be *inherent/universal* absurdity (e.g. a Trump "Islamic Republic of
  Japan" gaffe) — the kit holds Indian AND universal devices; pick by fit, never force a desi angle.
- **Fully automatic:** no human approval step → the **judge loop is the taste filter** (the safety net).

## Design

All offline, content-addressed cached, deterministic (the research/narrate pattern). A new `agents/humour.ts`
pass runs AFTER research + the story architect, BEFORE narration timing.

### 1. Comedy kit — curated DATA (`library/comedy/*.json`, versioned like a stylekit)
- **devices**: deadpan understatement, incongruity/hypocrisy reveal, rule-of-three, callback, absurd analogy,
  anticlimax — each with a short "how it works" + 1-2 in-Hinglish exemplars (the punchline *pattern*, not a
  fixed joke).
- **references**: Indian (cricket/Bollywood/WhatsApp-group/society-aunty/jugaad) AND universal (gaffes,
  bureaucratic absurdity, self-own, irony). Tagged so the fitter can pick by relevance.
- **tone rules + a `neverJokeAbout` list** (deaths, victims, tragedy, communal/religious sensitivity, minors).

### 2. Tone gate (FIRST, hard exclude)
Per beat, classify intent/sensitivity. A `grim` beat (death toll, victims, atrocity) is **excluded before any
generation**. Only `neutral`/`absurd`/`ironic`/`setup` beats are eligible. Non-negotiable.

### 3. Humor-CoT + fit (setup by AI, punchline from the kit)
For each *eligible* beat: `claude -p` reasons — what's the incongruity/absurdity/hypocrisy here? → selects a
device+reference from the kit that fits → drafts 2-3 candidate touches (a wry aside, an ironic headline, or a
close line). AI supplies the SETUP and FIT; the kit supplies the comedic FORM.

### 4. Judge-and-select loop (the automated taste filter)
A separate `claude -p` judge scores each candidate on: funny? on-tone? not cringe/try-hard? punches UP (at
power/absurdity) not DOWN (at victims)? fits the beat? It **picks the best OR rejects all** (skip humour on
that beat). Optional one revision pass on a near-miss (HumorPlanSearch's loop). Rejection is the default bias.

### 5. Restraint + placement
- Hard cap **1-2 touches per reel** (favor the hook, one ironic mid-setup, the close).
- Applied by editing the chosen beat's `say` (→ flows into the English subtitle) and/or its `text` headline.
- Everything stays fact-true — humour rides the framing, never fabricates.

## Determinism / safety

- Generation + judging cached content-addressed (run-once, replay → deterministic).
- Missing `claude` → no humour added (graceful; the reel is just straight). Build never fails.
- The tone gate + judge + `neverJokeAbout` list are layered so a bad/insensitive line has to pass THREE
  filters — the compensating control for having no human approval.

## Non-goals

- AI writing free-form standup. Constant humour. Any humour on victims/tragedy. Forced Indian references.

## Open questions for review

1. Kit authoring: seed the first comedy kit myself (curated exemplars) — OK?
2. Judge strictness default: bias toward **rejecting** (fewer, safer touches) vs including more — I recommend
   reject-biased for a news brand in auto mode.
3. A global `--no-humour` / per-story `humour: off` switch (default on for reels) — assumed yes.
