// OTIO export — compile a Scene IR (a deterministic, sequenced film) into an OpenTimelineIO-aligned
// timeline JSON (`.otio`), the interchange format NLEs (Resolve/Premiere/Flame via otio adapters) read.
//
// "Reuse over invent" (CLAUDE.md r.3): OTIO concepts only — we EMIT valid OTIO JSON by hand (the
// schema is a small, stable set of tagged objects), rather than depending on the Python `opentimelineio`
// lib (no Python at build/render; keep the toolchain lean). The emitted doc validates against the
// `OTIO_SCHEMA` tags every adapter dispatches on (Timeline.1, Stack.1, Track.1, Clip.2, Gap.1,
// Transition.1, ExternalReference.1, GeneratorReference.1, MissingReference.1, RationalTime.1,
// TimeRange.1). All metadata we add lives under a namespaced `metadata["animation-factory"]` bag so a
// foreign adapter ignores it (OTIO's metadata contract) while a round-trip back into our pipeline can
// recover the Scene-IR identity (layer id, type, provider/gen, palette, etc.).
//
// DETERMINISM (r.1): the export is a PURE function of the Scene IR (no wall-clock, no RNG). Same
// scene.json ⇒ byte-identical .otio. The OTIO `RationalTime` rate is the scene fps; every duration is
// the IR's integer `duration_frames` (frames are the unit), so there is no float drift.
//
// MAPPING (Scene IR → OTIO), see the module doc-comments per builder below:
//   SceneIR                 → Timeline (one tracks Stack)
//     config.fps            → the global RationalTime `rate`
//     scenes[]              → CLIPS on a "Scenes" video Track (each a clip whose source_range length is
//                             the scene's duration_frames; placed back-to-back; a Gap fills any hole).
//                             A scene's `transition_in` becomes an OTIO Transition spanning the cut.
//       scene.layers[]      → a nested per-scene Stack carried in the clip metadata is NOT how OTIO
//                             models it; instead each scene ALSO emits its own Track group (one Track
//                             per layer z-order band) under a per-scene Stack on a parallel structure —
//                             we expose BOTH the flat "Scenes" track (the editorial cut) AND a
//                             per-scene layer breakdown in metadata so the timeline opens cleanly in an
//                             NLE yet keeps the full layer graph for a faithful round-trip.
//     audio[]               → CLIPS on an "Audio" audio Track (ExternalReference to the cached wav),
//                             placed at each cue's `at`, length = cue.duration_frames; Gaps fill holes.
//
// The result is intentionally NLE-friendly (a flat editorial cut: one video track of scene clips + one
// audio track of narration/sfx/music clips + transitions) while LOSSLESS for our own purposes (the
// per-layer detail rides along in namespaced metadata).

import type { SceneIR, Scene, Layer, AudioCue, Transition } from '../ir/index.js';

const NS = 'animation-factory';

// --- OTIO value objects (the small, stable tagged-record vocabulary) ---

interface RationalTime {
  OTIO_SCHEMA: 'RationalTime.1';
  rate: number;
  value: number;
}
interface TimeRange {
  OTIO_SCHEMA: 'TimeRange.1';
  duration: RationalTime;
  start_time: RationalTime;
}

const rt = (value: number, rate: number): RationalTime => ({
  OTIO_SCHEMA: 'RationalTime.1',
  rate,
  value,
});
const range = (start: number, duration: number, rate: number): TimeRange => ({
  OTIO_SCHEMA: 'TimeRange.1',
  duration: rt(duration, rate),
  start_time: rt(start, rate),
});

// --- OTIO composables ---

type OtioMetadata = Record<string, unknown>;

interface ExternalReference {
  OTIO_SCHEMA: 'ExternalReference.1';
  name: string;
  target_url: string;
  available_range: TimeRange | null;
  metadata: OtioMetadata;
}
interface GeneratorReference {
  OTIO_SCHEMA: 'GeneratorReference.1';
  name: string;
  generator_kind: string;
  parameters: Record<string, unknown>;
  available_range: TimeRange | null;
  metadata: OtioMetadata;
}
interface MissingReference {
  OTIO_SCHEMA: 'MissingReference.1';
  name: string;
  available_range: TimeRange | null;
  metadata: OtioMetadata;
}
type MediaReference = ExternalReference | GeneratorReference | MissingReference;

