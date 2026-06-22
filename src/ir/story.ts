// Story IR — semantic, human/LLM-authorable, YAML-authored, Zod-validated. Spec §6.1.
//
// High-level *intent* only: beats, a declared cast, narration, camera intent. No frame numbers,
// no coordinates — those are produced downstream by the lowering/layout/camera passes (Scene IR).
// OTIO-aligned: a beat ≈ a clip on a track.
//
// DOMAIN-AGNOSTIC (ADR-007 decision #3): the front-end specializes in NOTHING. A story declares a
// generic `cast` — named refs/actors that each map to a library entry (+ an optional provider). A
// "character" is just one KIND of cast ref (one whose entry resolves to a rig); it is NOT a
// schema-level entity. There is no `characters`/`character:`/domain vocabulary in this schema — those
// live only in plugins (code) + library (data) + examples (story authoring).
//
// Authorable surface: title, cast, beats (id, say?, show?, action?, camera?, transition?, duration?).
// Fields reserved for later milestones (environment, place) are optional so later passes need no
// schema migration. Audio/TTS is NOT modeled here yet.

import { z } from 'zod';

/** A named palette token reference (resolved later in Scene IR `defs.palette`). */
const PaletteRefSchema = z.string().min(1);

/**
 * A CAST entry: a named, reusable reference an actor/subject in the story binds to. Generic by
 * design (ADR-007) — `ref` is a library `name@version` (resolved to a content hash by P2) and the
 * optional `provider` names which provider plugin interprets it (e.g. a skeletal-rig provider, a
 * procedural-creature provider). "character" is just a cast entry whose ref resolves to a rig; the
 * core schema knows only the generic shape. A `show[].actor` directive binds a layer to a cast key.
 */
export const CastEntrySchema = z
  .object({
    /** Library entry name (optionally `name@version`); resolved to a content hash by P2. */
    ref: z.string().min(1),
    /** Optional provider id override (else derived from the resolved catalog entry). */
    provider: z.string().min(1).optional(),
    /** Optional palette intent (token name). */
    palette: PaletteRefSchema.optional(),
  })
  .strict();
export type CastEntry = z.infer<typeof CastEntrySchema>;

/**
 * A `show` directive: introduce something on screen. Each item declares ONE generic layer kind by
 * which field it sets — `generator` (a procedural world), `shape` (a vector primitive / morph),
 * `asset` (static art), or `actor` (a cast ref bound to a rig/provider layer). Loosely typed by
 * design — the lowering pass interprets it generically (it knows layer KINDS, never a subject domain;
 * ADR-007); the free-form `args` flow straight through and are validated by each family's own Zod.
 */
export const ShowItemSchema = z
  .object({
    /** Generator name to spawn (any registered procedural generator). */
    generator: z.string().min(1).optional(),
    /**
     * A first-class vector SHAPE to show (ADR-003 #1). The value is the `@remotion/shapes` primitive
     * kind (`rect`/`circle`/`ellipse`/`triangle`/`star`/`polygon`/`pie`/`heart`) — OR the sentinel
     * `morph` for a path-morph shape whose geometry comes entirely from `args.morph`. The shape's
     * look (params/fill/stroke/morph/z/scale/rotation/opacity) travels in the item's free-form
     * `args`, interpreted by the lowering pass into a Scene-IR `shape` layer; `as` becomes the layer
     * id and the optional positional `at` (an anchor name) its placement.
     */
    shape: z.string().min(1).optional(),
    /** Static asset to show (a `defs.assets` ref; a background is just a low-z, far-parallax asset). */
    asset: z.string().min(1).optional(),
    /** Reusable clip to place (reserved; later). */
    clip: z.string().min(1).optional(),
    /** A cast key to bring on screen as a rig/provider layer (the generic "actor" binding). */
    actor: z.string().min(1).optional(),
    /** Local handle other beats refer to (e.g. an `action.on` target). */
    as: z.string().min(1).optional(),
    /** Named layout anchor (e.g. "center", "left", "top_right") the lowering pass resolves to a
     *  `transform.position` via the layout pass. Currently used to place `shape` items. */
    at: z.string().min(1).optional(),
    /** Free-form generator/asset/shape arguments, interpreted by the lowering pass. */
    args: z.record(z.unknown()).optional(),
  })
  .strict();
export type ShowItem = z.infer<typeof ShowItemSchema>;

/**
 * An `action` directive: do something to an existing on-screen handle (an earlier `show[].as`).
 * `do` is the target family's own verb/clip name — a thin pointer the lowering pass forwards.
 */
export const ActionItemSchema = z
  .object({
    /** Target handle (an earlier `show[].as`). */
    on: z.string().min(1),
    /** Named action verb the lowering pass maps to layer/clip behavior. */
    do: z.string().min(1),
    /** Optional action arguments. */
    args: z.record(z.unknown()).optional(),
  })
  .strict();
export type ActionItem = z.infer<typeof ActionItemSchema>;

/** Camera *intent* — a named move, not pixels/frames (e.g. "slow_push_in", "hold").
 *  Either a bare preset name (back-compat) or an object carrying the preset + free-form hints
 *  (e.g. amount/target) the camera-director pass interprets. */
