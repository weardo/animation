#!/usr/bin/env python
"""orpheus_speech.py — MULTI-SENTENCE Orpheus TTS: long, emotional speech without drift.

LLM-based TTS (Orpheus) hallucinates, repeats, and SWAPS VOICE when asked to generate long audio in
one shot. The fix (used by every production Orpheus setup): synthesize SENTENCE-BY-SENTENCE and
concatenate. This script loads the model ONCE (GPU via Vulkan), synths each sentence as its own short,
stable generation, and joins them with a small pause. That kills the split-voice + hallucination issues.

Emotion: only the SOUND-EFFECT tags work — <laugh> <chuckle> <sigh> <cough> <sniffle> <groan> <yawn>
<gasp> <giggle> — placed inline. Emotional TONE otherwise comes from the model's prosody + the wording;
there is no "happy/whisper" style flag (confirmed by the Orpheus maintainers).

Run inside .venv-orpheus:
    .venv-orpheus/bin/python scripts/tts/orpheus_speech.py --file speech.txt --out /abs/path.wav \
        [--voice ऋतिका] [--temperature 0.6] [--top-p 0.9] [--gap 0.28]

Best settings (from the Orpheus docs/community): temperature 0.6-0.7, top_p 0.9, repetition_penalty 1.1
(the stable value — required, do not lower). CPU/GPU chosen by ORPHEUS_GPU_LAYERS (-1 = all on GPU).
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
# Emotion sound-effect tags Orpheus understands — kept attached to their sentence, never split on.
EMOTION_TAGS = {"laugh", "chuckle", "sigh", "cough", "sniffle", "groan", "yawn", "gasp", "giggle"}


def split_sentences(text):
    """Split into sentence-sized chunks on Devanagari danda (।) + . ? ! while keeping emotion tags with
    their sentence. Short trailing fragments merge forward so a lone tag never becomes its own chunk."""
    parts = re.split(r"(?<=[।.?!])\s+", text.strip())
    chunks = []
    for p in parts:
        p = p.strip()
        if not p:
            continue
        # A fragment that is ONLY an emotion tag (or too short) merges into the next chunk.
        stripped = re.sub(r"<\w+>", "", p).strip()
        if len(stripped) < 2 and chunks:
            chunks[-1] = chunks[-1] + " " + p
        elif len(stripped) < 2:
            chunks.append(p)  # will merge on next iteration via the branch above
        else:
            chunks.append(p)
    return chunks


def synth_sentence(llm, snac_model, text, voice, temperature, top_p, max_tokens):
    """Synthesize ONE sentence → float32 numpy audio (24 kHz), or None. Auto-aligns past the model's
    preamble control tokens (the fix that made decoding work) and drops any out-of-range SNAC frames."""
    import numpy as np
    import torch

    prompt = f"<|audio|>{voice}: {text}<|eot_id|>"
    res = llm(
        prompt, max_tokens=max_tokens, temperature=temperature, top_p=top_p,
        repeat_penalty=1.1, stop=["<|eot_id|>"],
    )
    ns = [int(m.group(1)) for m in CUSTOM_TOKEN_RE.finditer(res["choices"][0]["text"])]
    if len(ns) < 14:
        return None

    # Auto-align: pick the start offset (0..6) that yields the most in-range codes.
    best_ids, best_score = [], -1
    for off in range(7):
        cand = [ns[off + i] - 10 - ((i % 7) * 4096) for i in range(len(ns) - off)]
        score = sum(1 for v in cand if 0 <= v <= 4095)
        if score > best_score:
            best_score, best_ids = score, cand

    # Keep only whole frames whose 7 codes are all valid, then SNAC-decode.
    frames = []
    for j in range(len(best_ids) // 7):
        f = best_ids[j * 7 : j * 7 + 7]
        if all(0 <= v <= 4095 for v in f):
            frames.extend(f)
    if len(frames) < 7:
        return None
    num = len(frames) // 7
    c0 = torch.zeros(num, dtype=torch.int32)
    c1 = torch.zeros(num * 2, dtype=torch.int32)
    c2 = torch.zeros(num * 4, dtype=torch.int32)
    ft = torch.tensor(frames, dtype=torch.int32)
    for j in range(num):
        i = j * 7
        c0[j] = ft[i]
        c1[j * 2] = ft[i + 1]; c1[j * 2 + 1] = ft[i + 4]
        c2[j * 4] = ft[i + 2]; c2[j * 4 + 1] = ft[i + 3]
        c2[j * 4 + 2] = ft[i + 5]; c2[j * 4 + 3] = ft[i + 6]
    with torch.inference_mode():
        audio = snac_model.decode([c0.unsqueeze(0), c1.unsqueeze(0), c2.unsqueeze(0)])
    return np.asarray(audio[0, 0].cpu().numpy(), dtype=np.float32)


def main() -> int:
    ap = argparse.ArgumentParser(description="Orpheus multi-sentence Hindi speech -> mono 24kHz wav")
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--text")
    src.add_argument("--file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--voice", default=HINDI_VOICE)
    ap.add_argument("--temperature", type=float, default=0.6)
    ap.add_argument("--top-p", type=float, default=0.9)
    ap.add_argument("--max-tokens", type=int, default=1400)
    ap.add_argument("--gap", type=float, default=0.28, help="silence (s) between sentences")
    args = ap.parse_args()

    import numpy as np
    import soundfile as sf
    from huggingface_hub import hf_hub_download
    from llama_cpp import Llama
    from snac import SNAC

    text = args.text if args.text else open(args.file, encoding="utf-8").read()
    sentences = split_sentences(text)
    if not sentences:
        print("orpheus: no sentences to speak", file=sys.stderr)
        return 1

    gguf = hf_hub_download(GGUF_REPO, GGUF_FILE)
    n_gpu = int(os.environ.get("ORPHEUS_GPU_LAYERS", "-1"))
    llm = Llama(model_path=gguf, n_ctx=4096, n_threads=max(1, (os.cpu_count() or 4) - 2),
                n_gpu_layers=n_gpu, verbose=False)
    snac_model = SNAC.from_pretrained("hubertsiuzdak/snac_24khz").eval()

    gap = np.zeros(int(24000 * args.gap), dtype=np.float32)
    pieces = []
    for i, s in enumerate(sentences):
        audio = synth_sentence(llm, snac_model, s, args.voice, args.temperature, args.top_p, args.max_tokens)
        if audio is None or len(audio) == 0:
            print(f"orpheus: sentence {i+1}/{len(sentences)} produced no audio, skipped: {s[:40]!r}", file=sys.stderr)
            continue
        pieces.append(audio)
        pieces.append(gap)
        print(f"  [{i+1}/{len(sentences)}] {len(audio)/24000:.1f}s : {s[:50]}", file=sys.stderr)

    if not pieces:
        print("orpheus: no audio produced for any sentence", file=sys.stderr)
        return 1
    full = np.concatenate(pieces)
    sf.write(args.out, full, samplerate=24000)
    print(f"orpheus: wrote {len(full)/24000:.1f}s from {len(sentences)} sentences → {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(f"orpheus_speech failed: {exc}", file=sys.stderr)
        sys.exit(1)
