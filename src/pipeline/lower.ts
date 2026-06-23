// Pipeline pass P5 — Lowering: Story IR → Scene IR. Spec §5, §6.2. ADR-007 (domain-agnostic compiler).
//
// A PURE function: `(StoryIR, opts?) → SceneIR`. Seeded RNG only (seeds derived from the story
// hash via P0's `deriveSeed`), no wall-clock, no Math.random, no I/O. It turns each semantic beat
// into a concrete scene of layers + keyframes + a camera intent, drawing all motion/look constants
// from the StyleKit so quality is the floor (spec §9), and emitting easing *refs* (names into
// `defs.easings`) so no segment is ever accidentally linear (spec §6.2/§9).
//
// DOMAIN-AGNOSTIC (ADR-007 decision #1): the pass knows only GENERIC layer KINDS — it does NOT know
// any specific generator, rig, or subject domain. A scene's layers are built ONLY
// from what the beat DECLARES in `show[]` (each item → an asset / generator / shape / rig layer,
// generically) plus generic structural concerns (timeline `at`/`duration`, transitions, camera
// intent, layout anchors). Nothing is force-injected: a background, a generator, or a rig appears
// in a scene if and only if the story declares it. Default per-scene clip/duration are GENERIC
// (no domain names). Each `show[]` item's free-form `args` flow straight through to the IR layer and
// are validated by that family's own Zod at render time (CLAUDE.md rule 5 — params loose at the IR
// boundary; "families are sockets, libraries are plugs").
//
// Library resolution: if a `Library` (P2 facade) is supplied, asset/rig defs are filled from the
// resolved catalog entries (name@version → uri + provider). Without one, the pass falls back to
// deterministic synthetic `defs` so it stays a pure, runnable function on its own. Either way the
// output validates against the Scene-IR Zod schema.

import {
  type AssetLayer,
  type RigLayer,
  type GeneratorLayer,
  type ShapeLayer,
  type TextLayer,
  type ClipLayer,
  type FootageLayer,
  type BlendMode,
  type Matte,
  type ClipDef,
  type Effect,
  type RigClip,
  type Transform,
  type AssetDef,
  type RigDef,
  type Palette,
  type Easings,
  type EasingDef,
  type StoryIR,
  type Format,
  type Beat,
  type ShowItem,
  type ActionItem,
  type CastEntry,
  type CameraIntent,
  type Transition,
  type Duration,
  type StyleKit,
} from '../ir/index.js';
import type { LoweredLayer } from './contract.js';
import { NEUTRAL_STYLEKIT } from '../render/stylekit.js';
import { storyHash, deriveSeed } from './parse.js';
import type { LoweredSceneIR, LoweredScene } from './contract.js';
import { resolveScenePalette, paletteDiff, interpolatePalettes } from './color-script.js';

/** This pass's id + version — folded into cache keys / provenance (spec §5). */
export const PASS_ID = 'lower';
export const PASS_VERSION = '2.6';

/**
 * The default render config: a 1920×1080, 30fps film. Generic — no domain assumptions. A scene's
 * length comes from its beat's `duration` (or the generic per-beat default below); the film's total
 * `duration_frames` is the sum of scene lengths minus transition overlaps.
 */
export const RENDER_CONFIG = {
  w: 1920,
  h: 1080,
  fps: 30,
} as const;

/** Aspect preset → [width, height] at a 1080 short-edge. Author convenience (I1); explicit w/h wins. */
const ASPECT_DIMS: Record<string, readonly [number, number]> = {
  '16:9': [1920, 1080],
  '9:16': [1080, 1920],
  '1:1': [1080, 1080],
  '4:5': [1080, 1350],
  '4:3': [1440, 1080],
  '21:9': [2560, 1080],
};

/**
 * I1 — resolve the output config (frame size + fps) from the story's `format`, then a LowerOptions
 * override (CLI), over the RENDER_CONFIG defaults. Aspect preset sets width×height; explicit
 * width/height override the preset; fps defaults to 30. Pure — no domain assumptions, no demo baked in.
 */
function resolveConfig(format: Format | undefined, override: Format | undefined): { w: number; h: number; fps: number } {
  const f: Format = { ...(format ?? {}), ...(override ?? {}) };
  let w: number = RENDER_CONFIG.w;
  let h: number = RENDER_CONFIG.h;
  if (f.aspect && ASPECT_DIMS[f.aspect]) [w, h] = ASPECT_DIMS[f.aspect] as [number, number];
  if (typeof f.width === 'number') w = f.width;
  if (typeof f.height === 'number') h = f.height;
  const fps = typeof f.fps === 'number' ? f.fps : RENDER_CONFIG.fps;
  return { w, h, fps };
}

/**
 * Default per-beat scene length when a beat declares no `duration`. Expressed in SECONDS and
 * resolved to frames against the scene fps so it scales with the config. Generic — no domain names.
 */
export const DEFAULT_BEAT_SECONDS = 4 as const;

/**
 * Default transition length (frames) used when a beat carries a `transition` with no explicit
 * `duration`. A hard `cut` is zero-length (no overlap). The one StyleKit-adjacent tunable so every
 * defaulted transition reads the same length. (Spec §11.2.)
 */
export const DEFAULT_TRANSITION_FRAMES = 15 as const;

/**
 * Generic default rig animation/clip. When a beat brings a rig on screen but declares NO `action`
 * driving it, the pass loops this single clip so the rig is alive (a looping idle). It is a GENERIC
 * clip name (no domain anim like "throw"); a richer rig declares its own clips and the story's
 * `action[]` selects/sequences them. Conventionally a rig's library manifest lists `idle` first.
 */
export const DEFAULT_RIG_CLIP = 'idle' as const;

/**
 * The synthetic provider id stamped on a rig def ONLY on the standalone (no-Library) fallback path,
 * where no catalog entry exists to name the real provider. It is a GENERIC placeholder — core names
 * no specific provider plugin (ADR-007). The real (library) path always carries the resolved
 * catalog entry's own `provider`, so this value never reaches a real render.
 */
export const DEFAULT_RIG_PROVIDER = 'rig' as const;

/**
 * The DEFAULT text font — a VENDORED LOCAL font (no CDN, deterministic + offline). It is DATA, not a
 * hardcoded style VALUE: the family NAME the renderer registers via @font-face, and the on-disk FILE
 * URI (`asset://fonts/…`) the renderer loads. Embedding the URI in the text layer means the project
 * bundler's generic `asset://` vendoring copies the font into the self-contained bundle automatically.
 * A story may override the family via `args.font` (and supply its own `args.fontUri`).
 */
export const DEFAULT_TEXT_FONT = 'DejaVu Sans' as const;
export const DEFAULT_TEXT_FONT_URI = 'asset://fonts/DejaVuSans.ttf' as const;

// --- beat duration + transition resolution ----------------------------------------------------

/**
 * Resolve a beat's `duration` intent into an absolute frame count. The Story IR duration is one of:
 *   • a bare number          → SECONDS (the authoring-friendly Story-IR unit),
 *   • `{ seconds }`          → SECONDS,
 *   • `{ frames }`           → already frames.
 * Seconds are converted with the scene `fps` and rounded to the nearest whole frame (deterministic).
 * Returns `undefined` when the beat declares no duration, so the caller can apply its default.
 */
