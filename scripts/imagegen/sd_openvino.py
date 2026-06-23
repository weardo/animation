#!/usr/bin/env python
"""sd_openvino.py — OFFLINE Stable-Diffusion image synthesis on OpenVINO (Iris Xe / CPU).

Run inside the isolated .venv-sd:
    .venv-sd/bin/python scripts/imagegen/sd_openvino.py \
        --prompt "a red apple, flat vector" --seed 1234 --steps 20 \
        --model sd15 --width 512 --height 512 --out /abs/out.png

Generates ONE PNG from (prompt, seed, model, steps, size, negative, guidance) and writes it to --out.
The render NEVER calls this — it is a BUILD-time step (golden rules 1 & 2: AI touches only the offline
library, never frames/runtime). The Node `factory:imagegen` CLI runs it ONCE into a CONTENT-ADDRESSED
cache (hash of all inputs, skip-if-exists) and registers the PNG as a library `asset`; the render then
replays the FIXED cached PNG, so the output is byte-deterministic even though SD itself is stochastic
(the deterministic artifact is the cached PNG, not the model).

Exits nonzero on ANY failure (missing venv, model load error). The Node caller then falls back to a
deterministic placeholder PNG (never fail the build — see imagegen.ts).

Determinism within a build run: a fixed `--seed` drives a torch.Generator; OpenVINO CPU inference is
deterministic same-process for fixed inputs (verified). Cross-machine bit-exactness is NOT required —
the cached PNG committed into the library is the record.

THE transformers-5 / optimum-intel FIX: the pre-exported OV repos ship the safety_checker as an
OpenVINO IR submodel, but transformers 5.x tries to load it as a torch checkpoint (model.safetensors /
pytorch_model.bin) and raises OSError. We pass `safety_checker=None` (we generate offline asset art for
a deterministic pipeline, never a public service), which skips that submodel entirely — no version pin
or re-export needed.
"""
import argparse
import os
import sys

# Pin the shared model cache + CPU determinism BEFORE importing the heavy stack.
os.environ.setdefault("HF_HOME", "/mnt/data/astra/.cache/hf")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("CUDA_VISIBLE_DEVICES", "")
os.environ.setdefault("OMP_NUM_THREADS", "1")

# Catalog of pre-exported OpenVINO SD repos (cached under HF_HOME). `lcm` is a Latent-Consistency
# model — designed for very few steps (4-8), the fastest path on the iGPU/CPU.
MODELS = {
    "sd15": "OpenVINO/stable-diffusion-v1-5-fp16-ov",
    "lcm": "OpenVINO/LCM_Dreamshaper_v7-fp16-ov",
}


def main() -> int:
    ap = argparse.ArgumentParser(description="Stable Diffusion on OpenVINO → PNG (offline asset-gen)")
    ap.add_argument("--prompt", required=True, help="text prompt")
    ap.add_argument("--negative", default="", help="negative prompt (optional)")
    ap.add_argument("--seed", type=int, default=0, help="RNG seed (fixed → reproducible)")
    ap.add_argument("--steps", type=int, default=20, help="num inference steps")
    ap.add_argument("--guidance", type=float, default=7.5, help="classifier-free guidance scale")
    ap.add_argument("--width", type=int, default=512, help="output width (multiple of 8)")
    ap.add_argument("--height", type=int, default=512, help="output height (multiple of 8)")
    ap.add_argument("--model", default="sd15", help="model id: %s, or a raw HF/OV repo id" % "/".join(MODELS))
    ap.add_argument("--out", required=True, help="absolute output PNG path")
    args = ap.parse_args()

    repo = MODELS.get(args.model, args.model)

    try:
        import torch
        from optimum.intel import OVStableDiffusionPipeline
    except Exception as e:  # pragma: no cover - env guard
        print(f"[sd] import failed: {e}", file=sys.stderr)
        return 2

    try:
        # compile=False → we reshape to the requested size first (static shapes = faster OV inference),
        # then compile once. safety_checker=None is the transformers-5 fix (see module docstring).
        pipe = OVStableDiffusionPipeline.from_pretrained(repo, safety_checker=None, compile=False)
        pipe.reshape(batch_size=1, height=args.height, width=args.width, num_images_per_prompt=1)
        pipe.compile()
    except Exception as e:
        print(f"[sd] model load/compile failed ({repo}): {e}", file=sys.stderr)
        return 3

    try:
        generator = torch.Generator().manual_seed(args.seed)
        result = pipe(
            prompt=args.prompt,
            negative_prompt=args.negative or None,
            num_inference_steps=args.steps,
            guidance_scale=args.guidance,
            height=args.height,
            width=args.width,
            generator=generator,
        )
        image = result.images[0]
    except Exception as e:
        print(f"[sd] inference failed: {e}", file=sys.stderr)
        return 4

    os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
    image.save(args.out, format="PNG")
    if not os.path.exists(args.out):
        print("[sd] save produced no file", file=sys.stderr)
        return 5
    print(f"[sd] wrote {args.out} ({args.width}x{args.height}, model={repo}, steps={args.steps}, seed={args.seed})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
