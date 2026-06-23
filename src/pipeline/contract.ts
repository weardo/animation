// Pipeline contract — the shared seam between the front-end passes (P0 parse, P5 lower; owned by
// another module) and the lite back-end passes (P6 layout, P8 camera) implemented here. Spec §5, §6.
//
// WHY THIS FILE EXISTS
// The pipeline is `parse → lower → layout → camera → validate`. `layout` (P6) and `camera` (P8)
// run AFTER `lower` (P5) but BEFORE the final Zod Scene-IR boundary (V). The thing they consume is
// therefore NOT yet a fully-valid `SceneIR`: it is the *lowered* form, which still carries the two
// semantic hints those passes resolve —
//   • per-layer `anchor`  (a named slot like "center"/"left") that P6 resolves to `transform.position`;
//   • per-scene `camera_intent` (a keyword like "slow_push_in") that P8 expands to concrete camera keyframes.
// Once both passes run, the result is a real `SceneIR` (anchors resolved to positions, camera_intent
// expanded to `camera`), which `validate.ts` checks at the boundary.
//
// This module is the single source of the intermediate shape so the lower-author and the
// layout/camera-author agree by type, not by convention. It only re-uses the IR's own types
// (CLAUDE.md golden rule 3 / golden rule 4: validate at every boundary, IR is the contract).

import type {
  SceneIR,
  Scene,
  Layer,
  CameraIntent,
  StoryIR,
} from '../ir/index.js';

// ---------------------------------------------------------------------------------------------
// Lowered Scene-IR — the P5 output / P6+P8 input. Structurally a Scene IR with two differences:
//   1. layers may carry an optional `anchor` (resolved away by P6 into `transform.position`);
//   2. scenes carry `camera_intent` instead of a concrete `camera` (expanded by P8 into `camera`).
// Everything else is identical to the final Scene IR, so lowering can build the bulk of the IR
// directly and the lite passes only fill the two gaps.
// ---------------------------------------------------------------------------------------------

/**
 * A layer in the lowered form. It is a Scene-IR {@link Layer} optionally annotated with a named
 * `anchor`. P6 (layout) reads `anchor`, writes `transform.position`, and strips `anchor` so the
 * result conforms to the strict Scene-IR layer schema.
 */
export type LoweredLayer = Layer & {
  /**
   * A named layout anchor (e.g. "center", "left", "right_third"). Resolved to an absolute
   * `transform.position` by P6. If absent, the layer keeps whatever transform lowering gave it
   * (or none — backgrounds typically need no position).
   */
  anchor?: string;
};

/**
 * A scene in the lowered form. It is a Scene-IR {@link Scene} whose concrete `camera` is OPTIONAL
 * (P8 fills it when absent) and which may carry a `camera_intent` keyword (from the beat's `camera`
 * field) the camera director expands. Its `layers` may carry `anchor` hints. All other Scene fields
 * pass straight through.
 *
 * NOTE: a fully-baked Scene-IR `Scene` (camera already concrete, layers already positioned — as the
 * current lowering emits) is also a valid `LoweredScene`: the lite passes detect the concrete forms
 * and pass them through unchanged (they are idempotent refinements, not rewrites).
 */
export type LoweredScene = Omit<Scene, 'camera' | 'layers'> & {
  /** Concrete camera (present when lowering already produced it; absent → P8 fills from intent). */
  camera?: Scene['camera'];
  /** The beat's camera intent keyword (e.g. "slow_push_in"). Expanded to `camera` by P8. */
  camera_intent?: CameraIntent;
  /** Lowered layers (may carry `anchor`). */
  layers: LoweredLayer[];
};

/**
 * The whole lowered Scene IR: a Scene IR whose `scenes` are {@link LoweredScene}s. `defs`, `config`,
 * `audio`, `provenance`, etc. are already in final form — lowering owns them. The lite passes only
 * transform `scenes`.
 */
export type LoweredSceneIR = Omit<SceneIR, 'scenes'> & {
  scenes: LoweredScene[];
  /**
   * TRANSIENT director selection (M5) carried from the Story IR through lowering so the back-end's
   * director pass (P7) knows which impl to run ("heuristic" default / "llm" opt-in). NOT part of the
   * final Scene IR — the validate (V) boundary strips it. Omitted → the default heuristic director.
   */
  director?: 'heuristic' | 'llm';
};

// ---------------------------------------------------------------------------------------------
// Front-end function contracts (implemented by parse.ts / lower.ts). These mirror the real
// signatures (`parseStory(yamlText)`, `lowerStory(story, opts)`) so the composition can accept an
// injected front-end (tests / the CLI) without importing the concrete modules.
// ---------------------------------------------------------------------------------------------

/** P0 — parse + validate YAML script text into a Story IR. Pure given the text (no file I/O). */
export type ParseFn = (yamlText: string) => StoryIR;

/**
 * P5 — lower a Story IR into a Scene IR. The current lowering returns a fully-baked Scene IR; the
 * return type is widened to {@link LoweredSceneIR} so an alternate lowering MAY instead emit anchors
 * / camera intent for the lite passes to resolve. (Every `SceneIR` is a valid `LoweredSceneIR`.)
 *
 * Lowering-specific options (library facade, duration override) are bound by the caller before
 * injection, so the composition only ever invokes `lower(story)`.
 */
export type LowerFn = (story: StoryIR) => LoweredSceneIR;

/** The front-end the composition needs: the parse (P0) + lower (P5) functions. */
export interface Frontend {
  parse: ParseFn;
  lower: LowerFn;
}
