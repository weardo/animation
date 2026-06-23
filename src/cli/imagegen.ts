// factory:imagegen — OFFLINE AI image asset-gen via Stable Diffusion on OpenVINO (M9).
//
// Golden rule 2: AI NEVER touches frames or the runtime — it produces ONLY offline library assets.
// Golden rule 1 (determinism-as-cached): SD is stochastic, but we run it ONCE OFFLINE at build into a
// CONTENT-ADDRESSED cache (hash of {prompt, seed, model, steps, size, negative, guidance}, skip-if-
// exists) and the render replays the FIXED cached PNG, so the muxed video is byte-deterministic even
// though the generator is not bit-exact across machines. The deterministic artifact is the cached PNG,
// NOT the model — exactly like TTS (narrate.ts) and whisper alignment.
//
//   npm run factory:imagegen -- --prompt "a glowing crystal, flat vector" --id crystal_prop
//   npm run factory:imagegen -- --prompt "…" --id … --seed 7 --steps 24 --model lcm --width 512 --height 512
//
// Pipeline (all deterministic over the generated-then-FIXED PNG bytes):
//   content-address the request → if a cached PNG exists for this hash, reuse it (skip SD) →
//   else run .venv-sd/bin/python scripts/imagegen/sd_openvino.py ONCE into the cache (on any failure
//   — missing venv / model load error — synthesize a DETERMINISTIC placeholder PNG so the build never
//   fails, golden rule 1) → copy the PNG to public/generated/<id>.png (the render publicDir source) +
//   library/generated/<id>.png (the catalog source-of-record) → register/update an `asset` catalog
//   entry (kind='asset', format='image', uri='asset://generated/<id>.png') with provenance + license.
//
// This module is PURE build-time I/O: it never runs at render, and it names NO plugin (an `asset` PNG
// needs no provider — the AssetLayer renders an `image` asset directly), so the engine core stays
// plugin-free. It is invoked via the thin `factory:imagegen` script (src/cli) — no composition root
// injection needed (unlike ingest-icons, which needs a provider's spec schema).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import objectHash from 'object-hash';
import { SemverSchema } from '../library/index.js';

/** The isolated OpenVINO Stable-Diffusion venv + the offline synth CLI (run OFFLINE; never at render). */
const SD_PYTHON = '.venv-sd/bin/python';
const SD_SCRIPT = 'scripts/imagegen/sd_openvino.py';
/** The shared HF model cache (pinned so OV SD models never re-download per-process). */
const HF_HOME = '/mnt/data/astra/.cache/hf';

/** Provenance for the cataloged asset: the upstream model's license + source repo. */
const MODEL_LICENSE: Record<string, { license: string; source: string }> = {
  sd15: {
    license: 'CreativeML-OpenRAIL-M',
    source: 'OpenVINO/stable-diffusion-v1-5-fp16-ov (Stable Diffusion v1.5, runwayml)',
  },
  lcm: {
    license: 'CreativeML-OpenRAIL-M',
    source: 'OpenVINO/LCM_Dreamshaper_v7-fp16-ov (Latent Consistency, SimianLuo)',
  },
};

/** Inputs that fully determine a generated image → its content-address (cache key). */
export interface ImageGenRequest {
  prompt: string;
  /** Negative prompt (optional). Folds into the cache key. */
  negative: string;
  /** Fixed RNG seed → reproducible generation. */
  seed: number;
  /** Model id: 'sd15' | 'lcm' (or a raw OV/HF repo id). */
  model: string;
  /** Num inference steps. */
  steps: number;
  /** Classifier-free guidance scale. */
  guidance: number;
  width: number;
  height: number;
}

/** Defaults: SD 1.5, a calm step count, square 512, deterministic seed 0. */
export const DEFAULTS: ImageGenRequest = {
  prompt: '',
  negative: '',
  seed: 0,
  model: 'sd15',
  steps: 20,
  guidance: 7.5,
  width: 512,
  height: 512,
};

/** Where a generated image lives + how it was produced. */
export interface ImageGenResult {
  /** Content-address (hash of the request). */
  hash: string;
  /** The library id the asset is cataloged under. */
  id: string;
  /** Absolute path to the PNG in public/ (the render publicDir source). */
  pngPath: string;
  /** The catalog entry's `asset://…` uri (resolves under public/ at render via staticFile). */
  uri: string;
  /** True when this call reused an existing cached PNG (skip-if-exists). */
  cached: boolean;
  /** True when SD produced the PNG; false = the deterministic placeholder fallback was used. */
  generated: boolean;
}

/**
 * Content-address a request: hash(prompt + negative + seed + model + steps + guidance + size). Stable +
 * collision-resistant (object-hash, the repo's adopted hasher), so an identical request reuses ONE
 * cached PNG and any change re-generates. The hash is the cache file name AND the addressable identity.
 */
