// P7 — Director. Spec §5, §14.3 (the "smart layout / camera director" milestone, M5). Replaces the
// LITE layout's dumb anchor lookup + the LITE camera's "default = hold" with a real DIRECTOR that
// SCORES layer placement and PICKS a camera move per beat.
//
// ARCHITECTURE (the LLM seam): a thin `Director` interface with TWO impls —
//   • HeuristicDirector  — the DEFAULT. A pure, deterministic, local scorer (no network, no LLM).
//                          It scores candidate placements (balance, focal weight, headroom,
//                          rule-of-thirds, safe-area for the chosen aspect) and picks a camera move
//                          from `library/camera/presets.json` by beat INTENT.
//   • LlmDirector        — OPT-IN. Shells to `claude -p --output-format json` with a tight prompt to
//                          emit a layout/camera PLAN as DATA, VALIDATED by Zod and CACHED
//                          content-addressed on the story+beat hash. The render NEVER calls the LLM:
//                          a cache hit replays the FIXED plan → byte-deterministic + offline. Falls
//                          back to the heuristic when `claude -p` is unavailable or its output is bad.
//
// The director produces a {@link DirectorPlan} (per-scene placements + camera intent), expressed in
// ASPECT-INDEPENDENT FRACTIONAL coordinates (0..1 of the frame) so the same plan scales to any
// config and the LLM emits geometry it can reason about without pixels. {@link applyPlan} folds the
// plan into the lowered IR: it sets each placed layer's `transform.position` (fraction → pixels
// against `config`) and the scene's `camera_intent` — which the existing layout (P6) + camera (P8)
// lite passes then finish. An EXPLICITLY-authored camera or position always WINS (the director only
// fills what the author left to the machine).
//
// PURE + DETERMINISTIC (CLAUDE.md golden rule 1): the heuristic is a pure function of the IR; the LLM
// path is made deterministic the same way TTS/whisper are — the stochastic generator runs ONCE
// OFFLINE into a content-addressed cache (hash of the inputs, skip-if-exists) and the plan is replayed
// from disk forever after. No wall-clock, no Math.random.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import objectHash from 'object-hash';
import { z } from 'zod';

import type { SceneConfig, Transform, AnimatedVec2, Vec2, CameraIntent } from '../ir/index.js';
import type { LoweredSceneIR, LoweredScene, LoweredLayer } from './contract.js';
import { isKnownIntent, DEFAULT_INTENT } from './camera.js';

/**
 * True when a layer's placement is "left to the machine" — it carries NO author anchor and NO
 * explicit position. Lowering (M5) emits an `anchor` ONLY for an author-declared `at`, and a
 * `transform.position` only for an author-positioned layer; so EITHER present = author intent the
 * director leaves untouched (the layout pass resolves the anchor). A free layer is the director's to
 * place.
 */
function placementIsFree(layer: LoweredLayer): boolean {
  const tf = 'transform' in layer ? (layer as { transform?: Transform }).transform : undefined;
  if (tf?.position !== undefined) return false;
  return layer.anchor === undefined;
}

/** Pass identity for cache keys / provenance (spec §5: per-stage versioning). */
export const DIRECTOR_PASS = 'director@0.1' as const;

// ---------------------------------------------------------------------------------------------
// The plan model — the seam DATA both impls produce (and the LLM's output is validated against).
// FRACTIONAL coordinates (0..1 of the frame) keep a plan aspect-independent + LLM-reasoned.
// ---------------------------------------------------------------------------------------------

/** A placement for one layer: a fractional position [fx, fy] (0 = top/left, 1 = bottom/right). */
export const PlacementSchema = z
  .object({
    /** The layer id this placement targets (a Scene-IR layer `id`). */
    id: z.string().min(1),
    /** Fractional x in [0,1] (0 = left edge, 1 = right edge). */
    x: z.number().min(0).max(1),
    /** Fractional y in [0,1] (0 = top edge, 1 = bottom edge). */
    y: z.number().min(0).max(1),
  })
  .strict();
