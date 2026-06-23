#!/usr/bin/env python
"""chatterbox_synth.py — productionized Chatterbox TTS synth CLI for the animation factory.

Run inside the isolated .venv-chatterbox:
    .venv-chatterbox/bin/python scripts/tts/chatterbox_synth.py --text "..." --out /abs/path.wav \
        [--exaggeration 0.5] [--cfg 0.5]

Writes ONE mono wav to --out. Exits nonzero on any failure (the Node caller then falls
back to espeak-ng — see src/cli/narrate.ts). Logic lifted from tts-proto/gen_chatterbox.py.

FIX baked in: the Resemble 'perth' watermarker resolves to a broken/None class in this venv;
watermarking is irrelevant here, so it is shimmed to a no-op so model construction succeeds.
CPU-only, HF_HOME pinned, seeded for stability.
"""
import argparse
import os
import sys

os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")


def main() -> int:
    ap = argparse.ArgumentParser(description="Chatterbox TTS → mono wav")
    ap.add_argument("--text", required=True, help="text to speak")
    ap.add_argument("--out", required=True, help="absolute output wav path")
    ap.add_argument("--exaggeration", type=float, default=0.5, help="expressiveness (0..1)")
    ap.add_argument("--cfg", type=float, default=0.5, help="cfg_weight guidance")
    args = ap.parse_args()

    import torch
    import torchaudio as ta

    # The 'perth' watermarker resolves to None in this venv → shim to a no-op BEFORE importing
    # ChatterboxTTS so model construction succeeds.
    import perth
    if getattr(perth, "PerthImplicitWatermarker", None) is None:
        class _NoWatermark:
            def apply_watermark(self, wav, sample_rate=None, **kw):
                return wav

        perth.PerthImplicitWatermarker = _NoWatermark

    from chatterbox.tts import ChatterboxTTS

    torch.manual_seed(0)
    model = ChatterboxTTS.from_pretrained(device="cpu")
    sr = model.sr

    torch.manual_seed(0)
    wav = model.generate(args.text, exaggeration=args.exaggeration, cfg_weight=args.cfg)

    # model.generate returns a (channels, samples) tensor; collapse to mono for the wav.
    if hasattr(wav, "dim") and wav.dim() > 1 and wav.shape[0] > 1:
        wav = wav.mean(dim=0, keepdim=True)
    ta.save(args.out, wav, sr)
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"chatterbox: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure → nonzero so Node falls back.
        print(f"chatterbox_synth failed: {exc}", file=sys.stderr)
        sys.exit(1)
