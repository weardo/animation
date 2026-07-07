#!/usr/bin/env python
"""indicf5_synth.py — AI4Bharat IndicF5 near-human TTS CLI for the animation factory.

The QUALITY tier: ai4bharat/IndicF5 is a near-human polyglot F5-TTS model for 11 Indian languages
(Assamese, Bengali, Gujarati, Hindi, Kannada, Malayalam, Marathi, Odia, Punjabi, Tamil, Telugu). It
CLONES a reference voice — you pass a reference wav + its transcript, and it speaks --text in that
voice. That makes the "voice" a swappable reference audio (a project can supply its own narrator clip).

Run inside the isolated .venv-indicf5 (F5-TTS runtime stack):
    .venv-indicf5/bin/python scripts/tts/indicf5_synth.py --text "नमस्ते दुनिया" --out /abs/path.wav \
        --ref-audio scripts/tts/refs/indicf5_default.wav --ref-text "<transcript of the ref wav>"

Writes ONE mono wav (24 kHz) to --out. Exits nonzero on any failure (the Node caller then falls back
to espeak-ng — see src/cli/narrate.ts). Golden rule 1: the deterministic record is the CACHED wav,
not this stochastic engine — the render replays the fixed wav.

CPU-only, HF_HOME pinned. TORCHDYNAMO_DISABLE=1 turns the model's hardcoded torch.compile into a
no-op (CPU torch.compile is slow/fragile and buys nothing here). The vocos vocoder is fetched to the
HF cache on first run, then reused offline.
"""
import argparse
import os
import sys

os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
# The remote model.py hardcodes torch.compile on the vocoder + DiT; on CPU that is slow/fragile and
# gains nothing. Disabling dynamo makes torch.compile a transparent passthrough.
os.environ.setdefault("TORCHDYNAMO_DISABLE", "1")

REPO = "ai4bharat/IndicF5"


def main() -> int:
    ap = argparse.ArgumentParser(description="IndicF5 near-human TTS -> mono 24kHz wav (11 Indic langs)")
    ap.add_argument("--text", required=True, help="text to speak (a supported Indic script)")
    ap.add_argument("--out", required=True, help="absolute output wav path")
    ap.add_argument("--ref-audio", required=True, help="reference voice wav to clone")
    ap.add_argument("--ref-text", required=True, help="transcript of the reference wav")
    ap.add_argument("--repo", default=REPO, help="model repo id")
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    from huggingface_hub import hf_hub_download, snapshot_download
    from safetensors.torch import load_file

    if not os.path.exists(args.ref_audio):
        print(f"indicf5: ref audio not found: {args.ref_audio}", file=sys.stderr)
        return 1

    # The repo bundles an Indic-MODIFIED `f5_tts` package. Put the (already-cached) snapshot dir on the
    # path so the BUNDLED f5_tts is used (not upstream pip, which handles the Indic vocab differently).
    # snapshot_download is a no-op/instant when cached.
    snap = snapshot_download(args.repo)
    if snap not in sys.path:
        sys.path.insert(0, snap)

    # torchaudio 2.11 routes `torchaudio.load` through the torchcodec backend, whose native lib does not
    # load on this box (py3.14 ABI). The refs are plain PCM wavs, so shim `torchaudio.load` to soundfile
    # (returns a (channels, frames) float32 tensor + sample rate, matching torchaudio.load's contract).
    import torch
    import torchaudio

    def _soundfile_load(filepath, *a, **k):
        data, sr = sf.read(str(filepath), dtype="float32", always_2d=True)  # (frames, channels)
        return torch.from_numpy(data.T).contiguous(), sr

    torchaudio.load = _soundfile_load

    from f5_tts.model import CFM, DiT
    from f5_tts.infer.utils_infer import (
        load_vocoder, preprocess_ref_audio_text, infer_process, get_tokenizer,
        n_fft, hop_length, win_length, n_mel_channels, target_sample_rate, ode_method,
    )

    # The repo's model.py is BROKEN on CPU (from_pretrained hits transformers' meta-device init; direct
    # init calls load_model() without the required ckpt_path — and checkpoints/model_best.pt doesn't even
    # exist, the trained weights live only in the root model.safetensors under an `ema_model._orig_mod.`
    # prefix). So we build the F5-TTS CFM(DiT) EXACTLY as load_model does, then load those weights
    # directly — using the real trained model, not the buggy wrapper.
    device = "cpu"
    vocab_path = hf_hub_download(args.repo, "checkpoints/vocab.txt")
    weights_path = hf_hub_download(args.repo, "model.safetensors")

    vocab_char_map, vocab_size = get_tokenizer(vocab_path, "custom")
    model_cfg = dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4)
    ema_model = CFM(
        transformer=DiT(**model_cfg, text_num_embeds=vocab_size, mel_dim=n_mel_channels),
        mel_spec_kwargs=dict(
            n_fft=n_fft, hop_length=hop_length, win_length=win_length,
            n_mel_channels=n_mel_channels, target_sample_rate=target_sample_rate,
            mel_spec_type="vocos",
        ),
        odeint_kwargs=dict(method=ode_method),
        vocab_char_map=vocab_char_map,
    ).to(device)

    state = load_file(weights_path, device=device)
    prefix = "ema_model._orig_mod."
    ema_sd = {k[len(prefix):]: v for k, v in state.items() if k.startswith(prefix)}
    if not ema_sd:
        print("indicf5: no ema_model weights found in model.safetensors", file=sys.stderr)
        return 1
    ema_model.load_state_dict(ema_sd, strict=False)
    ema_model = ema_model.eval().to(device)

    # vocos vocoder (standard charactr/vocos-mel-24khz; fetched once, then cached offline).
    vocoder = load_vocoder(vocoder_name="vocos", is_local=False, device=device)

    ref_audio, ref_text_proc = preprocess_ref_audio_text(args.ref_audio, args.ref_text)
    audio, sr, _ = infer_process(
        ref_audio, ref_text_proc, args.text, ema_model, vocoder,
        mel_spec_type="vocos", speed=1.0, device=device,
    )

    audio = np.asarray(audio, dtype=np.float32)
    if audio.ndim > 1:
        audio = audio.mean(axis=tuple(range(1, audio.ndim)))
    sf.write(args.out, audio, samplerate=sr)

    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"indicf5: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure -> nonzero so Node falls back to espeak-ng.
        print(f"indicf5_synth failed: {exc}", file=sys.stderr)
        sys.exit(1)
