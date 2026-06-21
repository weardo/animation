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

/** Camera *intent* — a named move, not pixels/frames (e.g. "slow_push_in", "hold"). */
export const CameraIntentSchema = z.string().min(1);
export type CameraIntent = z.infer<typeof CameraIntentSchema>;

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