function resolveBeatFrames(
  duration: Duration | undefined,
  fps: number
): number | undefined {
  if (duration === undefined) return undefined;
  if (typeof duration === 'number') return Math.max(1, Math.round(duration * fps));
  if ('frames' in duration) return duration.frames;
  return Math.max(1, Math.round(duration.seconds * fps));
}

/**
 * Lower a beat's Story-IR `transition` into a Scene-IR `transition_in`, defaulting the `duration`
 * (frames) when the author omitted it. A hard `cut` stays zero-overlap (no `duration`). Returns
 * `undefined` when the beat has no transition (a plain hard cut at the boundary). Pure structural
 * copy — passthrough fields (dir, from/to, match) carry through unchanged (spec §11.2).
 */
function resolveTransitionIn(beat: Beat): Transition | undefined {
  const t = beat.transition;
  if (!t) return undefined;
  if (t.kind === 'cut') {
    // A hard cut is a zero-length boundary; drop any duration so it never overlaps.
    const { duration: _drop, ...rest } = t as Transition & { duration?: number };
    return rest as Transition;
  }
  if (t.duration === undefined) {
    return { ...t, duration: DEFAULT_TRANSITION_FRAMES } as Transition;
  }
  return t as Transition;
}

/**
 * The overlap (in frames) a scene's leading transition consumes from the PREVIOUS scene's tail.
 * `@remotion/transitions` plays a transition by overlapping the two adjacent scenes, so the global
 * timeline shortens by this amount at every transitioned boundary. A `cut` (or no transition) is
 * zero. The first scene never overlaps (nothing precedes it) — the caller guards that.
 */
function overlapFrames(transitionIn: Transition | undefined): number {
  if (!transitionIn) return 0;
  if (transitionIn.kind === 'cut') return 0;
  return transitionIn.duration ?? DEFAULT_TRANSITION_FRAMES;
}

// --- camera intent extraction ------------------------------------------------------------------

/**
 * Extract a beat's camera INTENT (a keyword like "slow_push_in", or `{ move, amount, ... }`) for the
 * lite camera-director pass (P8) to expand into concrete keyframes. Lowering deliberately emits the
 * intent rather than baking camera here, so each beat's camera move is resolved per-scene by P8
 * (spec §5/§8). `undefined` → P8 applies its DEFAULT_INTENT ("hold").
 */
function cameraIntentForBeat(beat: Beat): CameraIntent | undefined {
  return beat.camera;
}

/** Minimal structural view of the Library facade this pass needs (kept loose to avoid coupling). */
export interface LibraryLike {
  toAssetDef(ref: string): AssetDef;
  toRigDef(ref: string): RigDef;
  /** Resolve a `stylekit` library entry to a validated StyleKit (ADR-008 I2). */
  toStyleKit?(ref: string): StyleKit;
  /** Resolve a `clip` library entry to a validated ClipDef (M2 nested composition). */
  toClip?(ref: string): ClipDef;
  /** Resolve a named `palette` library entry to a token map (color-script, spec §11.4). */
  toPalette?(ref: string): Palette;
  /**
   * Expand a `show[].generator` value (ADR-004 §2): a `generator-preset` ref (e.g. `"starfield"`) →
   * its locked `{ gen, params }` (preset params are defaults; the layer's own args win), or a bare
   * implementation name passed straight through. Used by {@link buildGeneratorLayer} so a story may
   * name a PRESET where a generator goes. Optional — without it the gen name passes through unchanged.
   */
  expandGeneratorRef?(genRef: string, layerParams?: Record<string, unknown>): { gen: string; params: Record<string, unknown> };
  /** Optional: resolve a ref's content hash (used for provenance only). */
  hashOf?(ref: string): string;
}

/**
 * The default stylekit a story selects when it declares no `style` (ADR-008 I2). The Kurzgesagt look
 * is now DATA (a library `stylekit` entry), so the default is its catalog NAME — not a core constant.
 */
export const DEFAULT_STYLEKIT_REF = 'kurzgesagt' as const;

/** Options for {@link lowerStory}. All optional — the pass is runnable with none. */
export interface LowerOptions {
  /** Library facade (P2). When present, defs are filled from resolved catalog entries. */
  library?: LibraryLike;
  /** Override the per-scene duration in frames (default: {@link DEFAULT_BEAT_SECONDS} × fps). */
  durationFrames?: number;
  /** I1: override the output format (aspect/size/fps). CLI convenience; the story's `format` is primary. */
  format?: Format | undefined;
}

// --- StyleKit → IR adapters -------------------------------------------------------------------

/**
 * Resolve the story's selected stylekit (ADR-008 I2). A `style` ref (default {@link
 * DEFAULT_STYLEKIT_REF} = "kurzgesagt") is resolved through the Library, which reads the DATA from
 * `library/stylekits/<name>.json`. Without a Library (standalone lowering) the pass falls back to the
 * STYLE-CLEAN {@link NEUTRAL_STYLEKIT} so it stays a pure, runnable function on its own. The resolved
 * stylekit seeds `defs.palette`/`defs.easings` AND is carried whole as `defs.stylekit`.
 */
function resolveStyleKit(story: StoryIR, lib: LibraryLike | undefined): StyleKit {
  const ref = story.style ?? DEFAULT_STYLEKIT_REF;
  if (lib?.toStyleKit) return lib.toStyleKit(ref);
  return NEUTRAL_STYLEKIT;
}

/**
 * Seed a Scene-IR `defs.easings` map from the resolved stylekit's `defaultEasings`. Each value is
 * already either a cubic-bezier tuple or a known curve name — exactly the IR `EasingDef` union — so
 * this is a structural copy that pins the stylekit curves into the scene (spec §6.2/§9).
 */
function easingsFromStyleKit(sk: StyleKit): Easings {
  const out: Record<string, EasingDef> = {};
  for (const [name, def] of Object.entries(sk.defaultEasings)) {
    out[name] = Array.isArray(def) ? ([...def] as EasingDef) : (def as EasingDef);
  }
  return out;
}

/** Seed a Scene-IR `defs.palette` from the resolved stylekit's palette tokens (spec §6.2/§9). */
function paletteFromStyleKit(sk: StyleKit): Palette {
  return { ...sk.palette };
}

// --- color-script (spec §11.4) ----------------------------------------------------------------

/**
 * The fraction of the previous scene's palette that BLEEDS INTO the entering scene at the LEADING
 * EDGE of a transition (color-script, spec §11.4). The entering scene's per-scene palette is the
 * OKLab blend `interpolate(prev, target, 1 − BLEED)` — i.e. the new mood, pulled `BLEED` of the way
 * back toward the previous mood — so the boundary reads as a smooth global shift rather than a snap.
 * A flat per-scene token map (the renderer reads `scene.palette` as static colors), so this is the
 * single deterministic blend point; the transition's own cross-fade carries the eye across it. 0 ⇒ a
 * hard palette swap at the cut (no bleed). Tuned small so the body of the scene shows its true mood.
 */
export const PALETTE_TRANSITION_BLEED = 0.5 as const;

/**
 * Resolve one beat's FULL scene palette (color-script, spec §11.4): the stylekit base, overlaid by
 * the beat's named `mood` (a `palette` library entry, resolved via the Library) and then its inline
 * `palette` override (most specific). Without a Library (standalone lowering) a named mood can't be
 * resolved, so only the inline override applies — the pass stays pure + runnable. Pure: no RNG/clock.
 */
