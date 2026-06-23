#!/usr/bin/env python
"""kokoro_synth.py — productionized Kokoro TTS synth CLI for the animation factory.

Run inside the isolated .venv-kokoro:
    .venv-kokoro/bin/python scripts/tts/kokoro_synth.py --text "..." --out /abs/path.wav [--voice af_heart]

Writes ONE mono wav to --out. Exits nonzero on any failure (the Node caller then falls
back to espeak-ng — see src/cli/narrate.ts). Logic lifted from tts-proto/gen_kokoro.py.

FIX baked in: en_core_web_sm is pre-installed in this venv so misaki's G2P does NOT try to
auto-download (which hard-exits in a uv venv). CPU-only, HF_HOME pinned, seeded for stability.
"""
import argparse
import os
import sys

# Pin the shared model cache + CPU determinism BEFORE importing the heavy stack.
os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")


def main() -> int:
    ap = argparse.ArgumentParser(description="Kokoro TTS → mono wav")
    ap.add_argument("--text", required=True, help="text to speak")
    ap.add_argument("--out", required=True, help="absolute output wav path")
    ap.add_argument("--voice", default="af_heart", help="Kokoro voice id (e.g. af_heart, am_michael)")
    ap.add_argument("--lang", default="a", help="KPipeline lang_code (default 'a' = American English)")
    ap.add_argument("--speed", type=float, default=1.0, help="speaking speed multiplier")
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    import torch
    from kokoro import KPipeline

    torch.manual_seed(0)

    pipe = KPipeline(lang_code=args.lang)
    chunks = []
    for _, _, audio in pipe(args.text, voice=args.voice, speed=args.speed):
        chunks.append(audio)
    if not chunks:
        print("kokoro: no audio produced", file=sys.stderr)
        return 1
    audio = np.concatenate(chunks)

    # Kokoro outputs 24 kHz mono float; ensure 1-D mono on write.
    audio = np.asarray(audio).squeeze()
    if audio.ndim > 1:
        audio = audio.mean(axis=tuple(range(1, audio.ndim)))
    sf.write(args.out, audio, 24000)
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"kokoro: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure → nonzero so Node falls back.
        print(f"kokoro_synth failed: {exc}", file=sys.stderr)
        sys.exit(1)
