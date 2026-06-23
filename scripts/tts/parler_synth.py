#!/usr/bin/env python
"""parler_synth.py — productionized Parler TTS synth CLI for the animation factory.

Run inside the isolated .venv-parler:
    .venv-parler/bin/python scripts/tts/parler_synth.py --text "..." --out /abs/path.wav \
        [--desc "calm, somber, slow, clear high-quality audio"]

Writes ONE mono wav to --out. Exits nonzero on any failure (the Node caller then falls
back to espeak-ng — see src/cli/narrate.ts). Logic lifted from tts-proto/gen_parler.py.

FIX baked in: weights are PRE-CACHED, so HF_HUB_OFFLINE/TRANSFORMERS_OFFLINE are forced ON
in-process — a lazy download otherwise STALLS forever. CPU-only, HF_HOME pinned, seeded.
"""
import argparse
import os
import sys

os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
# Weights are pre-cached; FORCE offline so a lazy download cannot stall the build forever.
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

DEFAULT_DESC = (
    "A speaker delivers in a calm, somber and reverent tone, at a measured pace, "
    "with very clear high-quality audio and no background noise."
)


def main() -> int:
    ap = argparse.ArgumentParser(description="Parler TTS → mono wav")
    ap.add_argument("--text", required=True, help="text to speak")
    ap.add_argument("--out", required=True, help="absolute output wav path")
    ap.add_argument("--desc", default=DEFAULT_DESC, help="tone description (Parler conditioning prompt)")
    ap.add_argument("--repo", default="parler-tts/parler-tts-mini-expresso", help="model repo id")
    args = ap.parse_args()

    import soundfile as sf
    import torch
    from parler_tts import ParlerTTSForConditionalGeneration
    from transformers import AutoTokenizer

    model = ParlerTTSForConditionalGeneration.from_pretrained(args.repo)
    tok = AutoTokenizer.from_pretrained(args.repo)
    sr = model.config.sampling_rate

    iid = tok(args.desc, return_tensors="pt").input_ids
    pid = tok(args.text, return_tensors="pt").input_ids
    torch.manual_seed(0)
    gen = model.generate(input_ids=iid, prompt_input_ids=pid)
    audio = gen.cpu().numpy().squeeze()

    if audio.ndim > 1:
        audio = audio.mean(axis=tuple(range(1, audio.ndim)))
    sf.write(args.out, audio, sr)
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"parler: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure → nonzero so Node falls back.
        print(f"parler_synth failed: {exc}", file=sys.stderr)
        sys.exit(1)