function resolveBeatPalette(beat: Beat, base: Palette, lib: LibraryLike | undefined): Palette {
  const mood =
    beat.mood !== undefined && lib?.toPalette ? lib.toPalette(beat.mood) : undefined;
  const inline = beat.palette as Palette | undefined;
  return resolveScenePalette(base, mood, inline);
}

// --- ref helpers ------------------------------------------------------------------------------

/** The bare name part of a `name@version` ref (or the ref itself if unversioned). */
function refName(ref: string): string {
  return ref.split('@')[0] ?? ref;
}

/** Default an unversioned ref name to `@1.0.0` so the catalog resolves it; pass `name@x.y.z` through. */
function withVersion(ref: string): string {
  return ref.includes('@') ? ref : `${ref}@1.0.0`;
}

/** A Scene-IR `defs` key for a ref (the bare name — stable, human-diffable). */
function defKey(ref: string): string {
  return refName(ref);
}

// --- def resolution ---------------------------------------------------------------------------

/**
 * Resolve an asset def from the library, or synthesize a deterministic fallback `asset://<name>.svg`
 * so the pass runs standalone. The synthetic uri is a pure function of the ref name.
 */
function resolveAsset(ref: string, lib: LibraryLike | undefined): AssetDef {
  // The Library resolves strictly by `name@version`; default an unversioned story ref to `@1.0.0`
  // (mirroring the rig path) so a bare `asset: bg_gradient` declaration resolves against the catalog.
  if (lib) return lib.toAssetDef(withVersion(ref));
  return { uri: `asset://${refName(ref)}.svg`, kind: 'svg' };
}

/**
 * Resolve a rig def from the library, or synthesize a deterministic fallback. The fallback provider
 * is the generic {@link DEFAULT_RIG_PROVIDER}; the Library overrides it from the catalog entry.
 */
function resolveRig(ref: string, lib: LibraryLike | undefined): RigDef {
  if (lib) return lib.toRigDef(ref);
  return { uri: `rig://${refName(ref)}.rig.json`, provider: DEFAULT_RIG_PROVIDER };
}

// --- rig clip planning (author-declared, generic default) -------------------------------------

/**
 * Build a rig's `rig_state.clips` from the beat's `action[]` items that target this rig's HANDLE.
 * Each such action's `do` is the rig's internal animation name (a thin pointer — lowering never
 * re-describes bones; spec §6.2/§8): the first action loops as the base clip, later actions fire as
 * one-shots spaced across the scene, then settle back to the looping base. When NO action targets
 * the rig, the pass loops the GENERIC {@link DEFAULT_RIG_CLIP} so the rig is still alive.
 *
 * Pure + deterministic: frame offsets are a function of the scene length and the action index only.
 * No hardcoded per-rig table, no domain anim names — the clips come from the STORY (or the generic
 * default), never from the compiler.
 */
function clipsForRig(handle: string, actions: ActionItem[], durationFrames: number): RigClip[] {
  const mine = actions.filter((a) => a.on === handle);
  if (mine.length === 0) {
    return [{ anim: DEFAULT_RIG_CLIP, loop: true }];
  }
  // Base looping clip: the generic default, so the rig idles before/after expressive beats.
  const clips: RigClip[] = [{ anim: DEFAULT_RIG_CLIP, loop: true }];
  // Each authored action fires as a one-shot, evenly spaced across the scene, then returns to idle.
  const span = Math.max(1, mine.length);
  mine.forEach((a, i) => {
    const at = Math.floor((durationFrames * (i + 1)) / (span + 1));
    clips.push({ anim: a.do, loop: false, at });
    clips.push({ anim: DEFAULT_RIG_CLIP, loop: true, at: at + 48 });
  });
  return clips;
}

// --- generic per-show[] layer builders --------------------------------------------------------

/**
 * A generic ASSET layer lowered from a `show[].asset` item. The item's `args` may set `z` (z-order),
 * `parallax` (2.5D depth factor; default 0 = static far), and a layout `at` anchor (placement). The
 * authored `asset` name becomes the layer `ref` (a `defs.assets` key); free-form `effects[]` pass
 * straight through. A background is just an asset declared with low z + a far parallax factor — no
 * special builder.
 */