export type Placement = z.infer<typeof PlacementSchema>;

/** The director's plan for ONE scene: placements + an optional camera intent (a preset NAME). */
export const ScenePlanSchema = z
  .object({
    /** The scene id this plan targets (a beat id). */
    id: z.string().min(1),
    /** Per-layer fractional placements (only layers the director chose to place). */
    placements: z.array(PlacementSchema).default([]),
    /**
     * A camera move PRESET name (a key in `library/camera/presets.json`, e.g. "establishing",
     * "slow_push_in", "hold"). Validated against the live preset table by {@link validatePlan}.
     * Omitted → the scene keeps whatever camera intent lowering carried (or the default).
     */
    camera: z.string().min(1).optional(),
  })
  .strict();
export type ScenePlan = z.infer<typeof ScenePlanSchema>;

/** The whole director plan: one {@link ScenePlan} per scene (by id). */
export const DirectorPlanSchema = z
  .object({
    scenes: z.array(ScenePlanSchema),
  })
  .strict();
export type DirectorPlan = z.infer<typeof DirectorPlanSchema>;

/**
 * Validate a raw (e.g. LLM-emitted) plan against the schema AND the live camera-preset table: a
 * `camera` value that is not a known preset name is REJECTED (no silent wrong-move). Throws on any
 * violation so the LLM path can catch + fall back to the heuristic. Pure.
 */
