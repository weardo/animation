#!/usr/bin/env python
"""orpheus_synth.py — Orpheus-3B Hindi TTS (emotion-capable) synth CLI for the animation factory.

Orpheus is an LLM-based TTS: a 3B Llama emits AUDIO CODE tokens which a SNAC neural codec decodes to
24 kHz speech. This uses the CPU-friendly quantised GGUF (lex-au/Orpheus-3b-Hindi-FT-Q8_0) via
llama-cpp-python + the SNAC decoder. The Hindi voice is "ऋतिका" (the model's one Hindi speaker); emotion
tags like <laugh>/<sigh> may be embedded in the text. More natural/younger-sounding than indic-parler.

Run inside .venv-orpheus:
    .venv-orpheus/bin/python scripts/tts/orpheus_synth.py --text "नमस्ते दुनिया" --out /abs/path.wav

Writes ONE mono 24 kHz wav. Exits nonzero on failure (Node caller falls back to espeak-ng). Golden rule
1: the deterministic record is the cached wav, not this (temperature-sampled) engine — the render replays
the fixed wav. CPU-only, HF_HOME pinned. Recipe mirrors Lex-au/Orpheus-FastAPI (prompt + token→SNAC).
"""
import argparse
import os
import re
import sys

os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")

GGUF_REPO = "lex-au/Orpheus-3b-Hindi-FT-Q8_0.gguf"
GGUF_FILE = "Orpheus-3b-Hindi-FT-Q8_0.gguf"
HINDI_VOICE = "ऋतिका"
CUSTOM_TOKEN_RE = re.compile(r"<custom_token_(\d+)>")


def convert_to_audio(ids, snac_model, device):
    """SNAC-decode a flat list of per-position code ids (mirrors Orpheus-FastAPI convert_to_audio).
    Every 7 ids form one frame → 1 code in codebook0, 2 in codebook1, 4 in codebook2 (hierarchical)."""
    import torch

    # SNAC codebooks have 4096 entries → valid code indices are 0..4095. Keep ONLY frames whose 7 codes
    # are all in range (a stray/negative code = a mis-parsed token; decoding it crashes the codec's
    # embedding lookup with "index out of range"). Dropping bad frames is what the reference does.
    frames = []
    for j in range(len(ids) // 7):
        f = ids[j * 7 : j * 7 + 7]
        if all(0 <= v <= 4095 for v in f):
            frames.extend(f)
    if len(frames) < 7:
        return None
    num = len(frames) // 7
    c0 = torch.zeros(num, dtype=torch.int32, device=device)
    c1 = torch.zeros(num * 2, dtype=torch.int32, device=device)
    c2 = torch.zeros(num * 4, dtype=torch.int32, device=device)
    ft = torch.tensor(frames, dtype=torch.int32, device=device)
    for j in range(num):
        i = j * 7
        c0[j] = ft[i]
        c1[j * 2] = ft[i + 1]
        c1[j * 2 + 1] = ft[i + 4]
        c2[j * 4] = ft[i + 2]
        c2[j * 4 + 1] = ft[i + 3]
        c2[j * 4 + 2] = ft[i + 5]
        c2[j * 4 + 3] = ft[i + 6]
    codes = [c0.unsqueeze(0), c1.unsqueeze(0), c2.unsqueeze(0)]
    with torch.inference_mode():
        audio = snac_model.decode(codes)
    return audio[0, 0].cpu().numpy()


def main() -> int:
    ap = argparse.ArgumentParser(description="Orpheus-3B Hindi TTS -> mono 24kHz wav")
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default=HINDI_VOICE)
    ap.add_argument("--temperature", type=float, default=0.6)
    ap.add_argument("--top-p", type=float, default=0.9)
    ap.add_argument("--repeat-penalty", type=float, default=1.1)
    ap.add_argument("--max-tokens", type=int, default=2000)
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    import torch
    from huggingface_hub import hf_hub_download
    from llama_cpp import Llama
    from snac import SNAC

    gguf = hf_hub_download(GGUF_REPO, GGUF_FILE)
    n_threads = max(1, (os.cpu_count() or 4) - 2)
    # Offload to the Intel Iris Xe iGPU when llama-cpp-python was built with the Vulkan backend
    # (-DGGML_VULKAN=on). -1 = offload ALL layers; ignored by a CPU-only build. Env override:
    # ORPHEUS_GPU_LAYERS=0 forces CPU. GPU non-determinism is fine — the cached wav is the record.
    n_gpu = int(os.environ.get("ORPHEUS_GPU_LAYERS", "-1"))
    verbose = os.environ.get("ORPHEUS_VERBOSE", "0") == "1"
    llm = Llama(model_path=gguf, n_ctx=4096, n_threads=n_threads, n_gpu_layers=n_gpu, verbose=verbose)

    # Orpheus prompt: special-token wrapped "<voice>: <text>" (special tokens tokenized by llama.cpp).
    prompt = f"<|audio|>{args.voice}: {args.text}<|eot_id|>"
    res = llm(
        prompt,
        max_tokens=args.max_tokens,
        temperature=args.temperature,
        top_p=args.top_p,
        repeat_penalty=args.repeat_penalty,
        stop=["<|eot_id|>"],
    )
    text_out = res["choices"][0]["text"]

    # Parse the emitted <custom_token_N> stream. Each audio code is position-encoded:
    #   code = N - 10 - (position * 4096),  position cycling 0..6 across a 7-code SNAC frame.
    # BUT the model emits a few control/preamble custom tokens first (e.g. 4,5,1), which shift the
    # position counter. So we AUTO-ALIGN: try each start offset 0..6 and pick the one that yields the
    # most in-range (0..4095) codes — robust to any preamble length.
    ns = [int(m.group(1)) for m in CUSTOM_TOKEN_RE.finditer(text_out)]
    if len(ns) < 14:
        print(f"orpheus: too few audio tokens ({len(ns)}) — got: {text_out[:120]!r}", file=sys.stderr)
        return 1

    def ids_for_offset(off):
        return [ns[off + i] - 10 - ((i % 7) * 4096) for i in range(len(ns) - off)]

    best_off, ids, best_score = 0, [], -1
    for off in range(7):
        cand = ids_for_offset(off)
        score = sum(1 for v in cand if 0 <= v <= 4095)
        if score > best_score:
            best_score, best_off, ids = score, off, cand

    snac_model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval().to("cpu")
    audio = convert_to_audio(ids, snac_model, "cpu")
    if audio is None or len(audio) == 0:
        print("orpheus: SNAC produced no audio", file=sys.stderr)
        return 1
    sf.write(args.out, np.asarray(audio, dtype=np.float32), samplerate=24000)
    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"orpheus: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure -> nonzero so Node falls back to espeak-ng.
        print(f"orpheus_synth failed: {exc}", file=sys.stderr)
        sys.exit(1)