interface Clip {
  OTIO_SCHEMA: 'Clip.2';
  name: string;
  source_range: TimeRange;
  effects: unknown[];
  markers: unknown[];
  enabled: boolean;
  media_references: Record<string, MediaReference>;
  active_media_reference_key: string;
  metadata: OtioMetadata;
}
interface Gap {
  OTIO_SCHEMA: 'Gap.1';
  name: string;
  source_range: TimeRange;
  effects: unknown[];
  markers: unknown[];
  enabled: boolean;
  metadata: OtioMetadata;
}
interface OtioTransition {
  OTIO_SCHEMA: 'Transition.1';
  name: string;
  transition_type: string;
  in_offset: RationalTime;
  out_offset: RationalTime;
  metadata: OtioMetadata;
}
type TrackChild = Clip | Gap | OtioTransition;

interface Track {
  OTIO_SCHEMA: 'Track.1';
  name: string;
  kind: 'Video' | 'Audio';
  children: TrackChild[];
  source_range: TimeRange | null;
  effects: unknown[];
  markers: unknown[];
  enabled: boolean;
  metadata: OtioMetadata;
}
interface Stack {
  OTIO_SCHEMA: 'Stack.1';
  name: string;
  children: Track[];
  source_range: TimeRange | null;
  effects: unknown[];
  markers: unknown[];
  enabled: boolean;
  metadata: OtioMetadata;
}
interface Timeline {
  OTIO_SCHEMA: 'Timeline.1';
  name: string;
  global_start_time: RationalTime;
  tracks: Stack;
  metadata: OtioMetadata;
}

// --- builders ---

/**
 * Map a Scene-IR scene `transition_in` to an OTIO `transition_type`. OTIO defines exactly one
 * standard cross-dissolve constant (`SMPTE_Dissolve`); every other family is a vendor/custom string
 * (adapters pass unknown transition_types through). We keep our IR `kind` verbatim under metadata for a
 * lossless round-trip, and pick the closest standard editorial type for the `transition_type` field:
 * fade/iris/mask/morph-match → a dissolve (a blend across the cut); wipe/slide → a custom wipe type;
 * cut / match-cut / camera-continuous → no OTIO Transition object (a hard boundary).
 */
function otioTransitionType(kind: Transition['kind']): string | null {
  switch (kind) {
    case 'cut':
    case 'match-cut':
    case 'camera-continuous':
      return null; // a hard cut — OTIO models this as the absence of a Transition.
    case 'fade':
    case 'iris':
    case 'mask':
    case 'morph-match':
      return 'SMPTE_Dissolve';
    case 'wipe':
    case 'slide':
      return `Custom_${kind === 'wipe' ? 'Wipe' : 'Slide'}`;
    default:
      return 'Custom_Transition';
  }
}

/**
 * A scene's `transition_in` → an OTIO Transition placed at the scene's LEADING cut. OTIO transitions
 * sit BETWEEN two items in a track and overlap them by `in_offset` (into the outgoing item) +
 * `out_offset` (into the incoming item). We split the IR's single `duration` (frames) symmetrically so
 * the dissolve straddles the cut, matching how the compositor overlaps the adjacent scene's tail.
 */
function buildTransition(t: Transition, rate: number): OtioTransition | null {
  const type = otioTransitionType(t.kind);
  if (type === null) return null;
  const dur = typeof t.duration === 'number' && t.duration > 0 ? t.duration : Math.round(rate / 2);
  const half = dur / 2;
  return {
    OTIO_SCHEMA: 'Transition.1',
    name: t.kind,
    transition_type: type,
    in_offset: rt(half, rate),
    out_offset: rt(dur - half, rate),
    metadata: { [NS]: { transition: t } }, // verbatim IR transition for a lossless round-trip
  };
}

/**
 * One Scene-IR layer → an OTIO Clip. The clip's `source_range` is the layer's full extent within its
 * scene (0 .. scene.duration_frames at the scene fps): our layers are not externally time-seeked except
 * `footage` (which carries its own `from`/`playbackRate`, recorded in metadata). The media reference is
 * chosen by layer type so an NLE shows something meaningful:
 *   • asset / footage  → ExternalReference to the asset URI (real media on disk).
 *   • generator        → GeneratorReference (OTIO's native "this clip is synthesized" node).
 *   • rig / shape / text / clip → MissingReference (procedural, no external file) — the full descriptor
 *     rides in metadata so the round-trip is lossless.
 * Every layer's full IR object is preserved under `metadata["animation-factory"].layer`.
 */