function buildAssetLayer(item: ShowItem, index: number): LoweredLayer {
  const ref = item.asset!;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const id = `L_asset_${item.as ?? `${refName(ref)}_${index}`}`;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 0;
  const parallax = typeof args['parallax'] === 'number' ? (args['parallax'] as number) : 0;
  const effects = Array.isArray(args['effects']) ? (args['effects'] as Effect[]) : undefined;
  // Optional transform channels (generic, author-controlled; mirrors the shape/reusable layers). A
  // background omits these and fills the frame; a PROP (e.g. an imagegen'd PNG) sets scale/position to
  // be placed and sized. A bare number → a static `{a:0,k}` channel; an authored `{a,k}` passes through.
  const channel = (v: unknown): Transform['scale'] | undefined =>
    typeof v === 'number' ? { a: 0, k: v } : v && typeof v === 'object' ? (v as Transform['scale']) : undefined;
  const transform: Transform = {};
  const scaleCh = channel(args['scale']);
  const rotationCh = channel(args['rotation']);
  const opacityCh = channel(args['opacity']);
  if (scaleCh) transform.scale = scaleCh;
  if (rotationCh) transform.rotation = rotationCh;
  if (opacityCh) transform.opacity = opacityCh;
  const layer: AssetLayer = {
    type: 'asset',
    id,
    ref: refName(ref),
    z,
    parallax,
    ...(effects && effects.length > 0 ? { effects } : {}),
    ...(Object.keys(transform).length > 0 ? { transform } : {}),
  };
  // An explicit `at` stages the asset; a background typically omits it (no position needed).
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

/**
 * A generic procedural GENERATOR layer (spec §10/§10.1) lowered from a `show[].generator` item —
 * any registered generator (scatter / water / particles / fire / crowd / chains / …). "Families
 * are sockets; libraries are plugs": the lowering pass does NOT know any generator's params — it
 * forwards the authored `gen` name + the item's free-form `args` and assigns a deterministic seed
 * (story hash + beat id + handle). Each generator's own Zod schema validates the params at render
 * time. The registry resolves `gen` → component on the render side, so each beat gets its own world
 * with NO IR or compositor change. z/path come from `args` (generic, author-controlled).
 */
function buildGeneratorLayer(
  item: ShowItem,
  beatId: string,
  hash: string,
  index: number,
  lib: LibraryLike | undefined
): LoweredLayer {
  const genRef = item.generator!;
  const args = (item.args ?? {}) as Record<string, unknown>;
  // ADR-004 §2 PRESET expansion: a `generator` value may name a `generator-preset` library entry
  // (e.g. "starfield"), which resolves to a concrete `{ gen, params }` — the preset params are defaults
  // merged UNDER the layer's own args (most specific wins). A bare implementation name (or no library)
  // passes straight through. The HANDLE/ID/SEED key on the AUTHORED ref so they stay stable + diffable.
  const expanded = lib?.expandGeneratorRef
    ? lib.expandGeneratorRef(genRef, args)
    : { gen: genRef, params: args };
  const gen = expanded.gen;
  const handle = item.as ?? `${refName(genRef)}_${index}`;
  const id = `L_gen_${refName(genRef)}_${handle}`;
  const seed = deriveSeed(hash, `${beatId}:${refName(genRef)}:${handle}`);
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 1;
  const path = typeof args['path'] === 'string' ? (args['path'] as string) : undefined;
  const effects = Array.isArray(args['effects']) ? (args['effects'] as Effect[]) : undefined;
  const layer: GeneratorLayer = {
    type: 'generator',
    id,
    gen,
    z,
    seed,
    // The preset-expanded params (preset defaults ← layer args), validated by the generator's own Zod
    // schema at render time. Structural keys (z/path/effects) ride here too, harmlessly ignored by gens.
    params: expanded.params,
    ...(path ? { path } : {}),
    ...(effects && effects.length > 0 ? { effects } : {}),
  };
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

/**
 * A first-class SHAPE layer (ADR-003 #1) lowered from a `show[].shape` directive. The rendered
 * geometry is a `@remotion/shapes` PRIMITIVE (kind + params) and/or a flubber-morphed path (`morph`),
 * with a solid- or gradient-`fill` and optional `stroke` — all arriving in the item's free-form
 * `args` and passing straight through to the Scene-IR `shape` layer (validated by the ShapeLayer Zod
 * schema at the boundary; CLAUDE.md rule 5). `z`/`scale`/`rotation`/`opacity` in `args` build the
 * transform; placement is carried as a layout `anchor` (from the item's `at`). Pure structural
 * lowering: no wall-clock, no RNG.
 */
function buildShapeLayer(item: ShowItem, index: number): LoweredLayer {
  const kind = item.shape!;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const id = `L_shape_${item.as ?? `${kind}_${index}`}`;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 5;

  // Geometry: an explicit `morph` channel wins; else the named primitive (the sentinel `morph` kind
  // draws nothing without a morph, which we avoid by requiring args).
  const morph = args['morph'] as ShapeLayer['morph'] | undefined;
  const shape =
    kind === 'morph'
      ? (args['shape'] as ShapeLayer['shape'] | undefined)
      : ({ kind, ...((args['params'] as Record<string, unknown>) ?? {}) } as ShapeLayer['shape']);

  // Transform: scale/rotation/opacity/POSITION from args. A bare number → static `{a:0,k}`; an authored
  // `{a,k}` object passes straight through (so an effect like motion_blur has a real animated move to
  // smear). POSITION accepts a `[x,y]` pixel pair (→ static `{a:0,k:[x,y]}`) OR an `{a,k}` vec2 — an
  // EXPLICIT position is pixel-precise placement (needed to compose an object from many parts), which the
  // director treats as author intent and leaves untouched (director.ts `isFree`: position set ⇒ not free).
  // When omitted, position still comes from the `at` anchor via the layout pass (back-compat).
  const transform: Transform = {};
  const channel = (v: unknown): Transform['scale'] | undefined =>
    typeof v === 'number' ? { a: 0, k: v } : v && typeof v === 'object' ? (v as Transform['scale']) : undefined;
  const positionChannel = (v: unknown): Transform['position'] | undefined =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')
      ? { a: 0, k: v as [number, number] }
      : v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Transform['position'])
        : undefined;
  const scaleCh = channel(args['scale']);
  const rotationCh = channel(args['rotation']);
  const opacityCh = channel(args['opacity']);
  const positionCh = positionChannel(args['position']);
  if (scaleCh) transform.scale = scaleCh;
  if (rotationCh) transform.rotation = rotationCh;
  if (opacityCh) transform.opacity = opacityCh;
  if (positionCh) transform.position = positionCh;

  const layer: ShapeLayer = {
    type: 'shape',
    id,
    z,
    ...(shape ? { shape } : {}),
    ...(morph ? { morph } : {}),
    ...(args['fill'] !== undefined ? { fill: args['fill'] as ShapeLayer['fill'] } : {}),
    ...(args['stroke'] !== undefined ? { stroke: args['stroke'] as ShapeLayer['stroke'] } : {}),
    ...(Array.isArray(args['effects']) ? { effects: args['effects'] as Effect[] } : {}),
    // Per-layer shading override (generic; e.g. `shading: { glow: 0.9 }` flags a layer for the paint
    // GLOW). Passes straight through to the Scene-IR layer (validated by the layer Zod at the boundary).
    ...(args['shading'] !== undefined ? { shading: args['shading'] as ShapeLayer['shading'] } : {}),
    ...(Object.keys(transform).length > 0 ? { transform } : {}),
  };

  // Carry the AUTHOR placement anchor only (M5). When the author omits `at`, NO anchor is emitted —
  // the director (P7) scores a position for the layer. An explicit `at` (even "center") is author intent.
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

/**
 * A first-class TEXT layer lowered from a `show[].text` directive — TYPOGRAPHY as a GENERIC core
 * layer kind (mirrors {@link buildShapeLayer}). The item's value is the literal `content`; its look
 * (font/size/weight/color/align/lineHeight/tracking/box) and kinetic `anim` preset arrive in the
 * free-form `args` and pass straight through to the Scene-IR `text` layer (validated by the
 * TextLayer Zod schema at the boundary; CLAUDE.md rule 5). The default font is the VENDORED LOCAL
 * font (DATA, not a style value) — its FILE URI is embedded so the bundler auto-vendors it. `z`/
 * `scale`/`rotation`/`opacity` build the transform; placement is a layout `anchor` (from `at`).
 * Pure structural lowering: no wall-clock, no RNG. No domain names.
 */
function buildTextLayer(item: ShowItem, index: number): LoweredLayer {
  const content = item.text ?? '';
  const args = (item.args ?? {}) as Record<string, unknown>;
  const id = `L_text_${item.as ?? `text_${index}`}`;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 20;

  // Transform: scale/rotation/opacity from args (position comes from the anchor via layout). A bare
  // number wraps as a static `{a:0,k}` channel; an authored `{a,k}` object passes straight through.
  const transform: Transform = {};
  const channel = (v: unknown): Transform['scale'] | undefined =>
    typeof v === 'number' ? { a: 0, k: v } : v && typeof v === 'object' ? (v as Transform['scale']) : undefined;
  const scaleCh = channel(args['scale']);
  const rotationCh = channel(args['rotation']);
  const opacityCh = channel(args['opacity']);
  if (scaleCh) transform.scale = scaleCh;
  if (rotationCh) transform.rotation = rotationCh;
  if (opacityCh) transform.opacity = opacityCh;

  const font = typeof args['font'] === 'string' ? (args['font'] as string) : DEFAULT_TEXT_FONT;
  const fontUri = typeof args['fontUri'] === 'string' ? (args['fontUri'] as string) : DEFAULT_TEXT_FONT_URI;

  const layer: TextLayer = {
    type: 'text',
    id,
    z,
    content,
    font,
    fontUri,
    ...(typeof args['size'] === 'number' ? { size: args['size'] as number } : {}),
    ...(args['weight'] !== undefined ? { weight: args['weight'] as TextLayer['weight'] } : {}),
    ...(args['color'] !== undefined ? { color: args['color'] as TextLayer['color'] } : {}),
    ...(args['align'] !== undefined ? { align: args['align'] as TextLayer['align'] } : {}),
    ...(typeof args['lineHeight'] === 'number' ? { lineHeight: args['lineHeight'] as number } : {}),
    ...(typeof args['tracking'] === 'number' ? { tracking: args['tracking'] as number } : {}),
    ...(args['box'] !== undefined ? { box: args['box'] as TextLayer['box'] } : {}),
    ...(args['anim'] !== undefined ? { anim: args['anim'] as TextLayer['anim'] } : {}),
    ...(Array.isArray(args['effects']) ? { effects: args['effects'] as Effect[] } : {}),
    ...(Object.keys(transform).length > 0 ? { transform } : {}),
  };

  // Carry the AUTHOR placement anchor only (M5). When the author omits `at`, NO anchor is emitted —
  // the director (P7) scores a position for the layer (default placement is the director's job, not a
  // baked-in "center"). An explicit `at` (even "center") is author intent the director leaves alone.
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

/**
 * The default z-order of an ENVIRONMENT backdrop layer (spec §13.3). An environment is a clip used as
 * a full-scene backdrop — a composed background+ambience bundle — so it sits BEHIND every authored
 * `show[]` layer. Far below the asset-layer default (0) so a beat's own assets still stack on top.
 */
export const ENVIRONMENT_Z = -100 as const;

/**
 * Lower a beat's `environment` ref (spec §13.3) into a backdrop CLIP layer. An environment IS a clip
 * (the spec's "scene-template = a clip used as a backdrop"): we REUSE the clip machinery wholesale — the
 * shared def is resolved + deduped into `defs.clips` exactly like a `show[].clip` (see {@link
 * collectClipDefs}); here we emit ONE `clip` layer per beat, pinned to a far-back z and the scene
 * centre (its inner layers compose in the clip's local space). No new nesting mechanism is built. The
 * id is derived from the beat so re-renders are byte-identical. Pure structural lowering: no RNG.
 */
function buildEnvironmentLayer(envRef: string, beatId: string): LoweredLayer {
  const layer: ClipLayer = {
    type: 'clip',
    id: `L_env_${beatId}`,
    ref: defKey(envRef),
    z: ENVIRONMENT_Z,
    // A backdrop is static far depth (parallax 0 = moves least with the camera), like a background asset.
    parallax: 0,
  };
  // Anchor at "center": the layout pass resolves it to the scene-centre origin (the clip's local space).
  return { ...layer, anchor: 'center' } as LoweredLayer;
}

/**
 * A first-class CLIP layer (M2 nested composition) lowered from a `show[].clip` directive — a
 * PRE-COMPOSITION INSTANCE (mirrors {@link buildShapeLayer}/{@link buildTextLayer}). The clip's
 * shared DEFINITION is resolved + deduped into `defs.clips` separately (see {@link collectClipDefs});
 * here we only emit ONE `clip` LAYER per instance carrying the `ref`, the per-instance `args` (the
 * exposed Essential-Graphics param overrides), the group `transform` (z/scale/rotation/opacity), a
 * `parallax` factor, the local `from`/`duration_frames` window, and `effects[]` — all affecting the
 * WHOLE unit. The def stays SHARED (DRY, the Lottie/AE model): we do NOT inline its layers per
 * instance. The instance handle `as` becomes the clip-layer id, which the renderer uses to NAMESPACE
 * the clip's inner layer ids + derive per-instance generator seeds (so two instances never collide
 * and each is byte-identical). Pure structural lowering: no wall-clock, no RNG.
 */
function buildClipLayer(item: ShowItem, index: number): LoweredLayer {
  const ref = item.clip!;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const id = `L_clip_${item.as ?? `${refName(ref)}_${index}`}`;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 15;

  // Group transform: scale/rotation/opacity/POSITION from args. A bare number → static `{a:0,k}`; an
  // authored `{a,k}` passes straight through. POSITION accepts a `[x,y]` pixel pair or an `{a,k}` vec2 —
  // explicit placement for staging a rig INSTANCE precisely (the director leaves it untouched). When
  // omitted, position comes from the `at` anchor via the layout pass (back-compat). Mirrors buildShapeLayer.
  const transform: Transform = {};
  const channel = (v: unknown): Transform['scale'] | undefined =>
    typeof v === 'number' ? { a: 0, k: v } : v && typeof v === 'object' ? (v as Transform['scale']) : undefined;
  const positionChannel = (v: unknown): Transform['position'] | undefined =>
    Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number')
      ? { a: 0, k: v as [number, number] }
      : v && typeof v === 'object' && !Array.isArray(v)
        ? (v as Transform['position'])
        : undefined;
  const scaleCh = channel(args['scale']);
  const rotationCh = channel(args['rotation']);
  const opacityCh = channel(args['opacity']);
  const positionCh = positionChannel(args['position']);
  if (scaleCh) transform.scale = scaleCh;
  if (rotationCh) transform.rotation = rotationCh;
  if (opacityCh) transform.opacity = opacityCh;
  if (positionCh) transform.position = positionCh;

  // The clip's exposed-param overrides: everything in `args` EXCEPT the structural group keys, which
  // are consumed above (z/scale/rotation/opacity/parallax/effects/from/duration_frames). What remains
  // is the param override map forwarded verbatim to `defs.clips[ref].params` at render (resolveParams).
  const STRUCTURAL = new Set([
    'z', 'scale', 'rotation', 'opacity', 'parallax', 'effects', 'from', 'duration_frames',
  ]);
  const clipArgs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (!STRUCTURAL.has(k)) clipArgs[k] = v;
  }

  const parallax = typeof args['parallax'] === 'number' ? (args['parallax'] as number) : undefined;
  const effects = Array.isArray(args['effects']) ? (args['effects'] as Effect[]) : undefined;
  const from = typeof item.from === 'number' ? item.from : typeof args['from'] === 'number' ? (args['from'] as number) : undefined;
  const durationFrames = typeof args['duration_frames'] === 'number' ? (args['duration_frames'] as number) : undefined;

  const layer: ClipLayer = {
    type: 'clip',
    id,
    ref: defKey(ref),
    z,
    ...(Object.keys(clipArgs).length > 0 ? { args: clipArgs } : {}),
    ...(Object.keys(transform).length > 0 ? { transform } : {}),
    ...(parallax !== undefined ? { parallax } : {}),
    ...(from !== undefined ? { from } : {}),
    ...(durationFrames !== undefined ? { duration_frames: durationFrames } : {}),
    ...(effects && effects.length > 0 ? { effects } : {}),
  };

  // Carry the AUTHOR placement anchor only (M5). When the author omits `at`, NO anchor is emitted —
  // the director (P7) scores a position for the layer. An explicit `at` (even "center") is author intent.
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

/**
 * A generic FOOTAGE layer lowered from a `show[].footage` item (M2 compositing). The item's value is a
 * `defs.assets` ref that must resolve to a `video` or `lottie` asset; the renderer (FootageLayer.tsx)
 * frame-seeks it via Remotion's `<OffthreadVideo>` / `@remotion/lottie` (deterministic). The look —
 * `from` (source start frame), `playbackRate`, `loop`, `fit` (cover/contain/fill), `parallax`, an
 * optional `{a,k}` transform and `effects[]` — travels in `args` and passes straight through to the
 * Scene-IR `footage` layer (validated by FootageLayerSchema at the boundary). Pure structural lowering.
 */
function buildFootageLayer(item: ShowItem, index: number): LoweredLayer {
  const ref = item.footage!;
  const args = (item.args ?? {}) as Record<string, unknown>;
  const id = `L_footage_${item.as ?? `${refName(ref)}_${index}`}`;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 8;

  const transform: Transform = {};
  const channel = (v: unknown): Transform['scale'] | undefined =>
    typeof v === 'number' ? { a: 0, k: v } : v && typeof v === 'object' ? (v as Transform['scale']) : undefined;
  const scaleCh = channel(args['scale']);
  const rotationCh = channel(args['rotation']);
  const opacityCh = channel(args['opacity']);
  if (scaleCh) transform.scale = scaleCh;
  if (rotationCh) transform.rotation = rotationCh;
  if (opacityCh) transform.opacity = opacityCh;

  const parallax = typeof args['parallax'] === 'number' ? (args['parallax'] as number) : undefined;
  const effects = Array.isArray(args['effects']) ? (args['effects'] as Effect[]) : undefined;
  const from = typeof item.from === 'number' ? item.from : typeof args['from'] === 'number' ? (args['from'] as number) : undefined;
  const playbackRate = typeof args['playbackRate'] === 'number' ? (args['playbackRate'] as number) : undefined;
  const loop = typeof args['loop'] === 'boolean' ? (args['loop'] as boolean) : undefined;
  const muted = typeof args['muted'] === 'boolean' ? (args['muted'] as boolean) : undefined;
  const fit =
    args['fit'] === 'cover' || args['fit'] === 'contain' || args['fit'] === 'fill'
      ? (args['fit'] as FootageLayer['fit'])
      : undefined;

  const layer: FootageLayer = {
    type: 'footage',
    id,
    ref: defKey(ref),
    z,
    ...(from !== undefined ? { from } : {}),
    ...(playbackRate !== undefined ? { playbackRate } : {}),
    ...(loop !== undefined ? { loop } : {}),
    ...(muted !== undefined ? { muted } : {}),
    ...(fit !== undefined ? { fit } : {}),
    ...(parallax !== undefined ? { parallax } : {}),
    ...(Object.keys(transform).length > 0 ? { transform } : {}),
    ...(effects && effects.length > 0 ? { effects } : {}),
  };
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

/**
 * Extract the GENERIC compositing fields (blend mode + track matte / mask) any `show[]` item may carry
 * in its free-form `args`, applied uniformly to EVERY layer kind (M2 §11). `blend` maps 1:1 to the
 * CSS `mix-blend-mode`; `matte` clips the layer by a sibling layer's (`from`) or asset's (`ref`)
 * luma/alpha. Both pass straight through to the Scene-IR layer (validated at the boundary) and are
 * applied generically in the compositor's layer wrapper (Scene.tsx), composing with effects/parallax.
 * Pure: a function of the authored args.
 */
function compositingFields(item: ShowItem): { blend?: BlendMode; matte?: Matte } {
  const args = (item.args ?? {}) as Record<string, unknown>;
  const blend = typeof args['blend'] === 'string' ? (args['blend'] as BlendMode) : undefined;
  const matte =
    args['matte'] && typeof args['matte'] === 'object'
      ? (args['matte'] as Matte)
      : undefined;
  return { ...(blend ? { blend } : {}), ...(matte ? { matte } : {}) };
}

/**
 * A generic RIG layer lowered from a `show[].actor` item. The named actor is resolved to its library
 * ref via the story's `cast` declaration; the rig def key is the ref's bare name (a `defs.rigs` key).
 * A StyleKit "pop" entrance (scale + opacity overshoot) makes the rig appear with life (spec §9);
 * `rig_state.clips` come from the beat's `action[]` targeting this handle, else the generic looping
 * default ({@link clipsForRig}). z/at come from `args` (generic). The layer id is derived from the
 * handle so re-renders are byte-identical.
 *
 * Returns `undefined` (skips the layer) when the named actor is not in the cast — lowering never
 * invents a rig the story did not declare (ADR-007: nothing force-injected).
 */
function buildRigLayer(
  item: ShowItem,
  story: StoryIR,
  actions: ActionItem[],
  durationFrames: number
): LoweredLayer | undefined {
  const actorName = item.actor!;
  const entry: CastEntry | undefined = story.cast[actorName];
  if (!entry) return undefined;
  const handle = item.as ?? actorName;
  const rigRef = withVersion(entry.ref);
  const args = (item.args ?? {}) as Record<string, unknown>;
  const z = typeof args['z'] === 'number' ? (args['z'] as number) : 10;
  const id = `L_rig_${handle}`;

  const transform: Transform = {
    // "pop" entrance: scale 0→100 over 12 frames with the overshoot curve (StyleKit "pop").
    scale: {
      a: 1,
      k: [
        { t: 0, s: 0, e: 'pop' },
        { t: 12, s: 100 },
      ],
    },
    opacity: {
      a: 1,
      k: [
        { t: 0, s: 0, e: 'pop' },
        { t: 12, s: 100 },
      ],
    },
  };

  const effects = Array.isArray(args['effects']) ? (args['effects'] as Effect[]) : undefined;
  // Compositional rig fields (spec §8.1), authored on the actor's free-form args:
  //   • `parts`  — INTRA-RIG variant selection (axis → variant name), forwarded OPAQUE to the provider.
  //   • `attach` — INTER-RIG parenting onto another layer's mount; the compositor resolves it per frame.
  // Both pass straight through to the Scene-IR rig layer (validated by the RigLayer Zod at the boundary).
  const parts =
    args['parts'] && typeof args['parts'] === 'object'
      ? (args['parts'] as RigLayer['parts'])
      : undefined;
  const attach =
    args['attach'] && typeof args['attach'] === 'object'
      ? (args['attach'] as RigLayer['attach'])
      : undefined;
  const layer: RigLayer = {
    type: 'rig',
    id,
    ref: defKey(rigRef),
    z,
    transform,
    rig_state: { clips: clipsForRig(handle, actions, durationFrames) },
    ...(parts ? { parts } : {}),
    ...(attach ? { attach } : {}),
    ...(effects && effects.length > 0 ? { effects } : {}),
  };
  // Placement (M5): carry an explicit author `at` only. When omitted, NO anchor is emitted — the
  // director (P7) scores a grounded position for the rig (default staging is the director's job).
  if (typeof item.at === 'string') return { ...layer, anchor: item.at } as LoweredLayer;
  return layer;
}

// --- scene builder ----------------------------------------------------------------------------

/**
 * Lower one beat into one scene placed on the GLOBAL timeline (one beat → one scene). The scene's
 * layers are built ENTIRELY from the beat's declared `show[]` items — each item becomes an asset /
 * generator / shape / rig layer GENERICALLY, dispatched by which field it sets. Nothing is
 * force-injected: a background, a generator, or a rig is present iff the story declares it. Layers
 * are emitted in `show[]` order (z-order is author-controlled via `args.z`). The scene also carries
 * its `camera_intent` (the beat's camera move, expanded later by P8), its `duration_frames`, its
 * global `at`, and its `transition_in` (lowered from the beat's `transition`).
 */
function buildScene(
  beat: Beat,
  at: number,
  durationFrames: number,
  hash: string,
  story: StoryIR,
  transitionIn: Transition | undefined,
  lib: LibraryLike | undefined
): LoweredScene {
  const show = beat.show ?? [];
  const actions = beat.action ?? [];

  // Build one layer per show[] item, generically dispatched by which field is set. The first set
  // field wins (a single item declares a single layer kind). Items that declare nothing renderable
  // (e.g. a reserved `clip` field, or an `actor` not in the cast) are skipped.
  const layers: LoweredLayer[] = [];
  // ENVIRONMENT (spec §13.3): a beat's `environment` ref lowers to a far-back backdrop clip layer FIRST
  // (behind every authored layer), reusing the clip machinery. The def is resolved in collectClipDefs.
  if (beat.environment !== undefined) {
    layers.push(buildEnvironmentLayer(beat.environment, beat.id));
  }
  show.forEach((item, i) => {
    let layer: LoweredLayer | undefined;
    if (item.actor !== undefined) {
      layer = buildRigLayer(item, story, actions, durationFrames);
    } else if (item.generator !== undefined) {
      layer = buildGeneratorLayer(item, beat.id, hash, i, lib);
    } else if (item.shape !== undefined) {
      layer = buildShapeLayer(item, i);
    } else if (item.text !== undefined) {
      layer = buildTextLayer(item, i);
    } else if (item.clip !== undefined) {
      layer = buildClipLayer(item, i);
    } else if (item.footage !== undefined) {
      layer = buildFootageLayer(item, i);
    } else if (item.asset !== undefined) {
      layer = buildAssetLayer(item, i);
    }
    // Generic COMPOSITING (M2 §11): a per-layer blend mode + track matte/mask, authored on any item's
    // `args`, applied uniformly to whatever layer kind was built (composed in the compositor wrapper).
    if (layer !== undefined) {
      const comp = compositingFields(item);
      if (comp.blend || comp.matte) layer = { ...layer, ...comp } as LoweredLayer;
      layers.push(layer);
    }
  });

  // A single GSAP-style label at mid-scene (a generic "reveal" point the camera/timing can key off).
  const reveal = Math.floor(durationFrames / 2);
  const scene: LoweredScene = {
    id: beat.id,
    at,
    duration_frames: durationFrames,
    labels: { reveal },
    layers,
  };
  // Carry the beat's camera move as an INTENT for P8 to expand (omitted → P8 applies its default).
  const intent = cameraIntentForBeat(beat);
  if (intent !== undefined) scene.camera_intent = intent;
  // Carry the beat's transition onto the scene's leading boundary (omitted on a hard cut / no
  // transition — the compositor renders a plain cut). The first scene drops it (no predecessor).
  if (transitionIn) scene.transition_in = transitionIn;
  return scene;
}

// --- def collection ---------------------------------------------------------------------------

/**
 * Walk every beat's `show[]` and collect the asset + rig defs the scenes actually reference, keyed
 * by their `defs` key (bare name). Only DECLARED refs are resolved — the pass never adds a def for a
 * layer the story did not declare (ADR-007). Pure: a function of the story (+ optional library).
 */
function collectDefs(story: StoryIR, lib: LibraryLike | undefined) {
  const assets: Record<string, AssetDef> = {};
  const rigs: Record<string, RigDef> = {};
  for (const beat of story.beats) {
    for (const item of beat.show ?? []) {
      if (item.asset !== undefined) {
        const key = defKey(item.asset);
        if (!(key in assets)) assets[key] = resolveAsset(item.asset, lib);
      }
      // A footage layer's media is a `defs.assets` ref too (resolved to a `video`/`lottie` AssetDef).
      if (item.footage !== undefined) {
        const key = defKey(item.footage);
        if (!(key in assets)) assets[key] = resolveAsset(item.footage, lib);
      }
      if (item.actor !== undefined) {
        const entry = story.cast[item.actor];
        if (entry) {
          const rigRef = withVersion(entry.ref);
          const key = defKey(rigRef);
          if (!(key in rigs)) rigs[key] = resolveRig(rigRef, lib);
        }
      }
    }
  }
  return { assets, rigs };
}

/**
 * The maximum clip-nesting depth the resolver will descend before failing loudly. A guard against a
 * pathological (or cyclic, though cycles are caught separately) chain of clips-containing-clips. Deep
 * enough for any real composition; shallow enough to fail fast on a mistake.
 */
export const MAX_CLIP_DEPTH = 16 as const;

/**
 * Recursively resolve the SHARED clip DEFINITIONS the scenes reference, into `defs.clips` (the Lottie
 * `assets` precomp model). For each `show[].clip` ref:
 *   1. resolve it from the Library ONCE (deduped by `defKey` — N instances share one def);
 *   2. store the resolved {@link ClipDef} in `defs.clips[key]`;
 *   3. RECURSE: walk the def's own layer templates, and for every nested `clip` layer
 *      ({ type:'clip', ref }) resolve THAT ref into `defs.clips` too — so a clip-containing-a-clip
 *      lands every transitively-referenced def in the shared map (DRY).
 *
 * CYCLE DETECTION: a `visiting` set tracks the refs on the current resolution PATH; re-entering one is
 * a cycle (clip A → clip B → clip A) and throws. A DEPTH CAP ({@link MAX_CLIP_DEPTH}) is a second
 * guard. Already-resolved refs NOT on the current path are skipped (the dedup), so a diamond (two
 * clips both using a third) resolves the third once without false-positiving as a cycle.
 *
 * Pure: a function of the story (+ Library). No wall-clock, no RNG. Without a Library (standalone
 * lowering) there is no clip source, so the map is empty (clips are library-only in the MVP).
 */
function collectClipDefs(story: StoryIR, lib: LibraryLike | undefined): Record<string, ClipDef> {
  const clips: Record<string, ClipDef> = {};
  if (!lib?.toClip) return clips;
  const toClip = lib.toClip.bind(lib);

  // Resolve one ref + recurse into its nested clip layers. `visiting` is the current path (cycle
  // guard); `depth` is the absolute nesting level (depth cap).
  const resolve = (ref: string, visiting: Set<string>, depth: number): void => {
    const key = defKey(ref);
    if (depth > MAX_CLIP_DEPTH) {
      throw new Error(`clip nesting exceeds MAX_CLIP_DEPTH (${MAX_CLIP_DEPTH}) at "${key}"`);
    }
    if (visiting.has(key)) {
      throw new Error(
        `clip dependency cycle detected: "${key}" re-entered along path [${[...visiting, key].join(' -> ')}]`,
      );
    }
    if (key in clips) return; // dedup: already resolved (not on this path) → shared, resolve once.

    const def = toClip(withVersion(ref));
    clips[key] = def;

    // Recurse into the def's nested `clip` layer templates. Templates are loose records; a nested clip
    // is identified by `type === 'clip'` and carries a `ref`. Param-wired refs ({ $param } / "{{}}")
    // are NOT resolvable at lowering (they're instance-time), so only literal string refs recurse.
    const nextVisiting = new Set(visiting).add(key);
    for (const tmpl of def.layers) {
      if (tmpl && typeof tmpl === 'object' && (tmpl as Record<string, unknown>)['type'] === 'clip') {
        const nestedRef = (tmpl as Record<string, unknown>)['ref'];
        if (typeof nestedRef === 'string' && nestedRef.length > 0) {
          resolve(nestedRef, nextVisiting, depth + 1);
        }
      }
    }
  };

  for (const beat of story.beats) {
    // An `environment` ref (spec §13.3) is a clip used as a backdrop — resolve its def the same way.
    if (beat.environment !== undefined) resolve(beat.environment, new Set<string>(), 0);
    for (const item of beat.show ?? []) {
      if (item.clip !== undefined) resolve(item.clip, new Set<string>(), 0);
    }
  }
  return clips;
}

// --- the pass ---------------------------------------------------------------------------------

/**
 * P5: lower a Story IR into a sequenced, multi-scene Scene IR on the global timeline.
 *
 * Each beat becomes ONE scene; scenes are laid out back-to-back on the GLOBAL timeline with
 * transitions between them:
 *   • layers    — built ENTIRELY from each beat's declared `show[]` items (asset / generator / shape
 *                 / rig, generically). Nothing is force-injected (ADR-007).
 *   • duration  — each scene's `duration_frames` comes from the beat's `duration` (seconds/frames),
 *                 falling back to {@link DEFAULT_BEAT_SECONDS} (×fps) or an explicit override.
 *   • at        — cumulative: scene[i].at = scene[i-1].at + scene[i-1].duration − overlap[i], where
 *                 overlap[i] is the frames scene[i]'s `transition_in` overlaps the previous tail
 *                 (0 for a hard cut / no transition).
 *   • transition— each beat's `transition` lowers onto the scene's `transition_in` (the FIRST beat's
 *                 transition is dropped — nothing precedes it).
 *   • camera    — each beat's camera INTENT is carried as `camera_intent`; the lite camera pass (P8)
 *                 expands it into concrete per-scene keyframes.
 *   • total     — `config.duration_frames` = Σ duration_frames − Σ overlaps.
 *
 * Pure + deterministic: same `(story, opts)` ⇒ same Scene IR (generator seeds derive from the story
 * hash; all motion uses StyleKit easing refs; no wall-clock, no RNG). `defs` is resolved once from
 * only the refs the story declares, and shared by all scenes.
 *
 * Returns a {@link LoweredSceneIR}: scenes carry `camera_intent` (not yet a concrete camera) and may
 * carry layout `anchor`s, so the lite layout (P6) + camera (P8) passes run next; the final Zod
 * Scene-IR boundary is `validate.ts` (V).
 *
 * @param story validated Story IR (from P0).
 * @param opts  optional library facade (P2) + per-beat duration override.
 * @returns the lowered Scene IR (camera as intent), ready for the layout+camera lite passes.
 */
export function lowerStory(story: StoryIR, opts: LowerOptions = {}): LoweredSceneIR {
  const lib = opts.library;
  // I1: frame size + fps come from the story's `format` (or a CLI override), not a hardcoded config.
  const { w, h, fps } = resolveConfig(story.format, opts.format);

  const hash = storyHash(story);

  // I2/I3: resolve the selected stylekit (DATA; default "kurzgesagt"). It seeds palette/easings AND
  // travels whole in `defs.stylekit` so render-time reads motion/liveness/shading/floor from the IR.
  const stylekit = resolveStyleKit(story, lib);

  // Resolve the def tables once (shared by all scenes) from ONLY the refs the story declares.
  const { assets, rigs } = collectDefs(story, lib);
  // Clip (nested-composition) defs: resolved + deduped + recursed into `defs.clips` (the Lottie
  // `assets` precomp model). Empty without a Library (clips are library-only in the MVP).
  const clips = collectClipDefs(story, lib);
  const defs = {
    palette: paletteFromStyleKit(stylekit),
    easings: easingsFromStyleKit(stylekit),
    assets,
    rigs,
    clips,
    stylekit,
  };

  // Per-beat duration default: an explicit override, else DEFAULT_BEAT_SECONDS × fps.
  const beatDefaultFrames = opts.durationFrames ?? Math.round(DEFAULT_BEAT_SECONDS * fps);

  // COLOR-SCRIPT (spec §11.4): pre-resolve each beat's FULL scene palette (stylekit base ← named mood
  // ← inline override). Resolving ALL beats up front lets the per-scene palette at a transition bleed
  // toward the PREVIOUS beat's palette in OKLab (a smooth mood shift), not just the base.
  const fullPalettes: Palette[] = story.beats.map((beat) =>
    resolveBeatPalette(beat, defs.palette, lib),
  );

  // Lower each beat to a scene, sequencing them on the global timeline with transition overlaps.
  const scenes: LoweredScene[] = [];
  let at = 0;
  let total = 0;
  story.beats.forEach((beat, i) => {
    // This scene's length: the beat's explicit duration, else the (possibly overridden) default.
    const durationFrames = resolveBeatFrames(beat.duration, fps) ?? beatDefaultFrames;

    // The leading transition (dropped on the first scene). It overlaps the PREVIOUS scene's tail.
    const transitionIn = i === 0 ? undefined : resolveTransitionIn(beat);
    const overlap = overlapFrames(transitionIn);

    // Pull this scene back over the previous tail by the overlap so the transition cross-fades.
    at -= overlap;

    // COLOR-SCRIPT: the scene's per-scene palette is the resolved target, BLED toward the previous
    // scene's palette across a (non-cut) transition in OKLab (culori) so a mood change reads as a
    // smooth global shift (spec §11.4). The first scene (or a hard cut) takes its target palette as-is.
    const target = fullPalettes[i] ?? defs.palette;
    let scenePalette = target;
    if (i > 0 && overlap > 0) {
      const prev = fullPalettes[i - 1] ?? defs.palette;
      scenePalette = interpolatePalettes(prev, target, 1 - PALETTE_TRANSITION_BLEED);
    }
    // Carry ONLY the diff vs the base (a minimal override the renderer merges over `defs.palette`).
    const paletteOverride = paletteDiff(scenePalette, defs.palette);

    const scene = buildScene(beat, at, durationFrames, hash, story, transitionIn, lib);
    if (Object.keys(paletteOverride).length > 0) scene.palette = paletteOverride;
    scenes.push(scene);

    at += durationFrames;
    total += durationFrames - overlap;
  });

  const loweredIR: LoweredSceneIR = {
    scene_ir_version: '1.0',
    config: { w, h, fps, duration_frames: total },
    defs,
    audio: [],
    captions: [],
    scenes,
    // M5: carry the story's DIRECTOR selection (transient — stripped at the validate boundary) so the
    // back-end director pass (P7) knows which impl to run. Omitted → the default heuristic director.
    ...(story.director ? { director: story.director } : {}),
    // M8a: carry the film-level POST grade VERBATIM into Scene IR `post[]` (the compositor applies it
    // over the whole frame via the core-effects registry). Omitted in the story → omitted here (strict
    // no-op; a film without `post` stays byte-identical). Validated at render by each effect's own Zod.
    ...(story.post && story.post.length > 0 ? { post: story.post } : {}),
    provenance: {
      story_ir_hash: hash,
      passes: [`${PASS_ID}@${PASS_VERSION}`],
    },
  };

  return loweredIR;
}
