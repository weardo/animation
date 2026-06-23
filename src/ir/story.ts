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
import { PostSchema } from './scene.js';

/** A named palette token reference (resolved later in Scene IR `defs.palette`). */
const PaletteRefSchema = z.string().min(1);

/**
 * An OPTIONAL voice/tone authoring surface for narration (the swappable TTS abstraction, src/cli/
 * narrate.ts). EVERY field is optional + back-compat: a plain string `say` with NO voice still uses
 * the DEFAULT_ENGINE/DEFAULT_VOICE. A `voice` may be declared on a `cast` entry (the actor's standing
 * voice) and/or overridden per beat (`beat.voice` + the shorthand `beat.tone`); the lowering/narrate
 * pass resolves the effective voice = beat override ?? cast voice ?? engine defaults and folds it into
 * the content-addressed cache key, so any change re-synthesizes (golden rule 1: the cached wav is the
 * deterministic record). The fields map 1:1 onto a {@link NarrateRequest}:
 *   • `engine` — the TTS engine id (espeak-ng / coqui / kokoro / chatterbox / parler). Loosely typed
 *     here (a string) so the Story IR does not couple to the engine union in src/cli; the narrate pass
 *     validates it against the real engine list (an unknown engine falls back to the default).
 *   • `voice`  — an engine voice id (an espeak-ng voice, a Coqui/Kokoro speaker, …).
 *   • `tone`   — a free-form tone DESCRIPTION / label (parler's conditioning prompt: "warm, gentle,
 *     empathetic"); other engines ignore it but it still folds into the cache key.
 *   • `exaggeration` / `cfg` — numeric engine params (chatterbox expressiveness / guidance), carried
 *     into the NarrateRequest `style` map.
 *   • `wpm`    — pacing (words-per-minute; espeak-ng).
 */
export const VoiceSchema = z
  .object({
    /** TTS engine id (espeak-ng/coqui/kokoro/chatterbox/parler). Loosely typed; narrate pass validates. */
    engine: z.string().min(1).optional(),
    /** Engine voice id (espeak-ng voice / Coqui or Kokoro speaker). */
    voice: z.string().min(1).optional(),
    /** Free-form tone description / label (parler conditioning prompt; folds into the cache key). */
    tone: z.string().min(1).optional(),
    /** Chatterbox expressiveness (0..~1+). Carried into the NarrateRequest `style`. */
    exaggeration: z.number().optional(),
    /** Chatterbox classifier-free-guidance weight. Carried into the NarrateRequest `style`. */
    cfg: z.number().optional(),
    /** Words-per-minute pacing (espeak-ng). */
    wpm: z.number().positive().optional(),
  })
  .strict();
export type Voice = z.infer<typeof VoiceSchema>;

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
    /**
     * Optional NARRATION VOICE for this cast member — the actor's standing voice/tone used when a beat
     * narrated for/by this actor has no per-beat override. All fields optional + back-compat (a string
     * `say` with no voice anywhere still uses the engine defaults). The narrate pass resolves the
     * effective voice = beat override ?? cast voice ?? defaults. (See {@link VoiceSchema}.)
     */
    voice: VoiceSchema.optional(),
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
    /**
     * A first-class TEXT/TYPOGRAPHY layer to show (the generic `text` core layer kind — every video
     * tool has text). The value is the literal text CONTENT to render; its look (font/size/weight/
     * color/align/box/lineHeight/tracking) and kinetic `anim` preset travel in the item's free-form
     * `args`, interpreted by the lowering pass into a Scene-IR `text` layer. `as` becomes the layer id
     * and the optional positional `at` (an anchor name) its placement.
     */
    text: z.string().optional(),
    /** Static asset to show (a `defs.assets` ref; a background is just a low-z, far-parallax asset). */
    asset: z.string().min(1).optional(),
    /**
     * A reusable CLIP (nested pre-composition) to place — a library `name@version` whose def is
     * resolved + deduped into `defs.clips` and instantiated as a `clip` layer (M2 nested composition,
     * mirrors `shape`/`text`). The clip's EXPOSED params are overridden via the item's `args` (the AE
     * Essential-Graphics / .mogrt model); `args` may also carry the group `transform` (z/scale/
     * rotation/opacity), `parallax`, and `effects[]` that affect the WHOLE unit. `as` becomes the
     * clip-layer id (which NAMESPACES the clip's internals + seeds its generators per instance), the
     * optional `at` (an anchor) its placement, and the optional `from` its local start frame.
     */
    clip: z.string().min(1).optional(),
    /** Local start frame within the scene for a `clip` instance (Remotion `<Sequence from>`). */
    from: z.number().int().optional(),
    /**
     * A FOOTAGE layer (M2 compositing): play time-based EXTERNAL media — a `video` or `lottie`
     * `defs.assets` ref, frame-seeked by Remotion (deterministic). The value is the asset ref; its
     * look (`from`/`playbackRate`/`loop`/`fit`/`parallax`/transform/effects) travels in `args`,
     * interpreted by the lowering pass into a Scene-IR `footage` layer. `as` becomes the layer id and
     * the optional `at` its placement. (Mirrors `asset`/`clip`.)
     */
    footage: z.string().min(1).optional(),
    /** A cast key to bring on screen as a rig/provider layer (the generic "actor" binding). */
    actor: z.string().min(1).optional(),
    /** Local handle other beats refer to (e.g. an `action.on` target). */
    as: z.string().min(1).optional(),
    /** Named layout anchor (e.g. "center", "left", "top_right") the lowering pass resolves to a
     *  `transform.position` via the layout pass. Currently used to place `shape` items. */
    at: z.string().min(1).optional(),
    /**
     * A SOUND EFFECT to play at THIS element's entrance (A2, spec §12). The value is a built-in sfx
     * NAME (tick/pop/whoosh/ding/thud/click — synthesized OFFLINE by `ffmpeg` into the shared
     * `library/sfx/` cache, golden rule 2). The sfx pass emits a `kind:"sfx"` `audio[]` cue anchored at
     * the SCENE START (the element's on-screen entrance frame). Deterministic: a fixed recipe → a fixed
     * cached wav → a byte-identical audio stream. Omitted → no effect for this element.
     */
    sfx: z.string().min(1).optional(),
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