function buildLayerClip(
  layer: Layer,
  scene: Scene,
  sceneIR: SceneIR,
  rate: number,
): Clip {
  const dur = scene.duration_frames;
  const assets = sceneIR.defs?.assets ?? {};

  let mediaRef: MediaReference;
  if (layer.type === 'asset' || layer.type === 'footage') {
    const def = assets[layer.ref];
    mediaRef = {
      OTIO_SCHEMA: 'ExternalReference.1',
      name: layer.ref,
      target_url: def?.uri ?? `asset://${layer.ref}`,
      available_range: range(0, dur, rate),
      metadata: { [NS]: { assetKind: def?.kind ?? 'unknown' } },
    };
  } else if (layer.type === 'generator') {
    mediaRef = {
      OTIO_SCHEMA: 'GeneratorReference.1',
      name: layer.gen,
      generator_kind: layer.gen,
      parameters: { seed: layer.seed, ...(layer.params ?? {}) },
      available_range: range(0, dur, rate),
      metadata: {},
    };
  } else {
    mediaRef = {
      OTIO_SCHEMA: 'MissingReference.1',
      name: `${layer.type}:${layer.id}`,
      available_range: range(0, dur, rate),
      metadata: { [NS]: { procedural: true, layerType: layer.type } },
    };
  }

  return {
    OTIO_SCHEMA: 'Clip.2',
    name: layer.id,
    source_range: range(0, dur, rate),
    effects: [],
    markers: [],
    enabled: true,
    media_references: { DEFAULT_MEDIA: mediaRef },
    active_media_reference_key: 'DEFAULT_MEDIA',
    // The full layer IR — the lossless payload for a round-trip back into the Scene IR.
    metadata: { [NS]: { layer } },
  };
}

/**
 * A scene → one OTIO Clip on the flat editorial "Scenes" video track. Its `source_range` length is the
 * scene's `duration_frames` (start 0, since the track sequences clips back-to-back; the global position
 * is the cumulative track offset, exactly the IR's `scene.at`). The per-layer breakdown is attached as
 * a nested per-scene Stack under metadata so an NLE sees a clean cut while we keep the full graph.
 */
function buildSceneClip(scene: Scene, sceneIR: SceneIR, rate: number): Clip {
  // The per-scene layer breakdown: one Track per layer (ordered by z, then declaration), each holding a
  // single clip spanning the scene. Carried in metadata (NLEs read the flat scene clip; round-trip reads
  // this). Sorting by z keeps a stable, deterministic order independent of authoring order ties.
  const orderedLayers = scene.layers
    .map((l, i) => ({ l, i }))
    .sort((a, b) => (a.l.z ?? 0) - (b.l.z ?? 0) || a.i - b.i)
    .map(({ l }) => l);

  const layerTracks: Track[] = orderedLayers.map((layer) => ({
    OTIO_SCHEMA: 'Track.1',
    name: layer.id,
    kind: 'Video',
    children: [buildLayerClip(layer, scene, sceneIR, rate)],
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    metadata: { [NS]: { z: layer.z ?? 0, layerType: layer.type } },
  }));

  const layerStack: Stack = {
    OTIO_SCHEMA: 'Stack.1',
    name: `${scene.id}__layers`,
    children: layerTracks,
    source_range: range(0, scene.duration_frames, rate),
    effects: [],
    markers: [],
    enabled: true,
    metadata: { [NS]: { sceneId: scene.id } },
  };

  return {
    OTIO_SCHEMA: 'Clip.2',
    name: scene.id,
    source_range: range(0, scene.duration_frames, rate),
    effects: [],
    markers: [],
    enabled: true,
    media_references: {
      DEFAULT_MEDIA: {
        OTIO_SCHEMA: 'MissingReference.1',
        name: scene.id,
        available_range: range(0, scene.duration_frames, rate),
        metadata: {},
      },
    },
    active_media_reference_key: 'DEFAULT_MEDIA',
    metadata: {
      [NS]: {
        sceneId: scene.id,
        at: scene.at,
        labels: scene.labels ?? {},
        camera: scene.camera,
        ...(scene.palette ? { palette: scene.palette } : {}),
        ...(scene.transition_in ? { transition_in: scene.transition_in } : {}),
        ...(scene.transition_out ? { transition_out: scene.transition_out } : {}),
        // The full per-layer breakdown (one track per layer) for a lossless round-trip.
        layers: layerStack,
      },
    },
  };
}

/**
 * The flat editorial video track: scene clips placed back-to-back in `at` order, with a Gap inserted
 * wherever the next scene's `at` exceeds the running cursor (so global timeline positions are exact),
 * and an OTIO Transition spliced in before a scene that declares a (non-cut) `transition_in`.
 */
