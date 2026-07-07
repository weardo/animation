#!/usr/bin/env python
"""indic_parler_synth.py — AI4Bharat Indic Parler-TTS synth CLI for the animation factory.

The BROAD Indian-language engine: ai4bharat/indic-parler-tts speaks 21 languages (Assamese,
Bengali, Bodo, Dogri, Kannada, Malayalam, Marathi, Sanskrit, Nepali, English, Telugu, Hindi,
Gujarati, Konkani, Maithili, Manipuri, Odia, Santali, Sindhi, Tamil, Urdu). Voice + emotion are
steered by a natural-language DESCRIPTION (no reference audio needed) — that's why this is the
default "all Indian languages" engine.

Run inside the isolated .venv-parler (same package as parler_synth.py, different checkpoint):
    .venv-parler/bin/python scripts/tts/indic_parler_synth.py --text "नमस्ते दुनिया" --out /abs/path.wav \
        [--desc "Aditi speaks in a clear, expressive voice ..."] [--repo ai4bharat/indic-parler-tts]

Writes ONE mono wav to --out. Exits nonzero on any failure (the Node caller then falls back to
espeak-ng — see src/cli/narrate.ts). Golden rule 1: the deterministic record is the CACHED wav,
not this stochastic engine — so we seed torch and the render replays the fixed wav.

DIFFERENCE from parler_synth.py: the Indic model uses a SEPARATE description tokenizer (the text
encoder) from the prompt tokenizer, and passes attention masks (per the model card). We do NOT
force HF offline here so a FIRST authenticated run can download the gated weights once; after that
they are cached and load offline automatically. CPU-only, HF_HOME pinned, seeded.
"""
import argparse
import os
import sys

os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

# A clear default voice. The SPEAKER NAME picks the voice+accent; the language is inferred from the
# SCRIPT of --text. "Rohit" is a recommended HINDI speaker — must match the text language or Hindi gets
# another accent (e.g. "Aditi" is BENGALI). Hindi recommended speakers: Rohit, Divya.
DEFAULT_DESC = (
    "Aman speaks in a youthful, energetic and lively young man's voice, at a fast and continuous pace "
    "with almost no pauses, full of excitement and punchy emphasis like a young reel storyteller, in "
    "very clear high-quality audio with no background noise."
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Indic Parler-TTS -> mono wav (21 Indian languages)")
    ap.add_argument("--text", required=True, help="text to speak (any supported Indic script)")
    ap.add_argument("--out", required=True, help="absolute output wav path")
    ap.add_argument("--desc", default=DEFAULT_DESC, help="voice/tone description (conditioning prompt)")
    ap.add_argument("--repo", default="ai4bharat/indic-parler-tts", help="model repo id")
    args = ap.parse_args()

    import soundfile as sf
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer

    device = "cpu"
    model = ParlerTTSForConditionalGeneration.from_pretrained(args.repo).to(device)
    prompt_tok = AutoTokenizer.from_pretrained(args.repo)
    # The Indic model conditions the DESCRIPTION through its text-encoder tokenizer (distinct from
    # the prompt tokenizer) — using the wrong tokenizer garbles the voice control.
    desc_tok = AutoTokenizer.from_pretrained(model.config.text_encoder._name_or_path)

    desc = desc_tok(args.desc, return_tensors="pt").to(device)
    prompt = prompt_tok(args.text, return_tensors="pt").to(device)

    torch.manual_seed(0)
    gen = model.generate(
        input_ids=desc.input_ids,
        attention_mask=desc.attention_mask,
        prompt_input_ids=prompt.input_ids,
        prompt_attention_mask=prompt.attention_mask,
    )
    audio = gen.cpu().numpy().squeeze()
    if audio.ndim > 1:
        audio = audio.mean(axis=tuple(range(1, audio.ndim)))
    sf.write(args.out, audio, model.config.sampling_rate)

    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"indic_parler: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure -> nonzero so Node falls back to espeak-ng.
        print(f"indic_parler_synth failed: {exc}", file=sys.stderr)
        sys.exit(1)
