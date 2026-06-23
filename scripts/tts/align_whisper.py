#!/usr/bin/env python
"""align_whisper.py — OFFLINE forced-alignment CLI: a narration wav → PRECISE word timestamps.

Run inside the isolated .venv-whisper:
    .venv-whisper/bin/python scripts/tts/align_whisper.py --wav /abs/clip.wav --out /abs/align.json

Transcribes the wav with faster-whisper (model "small") with `word_timestamps=True` and writes a
JSON array of {"word","start","end"} (seconds) to --out. The render NEVER calls this — it is a
BUILD-time step (golden rule 1/2): the Node narrate pass runs it ONCE into a CONTENT-ADDRESSED cache
(hash of wav-hash + say text, skip-if-exists), and the render replays the FIXED cached JSON, so the
output is byte-deterministic even though whisper itself is not bit-exact across machines.

Exits nonzero on ANY failure (missing venv, model load error, no words). The Node caller then falls
back to the deterministic even-split caption cadence (never fail the build — see narrate-pass.ts).

CPU-only, HF_HOME pinned to the shared model cache so the model never re-downloads per-process. Greedy
decoding (beam_size=1, temperature=0, no condition-on-previous) keeps a given build run as stable as
faster-whisper allows; the cached JSON is the deterministic record regardless.
"""
import argparse
import json
import os
import sys

# Pin the shared model cache + CPU determinism BEFORE importing the heavy stack.
os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("OMP_NUM_THREADS", "1")


def main() -> int:
    ap = argparse.ArgumentParser(description="faster-whisper word-timestamp alignment → JSON")
    ap.add_argument("--wav", required=True, help="absolute input wav path (a cached narration clip)")
    ap.add_argument("--out", required=True, help="absolute output JSON path ([{word,start,end}])")
    ap.add_argument("--model", default="small", help="faster-whisper model size (default: small)")
    ap.add_argument("--lang", default="en", help="language code (default: en)")
    args = ap.parse_args()

    if not os.path.exists(args.wav):
        print(f"align_whisper: wav not found: {args.wav}", file=sys.stderr)
        return 1

    from faster_whisper import WhisperModel

    # CPU, int8 — fast + sufficient for forced alignment; the cached JSON is the record.
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    segments, _info = model.transcribe(
        args.wav,
        language=args.lang,
        word_timestamps=True,
        beam_size=1,
        temperature=0.0,
        condition_on_previous_text=False,
        vad_filter=False,
    )

    words = []
    for seg in segments:
        for w in (seg.words or []):
            token = (w.word or "").strip()
            if not token:
                continue
            words.append(
                {
                    "word": token,
                    "start": round(float(w.start), 4),
                    "end": round(float(w.end), 4),
                }
            )

    if not words:
        print("align_whisper: no words produced", file=sys.stderr)
        return 1

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(words, fh, ensure_ascii=False, separators=(",", ":"))

    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"align_whisper: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001 — any failure → nonzero so Node falls back to even-split.
        print(f"align_whisper failed: {exc}", file=sys.stderr)
        sys.exit(1)
