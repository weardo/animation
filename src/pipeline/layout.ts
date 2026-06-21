// P6 — Layout (lite). Spec §5, §14.3, §15 (M1: "ship a dumb deterministic layout / named anchor
// slots"). NOT the smart no-overlap solver (that is the later P6). This pass only:
//   • resolves each layer's named `anchor` (e.g. "center", "left") to an absolute `transform.position`
//     scaled to the scene's `config` (w×h), and
//   • strips the `anchor` annotation so the output conforms to the strict Scene-IR layer schema.
//
// PURE + DETERMINISTIC (CLAUDE.md golden rule 1): output is a function of the lowered IR alone —
// no wall-clock, no RNG. Anchors map to a fixed 3×3 grid of fractional positions, identical on
// every run, so the resolved positions are byte-stable.
//
// It does NOT touch the camera (that is P8) and leaves layers without an `anchor` exactly as
// lowering produced them (e.g. a parallax background needs no explicit position).

import type { SceneConfig, Transform, AnimatedVec2, Vec2 } from '../ir/index.js';
import type {
  LoweredSceneIR,
  LoweredScene,
  LoweredLayer,
} from './contract.js';

/** Pass identity for cache keys / provenance (spec §5: per-stage versioning). */
export const LAYOUT_PASS = 'layout@0.1' as const;

// ---------------------------------------------------------------------------------------------
// Anchor table — a fixed 3×3 grid (+ a few named conveniences), expressed as fractions of the
// frame. The lite layout's entire "intelligence" is this lookup; a smarter P6 replaces it later.
// Fractions, NOT pixels, so the same anchor scales to any `config.w`/`config.h` deterministically.
// ---------------------------------------------------------------------------------------------

/** A point in fractional frame coordinates: [fx, fy] with 0 = top/left, 1 = bottom/right. */
type FracPoint = readonly [number, number];

/**
 * Named anchors → fractional position. The grid covers the common Kurzgesagt staging slots
 * (subject centered, narrator off to one side, props on the thirds). Names are stable so the
 * lower-author and scene-templates can rely on them.
 */
export const ANCHORS = {
  center: [0.5, 0.5],
  top: [0.5, 0.25],
  bottom: [0.5, 0.75],
  left: [0.25, 0.5],
  right: [0.75, 0.5],
  top_left: [0.25, 0.25],
  top_right: [0.75, 0.25],
  bottom_left: [0.25, 0.75],
  bottom_right: [0.75, 0.75],
  // rule-of-thirds verticals at mid height (common subject placements)
  left_third: [1 / 3, 0.5],
  right_third: [2 / 3, 0.5],
  // staging conveniences
  stage_left: [0.2, 0.6],
  stage_right: [0.8, 0.6],
  bench: [0.5, 0.62],
  screen: [0.5, 0.4],
} as const satisfies Record<string, FracPoint>;

/** A known anchor name (key of {@link ANCHORS}). */
export type AnchorName = keyof typeof ANCHORS;

/** True if `name` is a known layout anchor. */
export function isAnchorName(name: string): name is AnchorName {
  return Object.prototype.hasOwnProperty.call(ANCHORS, name);
}

/**
 * Resolve a named anchor to an absolute pixel position for a given config. Throws on an unknown
 * anchor so a typo is a hard error (spec: no silent fallbacks).
 */
export function resolveAnchor(name: string, config: SceneConfig): Vec2 {
  if (!isAnchorName(name)) {
    throw new Error(
      `unknown layout anchor "${name}". Known anchors: ${Object.keys(ANCHORS).join(', ')}.`
    );
  }
  const [fx, fy] = ANCHORS[name];
  return [fx * config.w, fy * config.h];
}

// ---------------------------------------------------------------------------------------------
// Layer layout
// ---------------------------------------------------------------------------------------------

/** Build a static (`a:0`) animated-vec2 position property. */
function staticPosition(pos: Vec2): AnimatedVec2 {
  return { a: 0, k: pos };
}

/**
 * Resolve one lowered layer's `anchor` into `transform.position` and return a clean Scene-IR layer
 * (no `anchor` key). If the layer already has an explicit `transform.position`, the anchor does not
 * override it (an explicitly-positioned layer wins — lowering was specific on purpose). If there is
 * no anchor and no transform, the layer is returned unchanged.
 */
function layoutLayer(layer: LoweredLayer, config: SceneConfig): LoweredLayer {
  const { anchor, ...rest } = layer;
  // No anchor → nothing for the lite pass to do.
  if (anchor === undefined) return rest as LoweredLayer;

  // 'shape' layers in the discriminated union also accept a transform; every M1 layer type does.
  const existing: Transform | undefined =
    'transform' in rest ? (rest.transform as Transform | undefined) : undefined;

  // Explicit position already set by lowering → respect it, just drop the anchor.
  if (existing?.position !== undefined) {
    return rest as LoweredLayer;
  }

  const position = staticPosition(resolveAnchor(anchor, config));
  const transform: Transform = { ...(existing ?? {}), position };
  return { ...rest, transform } as LoweredLayer;
}

/** Lay out every layer in a scene. */
function layoutScene(scene: LoweredScene, config: SceneConfig): LoweredScene {
  return {
    ...scene,
    layers: scene.layers.map((l) => layoutLayer(l, config)),
  };
}

/**
 * P6 (lite). Resolve named anchors → positions across the whole lowered Scene IR. Pure: returns a
 * new IR; does not mutate the input. The result is still a {@link LoweredSceneIR} (it may still
 * carry `camera_intent` on scenes) — P8 runs next; the final Zod boundary is `validate.ts`.
 */
export function layout(ir: LoweredSceneIR): LoweredSceneIR {
  return {
    ...ir,
    scenes: ir.scenes.map((s) => layoutScene(s, ir.config)),
  };
}