export const CameraIntentSchema = z.union([
  z.string().min(1),
  z
    .object({
      /** Named camera move preset (e.g. "slow_push_in", "hold", "pan"). */
      move: z.string().min(1),
      /** Optional intensity hint (0..1+), interpreted by the camera-director pass. */
      amount: z.number().optional(),
      /** Optional free-form camera arguments. */
      args: z.record(z.unknown()).optional(),
    })
    .strict(),
]);
export type CameraIntent = z.infer<typeof CameraIntentSchema>;

/**
 * A duration intent — either a number of seconds (`{ seconds }`) or frames (`{ frames }`).
 * The lowering pass resolves to absolute `duration_frames` using the scene fps. Bare numbers
 * are interpreted as SECONDS (the authoring-friendly unit at the Story-IR altitude).
 */
export const DurationSchema = z.union([
  z.number().positive(),
  z.object({ seconds: z.number().positive() }).strict(),
  z.object({ frames: z.number().int().positive() }).strict(),
]);
export type Duration = z.infer<typeof DurationSchema>;

/**
 * A transition INTO a beat (plays at the boundary from the previous beat to this one).
 * Expressive: `kind` + passthrough params. Lowers to the Scene-IR TransitionSchema and ultimately
 * to `@remotion/transitions` (or SVG-mask / flubber morph / match-cut continuity — spec §11.2).
 */
export const StoryTransitionSchema = z
  .object({
    /** Transition family. `cut` = hard cut (no effect). */
    kind: z.enum([
      'cut',
      'fade',
      'wipe',
      'slide',
      'iris',
      'mask',
      'morph-match',
      'match-cut',
      'camera-continuous',
    ]),
    /** Direction for directional kinds (wipe/slide). */
    dir: z.enum(['left', 'right', 'up', 'down']).optional(),
    /** Transition length in frames (lowering may default this from the StyleKit). */
    duration: z.number().int().positive().optional(),
  })
  .passthrough();
export type StoryTransition = z.infer<typeof StoryTransitionSchema>;

/**
 * A `place` entry — reserved for M2 environment composition (drop a preset/clip onto an anchor).
 * Defined optional/unused in M1 so the schema does not need migration later.
 */
export const PlaceItemSchema = z
  .object({
    actor: z.string().min(1).optional(),
    clip: z.string().min(1).optional(),
    /** Named anchor in the environment to drop onto. */
    at: z.string().min(1).optional(),
    args: z.record(z.unknown()).optional(),
  })
  .strict();
export type PlaceItem = z.infer<typeof PlaceItemSchema>;

/** A single beat. The atomic unit of a story (≈ an OTIO clip on a track). */
export const BeatSchema = z
  .object({
    id: z.string().min(1),
    /** Narration line. Drives the (later) TTS pass; pure intent in M1. */
    say: z.string().optional(),
    /** Things to introduce on screen. */
    show: z.array(ShowItemSchema).optional(),
    /** Things to do to existing on-screen handles. */
    action: z.array(ActionItemSchema).optional(),
    /** Camera intent for this beat. */
    camera: CameraIntentSchema.optional(),
    /**
     * Transition INTO this beat (from the previous beat). Ignored on the first beat (nothing to
     * transition from). Optional + back-compat: omitting it = a hard cut. (Spec §11.2.)
     */
    transition: StoryTransitionSchema.optional(),
    /**
     * Desired on-screen duration of this beat (seconds or frames). Optional: the lowering pass
     * falls back to a default per-beat length when omitted. Drives each scene's `duration_frames`
     * and its `at` offset on the global timeline (sequenced film).
     */
    duration: DurationSchema.optional(),
    // --- Reserved for later milestones (M2 environment composition) ---
    /** Reuse a whole scene-template/environment (reserved; M2). */
    environment: z.string().min(1).optional(),
    /** Place presets/clips onto environment anchors (reserved; M2). */
    place: z.array(PlaceItemSchema).optional(),
  })
  .strict();
export type Beat = z.infer<typeof BeatSchema>;

/**
 * Output format (I1 — author-controlled frame size + fps). The renderer + Scene-IR `config` already
 * support ANY resolution/fps; this lets the STORY choose, so the factory can make vertical shorts,
 * square loops, 4K, 24/60fps — not just 1080p@30 landscape. `aspect` is an ergonomic preset resolved
 * to width×height; explicit `width`/`height` override it; `fps` defaults to 30. Omitted → the
 * lowering default (1920×1080@30). NOTE: the *output codec/container* (alpha/ProRes/GIF) is a separate
 * concern (render-side), not here — this is purely the frame geometry the compiler emits.
 */
export const AspectSchema = z.enum(['16:9', '9:16', '1:1', '4:5', '4:3', '21:9']);
export type Aspect = z.infer<typeof AspectSchema>;

export const FormatSchema = z
  .object({
    /** Ergonomic aspect preset → width×height (1080 short-edge). Overridden by explicit width/height. */
    aspect: AspectSchema.optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    fps: z.number().positive().optional(),
  })
  .strict();
export type Format = z.infer<typeof FormatSchema>;

/** The Story IR root. */
export const StoryIRSchema = z
  .object({
    title: z.string().min(1),
    /** Optional output format (I1): aspect preset or explicit size + fps. Omitted → 1920×1080@30. */
    format: FormatSchema.optional(),
    /** Named cast: generic refs/actors → a library entry (+ optional provider/palette intent). */
    cast: z.record(CastEntrySchema).default({}),
    beats: z.array(BeatSchema).min(1),
  })
  .strict();
export type StoryIR = z.infer<typeof StoryIRSchema>;
