# IndicF5 reference voices

IndicF5 is a **voice-cloning** TTS: it speaks in the voice of a reference clip. The `indicf5` narrate
engine (`src/cli/narrate.ts` → `scripts/tts/indicf5_synth.py`) needs a reference wav + its transcript.

## `indicf5_default.wav` / `indicf5_default.txt`

The bundled default is `PAN_F_HAPPY_00001.wav` from the **AI4Bharat/IndicF5** model repo's own
`prompts/` example set (a Punjabi female "happy" reference) + its transcript. It's here only so the
engine has a working out-of-the-box voice.

**For production, supply your OWN narrator reference** — the default carries a "happy" emotion and a
Punjabi accent that tint every line. Pass a custom reference by setting the narrate `voice` to an
absolute `*.wav` path that has a `<same-path>.txt` transcript sidecar next to it (see `synthIndicF5`).
Per IndicF5's terms, only clone voices you have permission to use.

For the broad, no-reference-audio path (21 languages, voice steered by a text description instead of a
clip), use the **`indic-parler`** engine instead.
