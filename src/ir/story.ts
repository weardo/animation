// Story IR — semantic, human/LLM-authorable, YAML-authored, Zod-validated. Spec §6.1.
//
// High-level *intent* only: beats, characters, narration, camera intent. No frame numbers,
// no coordinates — those are produced downstream by the lowering/layout/camera passes (Scene IR).
// OTIO-aligned: a beat ≈ a clip on a track.
//
// M1 subset: title, characters, beats (id, say?, show?, action?, camera?).
// Fields the spec mentions for later milestones (environment, place) are RESERVED as optional so
// later passes need no schema migration. Audio/TTS is NOT modeled here in M1.

import { z } from 'zod';

/** A named palette token reference (resolved later in Scene IR `defs.palette`). */
const PaletteRefSchema = z.string().min(1);

/** A character declaration: which rig art it uses + an optional palette intent. */
export const CharacterSchema = z
  .object({
    /** Library rig name (optionally name@version); resolved to a content hash by P2. */
    rig: z.string().min(1),
    /** Optional palette intent (token name). */
    palette: PaletteRefSchema.optional(),
  })
  .strict();
export type Character = z.infer<typeof CharacterSchema>;

/**
 * A `show` directive: introduce something on screen. M1 supports a generator spawn
 * (e.g. `{ generator: "bead-string", as: "neuron_chain" }`). Loosely typed by design — the
 * lowering pass interprets it; reserved keys (asset/clip/character) are tolerated for later.
 */
export const ShowItemSchema = z
  .object({
    /** Generator name to spawn (M1). */
    generator: z.string().min(1).optional(),
    /** Static asset to show (reserved; later). */
    asset: z.string().min(1).optional(),
    /** Reusable clip to place (reserved; later). */
    clip: z.string().min(1).optional(),
    /** A character to bring on (reserved; later). */
    character: z.string().min(1).optional(),
    /** Local handle other beats refer to (e.g. an `action.on` target). */
    as: z.string().min(1).optional(),
    /** Free-form generator/asset arguments, interpreted by the lowering pass. */
    args: z.record(z.unknown()).optional(),
  })
  .strict();
export type ShowItem = z.infer<typeof ShowItemSchema>;

/**
 * An `action` directive: do something to an existing on-screen handle.
 * (e.g. `{ on: "neuron_chain", do: "pulse_travel" }`).
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
    character: z.string().min(1).optional(),
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

/** The Story IR root. */
export const StoryIRSchema = z
  .object({
    title: z.string().min(1),
    /** Named characters → their rig + palette intent. */
    characters: z.record(CharacterSchema).default({}),
    beats: z.array(BeatSchema).min(1),
  })
  .strict();
export type StoryIR = z.infer<typeof StoryIRSchema>;