function buildScenesTrack(sceneIR: SceneIR, rate: number): Track {
  const scenes = [...sceneIR.scenes].sort((a, b) => a.at - b.at);
  const children: TrackChild[] = [];
  let cursor = 0;
  for (const scene of scenes) {
    if (scene.at > cursor) {
      children.push(makeGap('gap', scene.at - cursor, rate));
      cursor = scene.at;
    }
    if (scene.transition_in) {
      const tr = buildTransition(scene.transition_in, rate);
      if (tr) children.push(tr);
    }
    children.push(buildSceneClip(scene, sceneIR, rate));
    cursor = scene.at + scene.duration_frames;
  }
  return {
    OTIO_SCHEMA: 'Track.1',
    name: 'Scenes',
    kind: 'Video',
    children,
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
  };
}

function makeGap(name: string, duration: number, rate: number): Gap {
  return {
    OTIO_SCHEMA: 'Gap.1',
    name,
    source_range: range(0, duration, rate),
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
  };
}

/**
 * An audio cue → an OTIO Clip on the "Audio" track. The cue `src` (a cached wav, `audio://…`) becomes
 * an ExternalReference; the cue's `at`/`duration_frames` place + size it (Gaps fill the silence between
 * cues). `kind` (narration/sfx/music) + transcript ride in metadata. A music-bed cue (which may loop
 * under the whole film) is exported with its full length too.
 */
function buildAudioTrack(cues: AudioCue[], rate: number): Track {
  const sorted = [...cues].sort((a, b) => a.at - b.at);
  const children: TrackChild[] = [];
  let cursor = 0;
  for (const cue of sorted) {
    const at = Math.max(0, Math.round(cue.at));
    if (at > cursor) {
      children.push(makeGap('gap', at - cursor, rate));
      cursor = at;
    }
    const dur = Math.max(1, Math.round(cue.duration_frames));
    children.push({
      OTIO_SCHEMA: 'Clip.2',
      name: cue.id,
      source_range: range(0, dur, rate),
      effects: [],
      markers: [],
      enabled: true,
      media_references: {
        DEFAULT_MEDIA: {
          OTIO_SCHEMA: 'ExternalReference.1',
          name: cue.id,
          target_url: cue.src ?? `audio://${cue.id}`,
          available_range: range(0, dur, rate),
          metadata: { [NS]: { audioKind: cue.kind } },
        },
      },
      active_media_reference_key: 'DEFAULT_MEDIA',
      metadata: {
        [NS]: {
          audioKind: cue.kind,
          at: cue.at,
          ...(cue.transcript ? { transcript: cue.transcript } : {}),
        },
      },
    });
    cursor = at + dur;
  }
  return {
    OTIO_SCHEMA: 'Track.1',
    name: 'Audio',
    kind: 'Audio',
    children,
    source_range: null,
    effects: [],
    markers: [],
    enabled: true,
    metadata: {},
  };
}

/**
 * Export a compiled Scene IR to an OTIO Timeline object (a plain JS object that JSON-serializes to a
 * valid `.otio` document). PURE + DETERMINISTIC: a function of the IR alone.
 *
 * Structure: a Timeline whose root `tracks` Stack holds a flat editorial "Scenes" video track (scene
 * clips + transitions + gaps) and — when the IR carries audio — an "Audio" track (narration/sfx/music
 * clips). The per-scene layer graph rides losslessly in each scene clip's metadata.
 */
export function sceneIRToOtio(sceneIR: SceneIR, name = 'animation'): Timeline {
  const rate = sceneIR.config.fps;

  const tracks: Track[] = [buildScenesTrack(sceneIR, rate)];
  const audio = sceneIR.audio ?? [];
  if (audio.length > 0) tracks.push(buildAudioTrack(audio, rate));

  return {
    OTIO_SCHEMA: 'Timeline.1',
    name,
    global_start_time: rt(0, rate),
    tracks: {
      OTIO_SCHEMA: 'Stack.1',
      name: 'tracks',
      children: tracks,
      source_range: null,
      effects: [],
      markers: [],
      enabled: true,
      metadata: {},
    },
    metadata: {
      [NS]: {
        scene_ir_version: sceneIR.scene_ir_version,
        config: sceneIR.config,
        // The base palette/easings travel along so a round-trip can rebuild defs (the per-scene clips
        // carry their own overrides). The rig/asset/clip DEFS stay in the Scene IR (OTIO is editorial).
        palette: sceneIR.defs?.palette ?? {},
        ...(sceneIR.provenance ? { provenance: sceneIR.provenance } : {}),
      },
    },
  };
}

/** Serialize an OTIO Timeline to the canonical `.otio` JSON text (2-space indent + trailing newline). */
export function otioToJSON(timeline: Timeline): string {
  return JSON.stringify(timeline, null, 2) + '\n';
}
