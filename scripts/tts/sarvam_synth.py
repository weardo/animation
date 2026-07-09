#!/usr/bin/env python
"""sarvam_synth.py — Sarvam AI Bulbul v3 TTS (native Hinglish, emotional) synth CLI.

Sarvam's Bulbul v3 is a NATIVE Indic TTS (built for Hindi/Hinglish code-switching) with young,
expressive voices — the cloud/paid tier. Unlike the local engines this calls Sarvam's HTTP API, so it
needs SARVAM_API_KEY (free tier: ₹1000 credits, ~333 reels). Stdlib-only (urllib) — no venv/model.

Golden rule 1 still holds: this runs ONCE OFFLINE at build into the content-addressed wav cache; the
render replays the FIXED wav, so output stays byte-deterministic even though the API is not. A missing
key / network error exits nonzero → the Node caller falls back to espeak-ng (never fails the build).

Run:  SARVAM_API_KEY=... python scripts/tts/sarvam_synth.py --text "..." --out /abs/path.wav \
        [--speaker aditya] [--lang hi-IN] [--pace 1.1] [--temperature 0.7]
"""
import argparse
import base64
import json
import os
import sys
import urllib.request

API_URL = "https://api.sarvam.ai/text-to-speech"
# Bulbul v3 caps text per request; a reel line is well under this, but we chunk defensively.
MAX_CHARS = 2400


def synth_chunk(text, key, speaker, lang, model, pace, temperature, sample_rate):
    body = json.dumps({
        "text": text,
        "target_language_code": lang,
        "model": model,
        "speaker": speaker,
        "pace": pace,
        "temperature": temperature,
        "speech_sample_rate": sample_rate,
        "output_audio_codec": "wav",
    }).encode("utf-8")
    req = urllib.request.Request(
        API_URL, data=body, method="POST",
        headers={"api-subscription-key": key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    audios = data.get("audios") or []
    if not audios:
        raise RuntimeError(f"no audio in response: {str(data)[:200]}")
    return base64.b64decode(audios[0])


def split_chars(text, limit):
    """Split long text into <=limit-char chunks at sentence boundaries (।/./?/!), greedily."""
    import re
    sents = re.split(r"(?<=[।.?!])\s+", text.strip())
    chunks, cur = [], ""
    for s in sents:
        if len(cur) + len(s) + 1 <= limit:
            cur = (cur + " " + s).strip()
        else:
            if cur:
                chunks.append(cur)
            cur = s
    if cur:
        chunks.append(cur)
    return chunks or [text]


def main() -> int:
    ap = argparse.ArgumentParser(description="Sarvam Bulbul v3 TTS -> wav")
    ap.add_argument("--text", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--speaker", default="shubh", help="v3 voices; young male: shubh, aditya, dev, aayan, sunny, advait")
    ap.add_argument("--lang", default="hi-IN")
    ap.add_argument("--model", default="bulbul:v3")
    ap.add_argument("--pace", type=float, default=1.08)
    # temperature 0.9 = expressive storytelling delivery (audition-picked over the flat 0.6 default).
    ap.add_argument("--temperature", type=float, default=0.9)
    # 48kHz full-band = richer/clearer than the 24kHz default (v3 supports up to 48000).
    ap.add_argument("--sample-rate", type=int, default=48000)
    args = ap.parse_args()

    key = os.environ.get("SARVAM_API_KEY")
    if not key:
        print("sarvam: SARVAM_API_KEY not set", file=sys.stderr)
        return 1

    try:
        chunks = split_chars(args.text, MAX_CHARS)
        wav_bytes = [
            synth_chunk(c, key, args.speaker, args.lang, args.model, args.pace, args.temperature, args.sample_rate)
            for c in chunks
        ]
    except Exception as exc:  # noqa: BLE001
        print(f"sarvam: request failed: {exc}", file=sys.stderr)
        return 1

    if len(wav_bytes) == 1:
        with open(args.out, "wb") as f:
            f.write(wav_bytes[0])
    else:
        # Concatenate multiple wav chunks by decoding PCM and re-writing one wav (stdlib `wave`).
        import io
        import wave
        frames, params = [], None
        for wb in wav_bytes:
            with wave.open(io.BytesIO(wb), "rb") as w:
                params = params or w.getparams()
                frames.append(w.readframes(w.getnframes()))
        with wave.open(args.out, "wb") as out:
            out.setparams(params)
            for fr in frames:
                out.writeframes(fr)

    if not os.path.exists(args.out) or os.path.getsize(args.out) == 0:
        print(f"sarvam: empty output at {args.out}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