/**
 * Camera *intent* (ADR-008 I4). One of:
 *   • a bare preset NAME (e.g. "slow_push_in", "hold") — expanded by the camera pass from the DATA
 *     recipe table (library/camera/presets.json), not a hardcoded core recipe;
 *   • an object `{ move, amount?, args? }` — a named preset + free-form hints; OR
 *   • an object carrying ARBITRARY explicit keyframes `{ position?, zoom? }` (`{a,k}` channels) that
 *     pass straight through to the Scene-IR camera unchanged — so a front-end can author any move, not
 *     just a named preset. When explicit channels are present, they win over `move`.
 *
 * The keyframe channels are loosely typed here (`z.unknown`-friendly via passthrough) so the Story-IR
 * layer needs no `{a,k}` schema; the camera pass shapes them and the strict Scene-IR boundary (V)
 * validates the final `camera`.
 */
export const CameraIntentSchema = z.union([
  z.string().min(1),
  z
    .object({
      /** Named camera move preset (e.g. "slow_push_in", "hold", "pan"). Optional if keyframes given. */
      move: z.string().min(1).optional(),
      /** Optional intensity hint (0..1+), interpreted by the camera-director pass. */
      amount: z.number().optional(),
      /** ARBITRARY explicit camera position keyframes (`{a,k}` vec2). Passed through verbatim. */
      position: z.unknown().optional(),
      /** ARBITRARY explicit camera zoom keyframes (`{a,k}` number). Passed through verbatim. */
      zoom: z.unknown().optional(),
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

/**
 * A beat-level SOUND-EFFECT cue (A2, spec §12): a built-in sfx `name` (tick/pop/whoosh/ding/thud/
 * click) anchored at an event frame. `at` is the OFFSET (in frames, from the beat's scene start) at
 * which the cue fires — omitted → the beat's opening (frame 0 of the scene). Use this for beat-level
 * accents (a transition swoosh, an impact) that are not tied to a single `show[]` element's entrance
 * (which carries its own `sfx`). Synthesized OFFLINE (golden rule 2), played via Remotion <Audio>.
 */
export const BeatSfxSchema = z
  .object({
    /** Built-in sfx name (tick/pop/whoosh/ding/thud/click). */
    name: z.string().min(1),
    /** Frame offset from the beat's scene start at which the cue fires (default 0). */
    at: z.number().int().nonnegative().optional(),
  })
  .strict();
export type BeatSfx = z.infer<typeof BeatSfxSchema>;

/** A single beat. The atomic unit of a story (≈ an OTIO clip on a track). */
export const BeatSchema = z
  .object({
    id: z.string().min(1),
    /** Narration line. Drives the TTS pass (synthesized OFFLINE → a cached, content-addressed wav). */
    say: z.string().optional(),
    /**
     * Optional per-beat VOICE OVERRIDE for this beat's `say` (the most specific voice authoring level).
     * Overrides the speaking cast member's standing `cast[].voice`, which overrides the engine defaults.
     * All fields optional + back-compat. (See {@link VoiceSchema}.)
     */
    voice: VoiceSchema.optional(),
    /**
     * Shorthand for a per-beat TONE override — `tone: "warm, gentle"` is sugar for `voice: { tone: … }`.
     * Merged into the resolved voice (an explicit `voice.tone` wins if both are set). Lets a beat tweak
     * just the delivery without restating the whole voice block. (See {@link VoiceSchema}.)
     */
    tone: z.string().min(1).optional(),
    /**
     * Beat-level SOUND-EFFECT cues (A2): accents anchored at event frames within the beat (a swoosh, an
     * impact). A bare string is shorthand for `{ name, at: 0 }` (fire at the beat opening). Each lowers
     * to a `kind:"sfx"` `audio[]` cue. (Per-element entrance sounds use `show[].sfx` instead.)
     */
    sfx: z.array(z.union([z.string().min(1), BeatSfxSchema])).optional(),
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
    /**
     * COLOR-SCRIPT (spec §11.4): the beat's emotional MOOD — a named `palette` library entry that
     * points to a token set (e.g. "warm", "cold", "hopeful"). The lowering pass resolves it to tokens
     * that OVERRIDE the stylekit palette for this beat's scene; it diffs them vs the base and carries
     * the diff as the Scene-IR `scene.palette`. Across a transition the entering scene's palette
     * interpolates from the previous scene's in OKLab (culori) so a mood change reads as a smooth
     * global shift — the arc across the whole video (warm intro → cold problem → hopeful resolution).
     */
    mood: PaletteRefSchema.optional(),
    /**
     * Inline palette OVERRIDE for this beat (token name → color), merged over the stylekit base AND
     * over any `mood` palette (so `palette` is the most specific). A beat may set `mood` (a named arc
     * point), `palette` (ad-hoc token tweaks), or both. (Spec §11.4.)
     */
    palette: z.record(z.string().min(1)).optional(),
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

/**
 * A story-level MUSIC BED (A3, spec §12): a single track played UNDER the whole video, LOOPED to fill
 * the timeline and DUCKED (volume dipped) while narration is speaking. Two authorings:
 *   • a bare string — a built-in synthesized bed NAME (e.g. "calm", "drone", "uplift" — generated
 *     OFFLINE by ffmpeg into the shared `library/music/` cache, golden rule 2) or an `asset://`/library
 *     wav ref the project vendors;
 *   • an object `{ ref, gain?, duck?, fade? }` — the same ref plus mix controls: `gain` (the bed's base
 *     volume 0..1, default 0.5), `duck` (the reduced volume 0..1 while narration is active, default
 *     0.18), and `fade` (frames of linear duck ramp in/out around each narration cue, default 8).
 * The music pass emits ONE `kind:"music"` `audio[]` cue spanning the whole timeline (at:0, the full
 * `duration_frames`) carrying these controls; the compositor plays it via Remotion `<Audio loop>` with
 * a per-frame `volume` fn that dips to `duck` while any narration cue overlaps the frame. Deterministic
 * (a fixed recipe → a fixed wav; the volume fn is a pure function of frame; golden rule 1).
 */
export const MusicSchema = z.union([
  z.string().min(1),
  z
    .object({
      /** Built-in bed NAME (calm/drone/uplift) or an `asset://`/library wav ref. */
      ref: z.string().min(1),
      /** Base bed volume (0..1) when no narration is speaking. Default 0.5. */
      gain: z.number().min(0).max(1).optional(),
      /** Reduced bed volume (0..1) while a narration cue is active (ducking). Default 0.18. */
      duck: z.number().min(0).max(1).optional(),
      /** Linear duck ramp length (frames) on each side of a narration cue. Default 8. */
      fade: z.number().int().nonnegative().optional(),
    })
    .strict(),
]);
export type Music = z.infer<typeof MusicSchema>;

/** The Story IR root. */
export const StoryIRSchema = z
  .object({
    title: z.string().min(1),
    /**
     * Optional story-level MUSIC BED (A3): a looping track played under the whole video, auto-ducked
     * while narration speaks. A bare string (a built-in synth bed name / asset ref) or `{ ref, gain?,
     * duck?, fade? }`. Omitted → no music. Synthesized OFFLINE; runs under the `--no-audio` /
     * `--no-music` switches.
     */
    music: MusicSchema.optional(),
    /** Optional output format (I1): aspect preset or explicit size + fps. Omitted → 1920×1080@30. */
    format: FormatSchema.optional(),
    /**
     * Optional STYLE selection (ADR-008 I2/I3): a `stylekit` library entry name (e.g. "kurzgesagt",
     * "plain") that picks the whole house style — palette, easings, motion/liveness, shading, and the
     * quality-FLOOR toggles. Omitted → "kurzgesagt" (the default look). Selecting "plain" turns the
     * floor OFF for a flat/technical result. The style is DATA (library/stylekits/*.json), not core.
     */
    style: z.string().min(1).optional(),
    /**
     * Optional film-level POST grade (M8a): a final, COMPOSITION-LEVEL effect stack applied over the
     * WHOLE rendered frame (color_grade / vignette / grain / …), reusing the SAME core-effects ops the
     * per-layer `effects[]` use. Each entry is loosely typed `{ kind, ...params }` and validated at
     * render by the effect's own Zod (via the engine `effects` registry). Omitted → no grade (a strict
     * no-op; scenes without `post` render byte-identically to before). Carried verbatim by the lowering
     * pass into Scene IR `post[]`. Pure CSS/SVG filters → byte-deterministic on the CPU raster.
     */
    post: z.array(PostSchema).optional(),
    /** Named cast: generic refs/actors → a library entry (+ optional provider/palette intent). */
    cast: z.record(CastEntrySchema).default({}),
    beats: z.array(BeatSchema).min(1),
  })
  .strict();
export type StoryIR = z.infer<typeof StoryIRSchema>;