export function imageGenHash(req: ImageGenRequest): string {
  return objectHash({
    prompt: req.prompt,
    negative: req.negative,
    seed: req.seed,
    model: req.model,
    steps: req.steps,
    guidance: req.guidance,
    width: req.width,
    height: req.height,
  }).slice(0, 16);
}

/**
 * Run the OpenVINO SD synth CLI: `.venv-sd/bin/python scripts/imagegen/sd_openvino.py --prompt … --out
 * …`, HF_HOME pinned. Returns false (→ deterministic placeholder fallback, never fail the build) if the
 * venv python / script is missing or the synth errors.
 */
function runSd(req: ImageGenRequest, pngPath: string, rootDir: string): boolean {
  const py = resolvePath(rootDir, SD_PYTHON);
  const script = resolvePath(rootDir, SD_SCRIPT);
  if (!existsSync(py) || !existsSync(script)) return false;
  try {
    execFileSync(
      py,
      [
        script,
        '--prompt', req.prompt,
        '--negative', req.negative,
        '--seed', String(req.seed),
        '--steps', String(req.steps),
        '--guidance', String(req.guidance),
        '--width', String(req.width),
        '--height', String(req.height),
        '--model', req.model,
        '--out', pngPath,
      ],
      { stdio: 'inherit', env: { ...process.env, HF_HOME: process.env['HF_HOME'] ?? HF_HOME } },
    );
    return existsSync(pngPath);
  } catch {
    return false;
  }
}

/**
 * Write a DETERMINISTIC placeholder PNG (so the build NEVER fails when .venv-sd / the model is missing —
 * golden rule 1: the cached artifact is the record). The placeholder is a tiny, fixed-byte PNG: a solid
 * mid-grey scaled by an Img to the asset's box. We synthesize it with ffmpeg (always available — used
 * throughout the audio stack); a color source is byte-stable for fixed dimensions. The hash key folds in
 * the request, so once .venv-sd is present a re-run regenerates a real image under a fresh cache file
 * only if inputs change — a placeholder that was committed stays the deterministic record until then.
 */
function writePlaceholder(pngPath: string, width: number, height: number): boolean {
  try {
    execFileSync(
      'ffmpeg',
      [
        '-v', 'error', '-y',
        '-f', 'lavfi',
        '-i', `color=c=0x808080:s=${width}x${height}:d=1`,
        '-frames:v', '1',
        pngPath,
      ],
      { stdio: 'pipe' },
    );
    return existsSync(pngPath);
  } catch {
    return false;
  }
}

export interface ImageGenOptions extends Partial<ImageGenRequest> {
  /** The library id the asset is cataloged under (file-safe). Required. */
  id: string;
  /** Repo root (where library/index.json + public/ live). */
  rootDir: string;
  /** Catalog namespace for the entry (default 'generated'). */
  namespace?: string;
}

/**
 * Generate (or reuse) one image asset → a content-addressed PNG cataloged as a library `asset`. The
 * CONTENT-ADDRESSED cache lives at `library/generated/.cache/<hash>.png`; a cache hit reuses it (skips
 * SD) — this is what makes a re-build byte-identical regardless of SD stochasticity. The resolved PNG is
 * copied to `public/generated/<id>.png` (the render publicDir source) AND `library/generated/<id>.png`
 * (the catalog source-of-record), then registered as an `asset` (kind='asset', format='image').
 */