export function validatePlan(raw: unknown): DirectorPlan {
  const plan = DirectorPlanSchema.parse(raw);
  for (const s of plan.scenes) {
    if (s.camera !== undefined && !isKnownIntent(s.camera)) {
      throw new Error(
        `director plan names unknown camera preset "${s.camera}" for scene "${s.id}".`,
      );
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// The Director interface — the LLM seam. Two impls below.
// ---------------------------------------------------------------------------------------------

/**
 * A Director plans layout + camera for a lowered Scene IR. It returns a {@link DirectorPlan} (it does
 * NOT mutate the IR — {@link applyPlan} folds the plan in). Implementations: {@link HeuristicDirector}
 * (pure/local/default) and {@link LlmDirector} (claude -p, cached, opt-in).
 */
export interface Director {
  /** A stable id for provenance/logging. */
  readonly id: string;
  /** Produce a layout/camera plan for the lowered IR. */
  plan(ir: LoweredSceneIR): DirectorPlan;
}

// ---------------------------------------------------------------------------------------------
// Safe-area + the candidate slot grid — both a function of the ASPECT (config w/h), so the director
// respects format. A tall 9:16 short pulls subjects toward the vertical centre band; a wide 21:9 has
// room on the sides. Fractions, never pixels (aspect-independent until applied to config).
// ---------------------------------------------------------------------------------------------

/** Fractional safe-area inset (margin) on each edge, scaled by aspect. Title-safe ≈ 10% baseline. */
function safeArea(config: SceneConfig): { minX: number; maxX: number; minY: number; maxY: number } {
  const aspect = config.w / config.h;
  // Wider frames can use more horizontal room; taller frames need a bigger vertical margin so the
  // subject doesn't crowd the top/bottom. A pure function of the aspect ratio (deterministic).
  const marginX = aspect >= 1 ? 0.1 : 0.14;
  const marginY = aspect >= 1 ? 0.12 : 0.1;
  return { minX: marginX, maxX: 1 - marginX, minY: marginY, maxY: 1 - marginY };
}

/**
 * The rule-of-thirds candidate slots (fractional), clamped into the safe area. Ordered by FOCAL
 * PRIORITY: the strongest composition point first (a thirds intersection / the centre), then the
 * weaker ones. The scorer assigns layers to slots best-first by focal weight.
 */
function candidateSlots(config: SceneConfig): Vec2[] {
  const sa = safeArea(config);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  // Rule-of-thirds lines mapped into the safe area.
  const x1 = lerp(sa.minX, sa.maxX, 1 / 3);
  const x2 = lerp(sa.minX, sa.maxX, 2 / 3);
  const xc = lerp(sa.minX, sa.maxX, 0.5);
  const y1 = lerp(sa.minY, sa.maxY, 1 / 3);
  const y2 = lerp(sa.minY, sa.maxY, 2 / 3);
  const yc = lerp(sa.minY, sa.maxY, 0.5);
  // Best-first: lower-thirds centre (grounded hero), the two thirds intersections, the frame centre,
  // then the side mids, then the corners. (Kurzgesagt stages a hero low-centre, props on thirds.)
  return [
    [xc, y2], // grounded hero
    [x1, y1], // upper-left third
    [x2, y1], // upper-right third
    [xc, yc], // dead centre
    [x1, y2], // lower-left third
    [x2, y2], // lower-right third
    [sa.minX, yc], // left mid
    [sa.maxX, yc], // right mid
  ];
}

// ---------------------------------------------------------------------------------------------
// Beat-intent → camera move. The MECHANISM is here; the move RECIPES are DATA (camera presets.json).
// We map a generic, domain-clean notion of "beat intent" (derived structurally from the scene) to a
// preset NAME. No magic offsets/zooms live here — only the choice of which DATA recipe to play.
// ---------------------------------------------------------------------------------------------

/** Candidate camera presets, in the order the heuristic prefers them. All must exist in the table. */
const CAMERA_BY_FOCAL_COUNT: { establish: string; single: string; multi: string; hold: string } = {
  // A title/establishing scene (the FIRST scene) eases in.
  establish: 'establishing',
  // A scene with ONE clear focal subject pushes in slowly (draws attention).
  single: 'slow_push_in',
  // A busy scene with several subjects pulls out (reveals the whole tableau).
  multi: 'slow_pull_out',
  // A calm/empty scene holds.
  hold: 'hold',
};

/** Layer kinds that read as FOCAL subjects the eye lands on (vs. backdrops/ambience). */
function isFocal(layer: LoweredLayer): boolean {
  const t = layer.type;
  return t === 'rig' || t === 'shape' || t === 'text' || t === 'clip' || t === 'footage';
}

/**
 * Pick a camera preset NAME for a scene by its structural INTENT — domain-clean: derived only from
 * the scene's position (first = establishing) + how many focal subjects it stages. Falls back to a
 * known table preset; only names presets we know exist in the DATA table. Pure.
 */
function cameraForScene(scene: LoweredScene, sceneIndex: number): string {
  const focal = scene.layers.filter(isFocal).length;
  let pick: string;
  if (sceneIndex === 0) pick = CAMERA_BY_FOCAL_COUNT.establish;
  else if (focal >= 3) pick = CAMERA_BY_FOCAL_COUNT.multi;
  else if (focal === 1) pick = CAMERA_BY_FOCAL_COUNT.single;
  else pick = CAMERA_BY_FOCAL_COUNT.hold;
  // Defensive: if the chosen preset isn't in the DATA table (a trimmed presets.json), fall back to
  // the table's default intent so the pass never emits an unknown move.
  return isKnownIntent(pick) ? pick : (DEFAULT_INTENT as string);
}

// ---------------------------------------------------------------------------------------------
// HeuristicDirector — the pure, local, deterministic default.
// ---------------------------------------------------------------------------------------------

/**
 * Score-and-place focal layers onto the candidate slots, then balance them. The score rewards:
 *   • FOCAL WEIGHT — heavier subjects (higher z, rigs) claim the stronger slots first;
 *   • HEADROOM     — text/titles bias UP (upper slots), grounded subjects bias DOWN;
 *   • BALANCE      — once one subject takes a side, the next prefers the opposite side;
 *   • RULE-OF-THIRDS + SAFE-AREA — built into the slot grid itself.
 * Returns fractional placements for the focal layers it positions. Pure + deterministic (a function
 * of the scene + config only; ties break on the stable layer id).
 */
function heuristicPlacements(scene: LoweredScene, config: SceneConfig): Placement[] {
  const slots = candidateSlots(config);
  // Focal layers, in author order, whose placement is free (a default anchor / none, no explicit
  // position) — i.e. the author left placement to the director. Author-anchored layers are left alone.
  const focal = scene.layers.filter((l) => isFocal(l) && placementIsFree(l));
  if (focal.length === 0) return [];

  // Focal WEIGHT: a stable score per layer — rigs are the heaviest hero, then by z (higher = nearer
  // = more focal), tie-broken by id for determinism. Heavier subjects pick their slot first.
  const weight = (l: LoweredLayer): number => {
    const z = ('z' in l && typeof (l as { z?: number }).z === 'number' ? (l as { z: number }).z : 0);
    const kindBias = l.type === 'rig' ? 1000 : l.type === 'text' ? -200 : 0;
    return z + kindBias;
  };
  const ordered = [...focal].sort((a, b) => {
    const dw = weight(b) - weight(a);
    if (dw !== 0) return dw;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const placements: Placement[] = [];
  const used: Vec2[] = [];
  const sa = safeArea(config);
  const cx = (sa.minX + sa.maxX) / 2;

  ordered.forEach((layer, rank) => {
    const isText = layer.type === 'text';
    // Build a per-layer slot preference: headroom (text up / subjects down) + balance (alternate the
    // side from already-used slots). Score each free slot; the best wins. Pure tie-break on slot index.
    let bestSlot: Vec2 | undefined;
    let bestScore = -Infinity;
    slots.forEach((slot, si) => {
      // Skip an exact slot already taken (no two subjects on the same point).
      if (used.some((u) => u[0] === slot[0] && u[1] === slot[1])) return;
      let score = 0;
      // RULE-OF-THIRDS / focal priority: earlier slots are stronger composition points; the highest-
      // weight layer (rank 0) should land the strongest one.
      score += (slots.length - si) * (rank === 0 ? 2 : 1);
      // HEADROOM: text biases to the upper half; grounded subjects bias to the lower half.
      score += isText ? (0.5 - slot[1]) * 20 : (slot[1] - 0.5) * 12;
      // BALANCE: prefer the horizontal side OPPOSITE the centroid of what's already placed, so the
      // frame stays balanced rather than clumping on one side.
      if (used.length > 0) {
        const centroidX = used.reduce((s, u) => s + u[0], 0) / used.length;
        const wantSide = centroidX <= cx ? 1 : -1; // pull to the empty side
        score += wantSide * (slot[0] - cx) * 30;
      }
      if (score > bestScore) {
        bestScore = score;
        bestSlot = slot;
      }
    });
    const slot = bestSlot ?? slots[Math.min(rank, slots.length - 1)] ?? [cx, (sa.minY + sa.maxY) / 2];
    used.push(slot);
    placements.push({ id: layer.id, x: slot[0], y: slot[1] });
  });

  return placements;
}

/**
 * The pure, local, DETERMINISTIC default director. Scores placement for every scene's focal layers
 * and picks a camera move by beat intent. No network, no RNG, no wall-clock.
 */
export class HeuristicDirector implements Director {
  readonly id = 'heuristic';
  plan(ir: LoweredSceneIR): DirectorPlan {
    return {
      scenes: ir.scenes.map((scene, i) => ({
        id: scene.id,
        placements: heuristicPlacements(scene, ir.config),
        camera: cameraForScene(scene, i),
      })),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// LlmDirector — opt-in. Shells to `claude -p`, validates + caches the plan content-addressed.
// ---------------------------------------------------------------------------------------------

/** Options for {@link LlmDirector}. */
export interface LlmDirectorOptions {
  /** Project root (cache dir is resolved under it). Default: process.cwd(). */
  rootDir?: string;
  /** Cache directory RELATIVE to rootDir for the content-addressed plan. Default: `.cache/director`. */
  cacheDir?: string;
  /** The `claude` binary. Default: "claude". */
  bin?: string;
  /** A fallback director used when claude -p is unavailable or its output fails validation. */
  fallback?: Director;
}

/** A compact, LLM-friendly description of one scene the prompt asks the model to compose. */
interface SceneBrief {
  id: string;
  index: number;
  /** The focal layers the model may place: id + kind + a short content hint. */
  subjects: { id: string; kind: string; hint?: string }[];
}

/** Build the compact scene briefs the prompt is grounded on (domain-clean: kinds + ids only). */
function sceneBriefs(ir: LoweredSceneIR): SceneBrief[] {
  return ir.scenes.map((scene, index) => ({
    id: scene.id,
    index,
    subjects: scene.layers.filter(isFocal).map((l) => {
      const hint =
        l.type === 'text' && typeof (l as { content?: unknown }).content === 'string'
          ? ((l as { content: string }).content.slice(0, 40))
          : undefined;
      return { id: l.id, kind: l.type, ...(hint ? { hint } : {}) };
    }),
  }));
}

/**
 * The system/instruction prompt: emit ONLY a DirectorPlan JSON. Fractional coords; camera from the
 * named preset list; domain-clean. Kept tight to minimize tokens (reference_claude_p_as_llm_backend).
 */
function buildPrompt(ir: LoweredSceneIR, presetNames: string[]): string {
  const briefs = sceneBriefs(ir);
  const aspect = (ir.config.w / ir.config.h).toFixed(3);
  return [
    'You are a cinematography + layout director for a 2.5D animation.',
    `Frame aspect ratio (w/h) = ${aspect}. Coordinates are FRACTIONAL: x,y in [0,1], 0=top-left, 1=bottom-right.`,
    'Place each subject for a balanced, rule-of-thirds composition with safe-area margins (keep x,y within 0.1..0.9). Titles/text sit higher; grounded subjects lower.',
    `Pick ONE camera move per scene from EXACTLY this list: ${presetNames.join(', ')}.`,
    'Return ONLY minified JSON, no prose, matching:',
    '{"scenes":[{"id":"<sceneId>","placements":[{"id":"<layerId>","x":0.5,"y":0.62}],"camera":"<preset>"}]}',
    'Scenes to compose:',
    JSON.stringify(briefs),
  ].join('\n');
}

/** Content-address the LLM request: the briefs + aspect + preset list fully determine the plan. */
function planCacheKey(ir: LoweredSceneIR, presetNames: string[]): string {
  return objectHash(
    {
      pass: DIRECTOR_PASS,
      aspect: ir.config.w / ir.config.h,
      briefs: sceneBriefs(ir),
      presets: presetNames,
    },
    { algorithm: 'sha1', encoding: 'hex' },
  );
}

/** Extract the plan JSON from `claude -p --output-format json` (whose `.result` holds the model text). */
function extractPlanJson(stdout: string): unknown {
  // `--output-format json` wraps the answer: { type, result, ... }. The model's reply is `.result`.
  let resultText = stdout.trim();
  try {
    const wrapped = JSON.parse(stdout) as { result?: unknown };
    if (wrapped && typeof wrapped === 'object' && typeof wrapped.result === 'string') {
      resultText = wrapped.result.trim();
    }
  } catch {
    // stdout wasn't the JSON envelope — treat it as the raw plan text below.
  }
  // The model may fence the JSON; strip a leading ```json / ``` fence if present.
  const fence = resultText.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence && fence[1]) resultText = fence[1].trim();
  return JSON.parse(resultText);
}

/**
 * The OPT-IN LLM director. Produces the plan by shelling to `claude -p --output-format json` ONCE,
 * validating the result against {@link DirectorPlanSchema} (+ the live preset table), and CACHING it
 * content-addressed on the briefs (skip-if-exists). A cache HIT replays the FIXED plan from disk — so
 * the render is byte-deterministic + fully offline even though the LLM is not. On ANY failure (no
 * binary, non-zero exit, unparseable / invalid output) it falls back to the {@link HeuristicDirector},
 * so the build NEVER fails for lack of an LLM (mirrors the TTS espeak fallback).
 */
export class LlmDirector implements Director {
  readonly id = 'llm';
  private readonly rootDir: string;
  private readonly cacheDir: string;
  private readonly bin: string;
  private readonly fallback: Director;

  constructor(opts: LlmDirectorOptions = {}) {
    this.rootDir = opts.rootDir ?? process.cwd();
    // RELATIVE to rootDir (joined below) so a custom rootDir actually scopes the cache. The pipeline's
    // own Scene-IR cache lives in `<root>/.cache`; the director plan cache sits in `<root>/.cache/director`.
    this.cacheDir = opts.cacheDir ?? '.cache/director';
    this.bin = opts.bin ?? 'claude';
    this.fallback = opts.fallback ?? new HeuristicDirector();
  }

  plan(ir: LoweredSceneIR): DirectorPlan {
    const presetNames = cameraPresetNames();
    const key = planCacheKey(ir, presetNames);
    const cacheFile = resolvePath(this.rootDir, this.cacheDir, `plan-${key}.json`);

    // CACHE HIT: replay the fixed, validated plan from disk (the render never calls the LLM).
    if (existsSync(cacheFile)) {
      try {
        return validatePlan(JSON.parse(readFileSync(cacheFile, 'utf8')));
      } catch {
        // A corrupt cache file → fall through to regenerate.
      }
    }

    // CACHE MISS: call the LLM ONCE, validate, and persist. Any failure → heuristic fallback.
    try {
      const prompt = buildPrompt(ir, presetNames);
      const stdout = execFileSync(
        this.bin,
        // Keyless `claude -p` JSON mode with NO tools/MCP (reference_claude_p_as_llm_backend: cuts
        // per-call tokens) — the director only needs text→JSON, no tools.
        [
          '-p',
          '--output-format', 'json',
          '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
          '--allowedTools', '',
        ],
        { input: prompt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 },
      );
      const plan = validatePlan(extractPlanJson(stdout));
      // Persist the validated plan content-addressed (the deterministic record the render replays).
      mkdirSync(resolvePath(this.rootDir, this.cacheDir), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(plan, null, 2) + '\n', 'utf8');
      return plan;
    } catch (err) {
      // No binary / bad output / non-zero exit → deterministic local fallback (never fail the build).
      // Opt-in diagnostics: set DIRECTOR_DEBUG=1 to see WHY the LLM path fell back (the build still
      // succeeds via the heuristic — this only surfaces the cause for tuning the prompt/parse).
      if (process.env['DIRECTOR_DEBUG']) {
        process.stderr.write(`[director:llm] fell back to heuristic: ${(err as Error)?.message}\n`);
      }
      return this.fallback.plan(ir);
    }
  }
}

/** The known camera preset NAMES (from the DATA table) the LLM may choose among. */
function cameraPresetNames(): string[] {
  return KNOWN_PRESET_NAMES;
}

/**
 * The camera preset names, read ONCE from the same DATA file the camera pass loads. Kept here (not
 * imported from camera.ts, which doesn't export the list) so the LLM prompt + plan validation share
 * the live preset vocabulary. Pure (static file, read at module load).
 */
const KNOWN_PRESET_NAMES: string[] = (() => {
  try {
    const presetsPath = resolvePath(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'library',
      'camera',
      'presets.json',
    );
    const table = JSON.parse(readFileSync(presetsPath, 'utf8')) as { presets: Record<string, unknown> };
    return Object.keys(table.presets);
  } catch {
    return [];
  }
})();

// ---------------------------------------------------------------------------------------------
// Apply a plan to the lowered IR — fold placements + camera into the scenes (author always wins).
// ---------------------------------------------------------------------------------------------

/** Build a static (`a:0`) animated-vec2 position property. */
function staticPosition(pos: Vec2): AnimatedVec2 {
  return { a: 0, k: pos };
}

/**
 * Fold a {@link DirectorPlan} into the lowered IR. For each scene:
 *   • PLACEMENTS — set `transform.position` (fraction → pixels against config) on each planned layer
 *     that has NO explicit position yet (an author-positioned layer WINS); strip the `anchor` hint on
 *     a placed layer so the lite layout pass doesn't re-resolve it.
 *   • CAMERA — set `camera_intent` to the plan's preset, but ONLY if lowering carried no explicit
 *     intent (an author-authored camera WINS). The lite camera pass (P8) then expands the intent.
 * Pure: returns a new IR; does not mutate the input.
 */
export function applyPlan(ir: LoweredSceneIR, plan: DirectorPlan): LoweredSceneIR {
  const byId = new Map(plan.scenes.map((s) => [s.id, s]));
  return {
    ...ir,
    scenes: ir.scenes.map((scene) => {
      const sp = byId.get(scene.id);
      if (!sp) return scene;
      const placeById = new Map(sp.placements.map((p) => [p.id, p]));

      const layers: LoweredLayer[] = scene.layers.map((layer) => {
        const p = placeById.get(layer.id);
        if (!p) return layer;
        // AUTHOR ALWAYS WINS: an explicit position or a non-default (author) anchor is never moved by
        // the director — even if a plan (e.g. the LLM) named it. Leave the layer (and its anchor) for
        // the layout pass to resolve.
        if (!placementIsFree(layer)) return layer;
        const existing: Transform | undefined =
          'transform' in layer ? (layer as { transform?: Transform }).transform : undefined;
        const pos: Vec2 = [p.x * ir.config.w, p.y * ir.config.h];
        const transform: Transform = { ...(existing ?? {}), position: staticPosition(pos) };
        // Strip the (default) anchor so the lite layout pass doesn't re-resolve the placed layer.
        const { anchor: _drop, ...rest } = layer;
        return { ...rest, transform } as LoweredLayer;
      });

      // Camera: fill the scene's intent from the plan only when the author/lowering left none.
      const next: LoweredScene = { ...scene, layers };
      const hasExplicitCamera =
        next.camera !== undefined || next.camera_intent !== undefined;
      if (!hasExplicitCamera && sp.camera !== undefined) {
        next.camera_intent = sp.camera as CameraIntent;
      }
      return next;
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// The pass entry — pick a director, plan, apply.
// ---------------------------------------------------------------------------------------------

/** Which director to use. `heuristic` (default) is pure/local; `llm` is opt-in (claude -p, cached). */
export type DirectorKind = 'heuristic' | 'llm';

/** Options for {@link director}. */
export interface DirectorOptions {
  /** Director impl. Default: "heuristic". */
  kind?: DirectorKind;
  /** Project root + cache dir for the LLM plan cache. */
  rootDir?: string;
  cacheDir?: string;
}

/** Construct the chosen {@link Director}. The `llm` impl falls back to the heuristic internally. */
export function makeDirector(opts: DirectorOptions = {}): Director {
  if (opts.kind === 'llm') {
    return new LlmDirector({
      ...(opts.rootDir ? { rootDir: opts.rootDir } : {}),
      ...(opts.cacheDir ? { cacheDir: opts.cacheDir } : {}),
      fallback: new HeuristicDirector(),
    });
  }
  return new HeuristicDirector();
}

/**
 * P7 — Director. Plan layout + camera with the chosen director, then fold the plan into the lowered
 * IR. Pure for the heuristic; the LLM path is made deterministic by its content-addressed plan cache
 * (the render replays the FIXED plan). Runs BEFORE the lite layout (P6) + camera (P8) passes, which
 * finish resolving any placements/intents the director (and the author) left.
 */
export function director(ir: LoweredSceneIR, opts: DirectorOptions = {}): LoweredSceneIR {
  // The director kind: an explicit option wins, else the story's transient `director` field (carried
  // by lowering), else the default heuristic. Strip the transient field so the validate (V) boundary
  // (a strict Scene-IR schema) doesn't reject it as an unknown key.
  const { director: storyKind, ...rest } = ir;
  const kind: DirectorKind = opts.kind ?? storyKind ?? 'heuristic';
  const d = makeDirector({ ...opts, kind });
  const plan = d.plan(rest as LoweredSceneIR);
  return applyPlan(rest as LoweredSceneIR, plan);
}