export function generateImage(opts: ImageGenOptions): ImageGenResult {
  const { id, rootDir } = opts;
  if (!id || !/^[a-z0-9_]+$/i.test(id)) {
    throw new Error(`--id must be a file-safe token [a-z0-9_]+ (got '${id}')`);
  }
  const namespace = opts.namespace ?? 'generated';
  const req: ImageGenRequest = {
    prompt: opts.prompt ?? DEFAULTS.prompt,
    negative: opts.negative ?? DEFAULTS.negative,
    seed: opts.seed ?? DEFAULTS.seed,
    model: opts.model ?? DEFAULTS.model,
    steps: opts.steps ?? DEFAULTS.steps,
    guidance: opts.guidance ?? DEFAULTS.guidance,
    width: opts.width ?? DEFAULTS.width,
    height: opts.height ?? DEFAULTS.height,
  };
  if (!req.prompt) throw new Error('--prompt is required');

  const hash = imageGenHash(req);

  // 1. The content-addressed cache (the deterministic record). Skip-if-exists.
  const cacheDir = resolvePath(rootDir, 'library', namespace, '.cache');
  const cachePng = resolvePath(cacheDir, `${hash}.png`);
  let cached = true;
  let generated = true;
  if (!existsSync(cachePng)) {
    cached = false;
    mkdirSync(cacheDir, { recursive: true });
    const ok = runSd(req, cachePng, rootDir);
    if (!ok) {
      generated = false;
      console.warn(
        `[imagegen] .venv-sd unavailable/failed → writing a deterministic placeholder for '${id}' ` +
          `(install .venv-sd + the OV SD model to generate the real image; the cache key is unchanged)`,
      );
      if (!writePlaceholder(cachePng, req.width, req.height)) {
        throw new Error(`[imagegen] neither SD nor the ffmpeg placeholder produced a PNG at ${cachePng}`);
      }
    }
  }

  // 2. Publish the cached PNG to public/ (render source) + library/ (catalog source-of-record).
  const publicDir = resolvePath(rootDir, 'public', namespace);
  const libDir = resolvePath(rootDir, 'library', namespace);
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(libDir, { recursive: true });
  const pngPath = resolvePath(publicDir, `${id}.png`);
  const libPng = resolvePath(libDir, `${id}.png`);
  copyFileSync(cachePng, pngPath);
  copyFileSync(cachePng, libPng);

  // 3. Register/update the `asset` catalog entry (kind='asset', format='image').
  const uri = `asset://${namespace}/${id}.png`;
  const prov = MODEL_LICENSE[req.model] ?? {
    license: 'unknown',
    source: `OpenVINO Stable Diffusion (${req.model})`,
  };
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries[namespace] ??= {};
  const prev = idx.entries[namespace][id] ?? {};
  const version = (prev.version as string | undefined) ?? '1.0.0';
  idx.entries[namespace][id] = {
    id,
    version: SemverSchema.parse(version),
    kind: 'asset',
    format: 'image',
    uri,
    tags: ['m9', 'generated', 'ai', 'sd-openvino', req.model],
    deps: [],
    provenance: {
      source: generated
        ? `stable-diffusion-openvino: ${prov.source}`
        : `placeholder (.venv-sd unavailable at build) — re-run factory:imagegen to generate`,
      // The full request recorded so the artifact is reproducible (re-run → same cache key → same PNG).
      prompt: req.prompt,
      ...(req.negative ? { negative: req.negative } : {}),
      seed: req.seed,
      model: req.model,
      steps: req.steps,
      guidance: req.guidance,
      size: `${req.width}x${req.height}`,
      cache_hash: hash,
      license: prov.license,
      generated,
    },
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');

  console.log(
    `[imagegen] ${id}  ${generated ? 'generated' : 'PLACEHOLDER'}${cached ? ' (cached)' : ''}  ` +
      `hash:${hash}  ${req.width}x${req.height}  model:${req.model}  → ${uri}`,
  );
  console.log(`[imagegen] catalog: library/index.json (ns '${namespace}')  ·  license: ${prov.license}`);
  console.log(`[imagegen] use → a story cast ref { ref: '${id}' } + a show item { actor: '${id}' } (asset layer)`);

  return { hash, id, pngPath, uri, cached, generated };
}

/** Parse argv (without node/script) into ImageGenOptions. */
export function parseArgs(argv: string[], rootDir: string): ImageGenOptions {
  const opts: ImageGenOptions = { id: '', rootDir };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`flag ${a} expects a value`);
      return v;
    };
    switch (a) {
      case '--prompt': opts.prompt = next(); break;
      case '--negative': opts.negative = next(); break;
      case '--id': opts.id = next(); break;
      case '--seed': opts.seed = Number(next()); break;
      case '--steps': opts.steps = Number(next()); break;
      case '--guidance': opts.guidance = Number(next()); break;
      case '--width': opts.width = Number(next()); break;
      case '--height': opts.height = Number(next()); break;
      case '--model': opts.model = next(); break;
      case '--namespace': opts.namespace = next(); break;
      default:
        throw new Error(`unknown flag: ${a}`);
    }
  }
  return opts;
}

/** CLI entry: `npm run factory:imagegen -- --prompt … --id …`. Root = cwd (where library/ + public/ live). */
function main(): void {
  const rootDir = process.cwd();
  let opts: ImageGenOptions;
  try {
    opts = parseArgs(process.argv.slice(2), rootDir);
  } catch (err) {
    console.error(`[imagegen] ${err instanceof Error ? err.message : String(err)}`);
    console.error('usage: factory:imagegen -- --prompt "<text>" --id <name> [--seed N] [--steps N] [--model sd15|lcm] [--width N] [--height N] [--negative "<text>"] [--guidance N] [--namespace generated]');
    process.exit(1);
  }
  try {
    generateImage(opts);
  } catch (err) {
    console.error(`[imagegen] failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

// Run as a CLI only when executed directly (not when imported by tests/other modules).
if (process.argv[1] && process.argv[1].endsWith('imagegen.ts')) {
  main();
}
