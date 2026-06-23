// <SceneIRComposition> — the top-level Remotion composition body. Spec §3 ("The Scene IR *is* a
// Remotion composition's inputProps — no translation layer"), §6.2, §11.2 (transitions), §15.
//
// The whole Scene IR arrives as `inputProps`. This component lays the FULL scene SEQUENCE onto the
// global timeline: every `sceneIR.scenes` entry becomes one segment placed back-to-back, with a
// TRANSITION between consecutive scenes (spec §11.2). Each segment renders via the existing <Scene>
// compositor (which already handles layers / camera / parallax / shading per scene, incl. SceneLook).
//
// SEQUENCING (the multi-scene contract):
//   • We use `@remotion/transitions` `TransitionSeries`: `.Sequence` per scene + `.Transition`
//     between consecutive scenes whose inbound scene declares a (non-`cut`) `transition_in`.
//   • A scene's `transition_in.kind` is resolved THROUGH the engine `transitions` extension-point
//     registry (the core-transitions PLUGIN registers fade/wipe/slide/iris/mask/morph-match/match-cut/
//     camera-continuous; ADR-005 close-the-stub). Core no longer hardcodes a kind→preset switch — it
//     looks up `transitions.get(kind).build({transition,width,height})` for the presentation. A `cut`
//     (or no transition_in) is a plain hard cut — NO `.Transition` is emitted, the segments butt
//     together. An unregistered kind falls back to fade (keeps the renderer runnable on a bare engine).
//   • A transition of length D OVERLAPS the two adjacent segments by D frames, so the timeline length
//     is `Σ scene.duration_frames − Σ transition.duration`. The lowering pass computes each scene's
//     `at` and the root `config.duration_frames` from exactly these same overlaps, so the
//     TransitionSeries total equals `config.duration_frames` (asserted by Root's calculateMetadata).
//
// TOTAL DURATION: derived = `config.duration_frames`. The composition's `durationInFrames` (set by
// Root's `calculateMetadata`) is `config.duration_frames`; the TransitionSeries produces the same
// length because its sequence durations (each `scene.duration_frames`) minus its transition durations
// (each inbound `transition_in.duration`) is precisely how the lowering pass derived that total.
//
// DETERMINISM (CLAUDE.md r.1): a pure function of `inputProps`. TransitionSeries is frame-driven (it
// reads Remotion's frame clock; transitions are timed by `linearTiming`, a pure function of frame),
// and all per-frame motion lives in <Scene> and the sub-renderers via `useCurrentFrame()`. The
// transition presentations resolved from the registry are themselves pure fns of presentationProgress.
// No Date.now / Math.random; the transition easing is a fixed StyleKit cubic-bezier.

import React from 'react';
import { AbsoluteFill, Audio, Easing, Loop, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  TransitionSeries,
  linearTiming,
  type TransitionPresentation,
} from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import type { SceneIR, Scene as SceneType, Transition, Easings } from '../ir/index.js';
import { transitions } from '../engine/index.js';
import { Scene } from './Scene.js';
import { CaptionTrack } from './CaptionTrack.js';
import { easingFn } from './stylekit.js';

// P3 (alpha): `inputProps` is the Scene IR PLUS an optional transient render-time `_alpha` flag the
// CLI sets ONLY for an `--alpha` render. It is NOT part of scene.json (the canonical record stays a
// pure Scene IR — determinism of the on-disk artifact is preserved); it is a presentation hint that
// tells the compositor to render on a TRANSPARENT canvas: omit the root background fill AND drop the
// far-back backdrop layers (the documented "low-z, parallax-0" background convention), so the alpha
// channel actually carries through to the RGBA frames instead of being flattened to opaque.
export type SceneIRCompositionProps = SceneIR & { _alpha?: boolean };

/** Default transition length (frames) when a non-`cut` transition omits `duration`. Mirrors the
 *  lowering pass's `DEFAULT_TRANSITION_FRAMES` so the rendered overlap matches the timeline math. */
const DEFAULT_TRANSITION_FRAMES = 15;

/**
 * The "smooth" easing fn used to time every transition so no transition is ever linearly timed
 * (spec §9). Resolved from the scene's `defs.easings` (seeded from the selected stylekit), so a
 * style swap re-tunes transitions coherently — NO hardcoded core curve. Falls back to a standard
 * ease curve only if the table lacks "smooth" (keeps the renderer runnable on a bare IR).
 */
function smoothEasingFor(easings: Easings) {
  try {
    return easingFn('smooth', easings);
  } catch {
    return Easing.bezier(0.25, 0.1, 0.25, 1);
  }
}

/**
 * The overlap (frames) a scene's leading transition consumes from the previous scene's tail.
 * `cut` / no transition / non-positive duration → 0 (segments butt together; no `.Transition`).
 * This MUST match the lowering pass's `overlapFrames` so the TransitionSeries length equals
 * `config.duration_frames`.
 */
function transitionOverlap(t: Transition | undefined): number {
  if (!t || t.kind === 'cut') return 0;
  const d = t.duration ?? DEFAULT_TRANSITION_FRAMES;
  return d > 0 ? d : 0;
}

/**
 * Resolve the @remotion/transitions presentation for a scene's `transition_in` via the engine
 * `transitions` registry (populated by the core-transitions plugin). Every concrete presentation lives
 * in that plugin (ADR-005); core only looks it up by `kind`. If the kind is not registered (a bare
 * engine with no transitions plugin), fall back to fade so the boundary still reads as a transition.
 */
function presentationFor(
  t: Transition,
  width: number,
  height: number,
): TransitionPresentation<Record<string, unknown>> {
  if (transitions.has(t.kind)) {
    return transitions.get(t.kind).build({ transition: t, width, height });
  }
  return fade() as TransitionPresentation<Record<string, unknown>>;
}

/**
 * Resolve an audio cue `src` (`audio://…` / `asset://…` / bare path) to a Remotion `staticFile` URL
 * under the render publicDir (assets/). Mirrors the asset-layer resolver: a `scheme://` prefix is
 * stripped, the rest is a path relative to public/. The narration wavs are vendored into assets/audio/.
 */
function resolveAudioUrl(src: string): string {
  const path = src.includes('://') ? src.slice(src.indexOf('://') + 3) : src;
  return staticFile(path);
}

/**
 * The narration AUDIO track. Each AudioCue is a Remotion <Audio> inside a <Sequence from={cue.at}> so
 * it starts at the BEAT's global timeline frame. Remotion MUXES this into the encode automatically
 * (h264 + aac) when <Audio> is present — we do NOT reimplement audio mixing (ADR-003: never
 * reimplement a Remotion primitive). DETERMINISM: the wav is a FIXED, content-addressed file produced
 * OFFLINE (golden rule 2), so the decoded audio stream is byte-identical across renders. An alpha
 * render (delivery/compositing) drops audio — the canonical muxed record is the default h264 mp4.
 * The `volume` prop is the hook for later ducking (music bed); narration plays at full volume now.
 */
const NarrationTrack: React.FC<{ cues: SceneIR['audio'] }> = ({ cues }) => (
  <>
    {(cues ?? [])
      .filter((cue) => cue.kind === 'narration' && typeof cue.src === 'string')
      .map((cue) => (
        <Sequence key={cue.id} from={cue.at} durationInFrames={Math.max(1, cue.duration_frames)} layout="none">
          <Audio src={resolveAudioUrl(cue.src as string)} />
        </Sequence>
      ))}
  </>
);

/**
 * The SFX track (A2). Each `kind:"sfx"` AudioCue is a one-shot Remotion <Audio> inside a
 * <Sequence from={cue.at}> placed at its EVENT frame on the global timeline (an element entrance or a
 * beat accent — lowered by the sfx pass). The wavs are FIXED, ffmpeg-synthesized files vendored into
 * assets/audio/ (golden rule 2), so the decoded stream is byte-identical across renders. Remotion muxes
 * every <Audio> together with the narration into one aac track — we never reimplement mixing (ADR-003).
 * Dropped on an alpha render, like narration (sfx belong to the finished film).
 */
const SfxTrack: React.FC<{ cues: SceneIR['audio'] }> = ({ cues }) => (
  <>
    {(cues ?? [])
      .filter((cue) => cue.kind === 'sfx' && typeof cue.src === 'string')
      .map((cue) => (
        <Sequence key={cue.id} from={cue.at} durationInFrames={Math.max(1, cue.duration_frames)} layout="none">
          <Audio src={resolveAudioUrl(cue.src as string)} />
        </Sequence>
      ))}
  </>
);

/** A narration window on the global timeline (start, end-exclusive) — what drives the music duck. */
interface DuckWindow {
  start: number;
  end: number;
}

/**
 * DUCK MATH (A3) — a PURE function of the GLOBAL frame → deterministic (golden rule 1). Returns the
 * `ducking` amount in [0,1]: 0 = no dip (the bed plays at `gain`), 1 = full dip (the bed drops to
 * `duck`). Linear `fade`-frame ramps ease the dip in BEFORE and out AFTER each narration window;
 * inside a window the dip is full (past its leading ramp). Overlapping windows take the MAX dip so the
 * bed stays ducked across back-to-back narration lines. Needs only the narration windows (no audio
 * analysis), so it is byte-deterministic.
 */
function duckingAt(frame: number, windows: readonly DuckWindow[], fade: number): number {
  let d = 0;
  for (const w of windows) {
    let amt = 0;
    if (frame >= w.start && frame < w.end) {
      amt = fade > 0 ? Math.min(1, (frame - w.start) / fade) : 1; // inside: full, eased-in
    } else if (fade > 0 && frame < w.start && frame >= w.start - fade) {
      amt = (frame - (w.start - fade)) / fade; // approaching: ramp 0→1
    } else if (fade > 0 && frame >= w.end && frame < w.end + fade) {
      amt = 1 - (frame - w.end) / fade; // leaving: ramp 1→0
    }
    if (amt > d) d = amt;
  }
  return d <= 0 ? 0 : d >= 1 ? 1 : d;
}

/**
 * The looped bed `<Audio>` for one `<Loop>` iteration. `<Loop>` tiles the (short) bed across the whole
 * timeline by wrapping each iteration in its own `<Sequence>` (resetting the local frame to 0), so the
 * GLOBAL frame for ducking is `iteration * loopFrames + localFrame` (recovered from `Loop.useLoop()` +
 * `useCurrentFrame()`). We compute the duck volume as a SCALAR for the current global frame (the
 * component re-renders every frame, so a plain number is exact + deterministic) — we do NOT use the
 * `<Audio volume>` CALLBACK form because inside a Loop its frame arg is the per-iteration media frame,
 * not the global timeline frame the narration windows live on.
 */
const LoopedDuckedBed: React.FC<{
  src: string;
  windows: readonly DuckWindow[];
  gain: number;
  duck: number;
  fade: number;
}> = ({ src, windows, gain, duck, fade }) => {
  const local = useCurrentFrame();
  const loop = Loop.useLoop();
  const globalFrame = (loop ? loop.iteration * loop.durationInFrames : 0) + local;
  const d = duckingAt(globalFrame, windows, fade);
  const volume = gain + (duck - gain) * d; // lerp(gain, duck, d)
  return <Audio src={src} volume={volume} />;
};

/**
 * The MUSIC BED track + DUCKING (A3, spec §12). A single `kind:"music"` AudioCue spans the whole
 * timeline. We never reimplement looping/mixing (ADR-003): the bed (a short loop) is tiled with the
 * Remotion `<Loop>` primitive and Remotion muxes it under the narration/sfx. The bed's volume DUCKS
 * (dips from `gain` to `duck`) while any narration cue overlaps the frame — computed per-frame in
 * {@link LoopedDuckedBed}. Sfx are short accents and do NOT duck the bed (only spoken narration does).
 * Dropped on an alpha render (music belongs to the finished film).
 */
const MusicTrack: React.FC<{ cues: SceneIR['audio'] }> = ({ cues }) => {
  const all = cues ?? [];
  const music = all.find((c) => c.kind === 'music' && typeof c.src === 'string');
  if (!music) return null;

  const windows: DuckWindow[] = all
    .filter((c) => c.kind === 'narration')
    .map((c) => ({ start: c.at, end: c.at + Math.max(1, c.duration_frames) }));

  const gain = music.mix?.gain ?? 0.5;
  const duck = music.mix?.duck ?? 0.18;
  const fade = Math.max(0, music.mix?.fade ?? 8);
  const src = resolveAudioUrl(music.src as string);
  const total = Math.max(1, music.duration_frames);
  // The bed's own loop length (frames); tile it across the timeline with <Loop>. If unknown, play once.
  const loopFrames = Math.max(1, music.loop_frames ?? total);

  const bed = (
    <LoopedDuckedBed src={src} windows={windows} gain={gain} duck={duck} fade={fade} />
  );

  return (
    <Sequence from={music.at} durationInFrames={total} layout="none">
      {loopFrames < total ? <Loop durationInFrames={loopFrames}>{bed}</Loop> : bed}
    </Sequence>
  );
};

/** One scene segment, rendered by the existing per-frame <Scene> compositor. `alpha` drops backdrops. */
const SceneSegment: React.FC<{ scene: SceneType; defs: SceneIR['defs']; alpha?: boolean | undefined }> = ({
  scene,
  defs,
  alpha,
}) => <Scene scene={scene} defs={defs} alpha={alpha} />;

/**
 * Render a full Scene IR as one continuous film: a background fill (so out-of-bounds parallax never
 * shows transparency) plus a TransitionSeries of every scene, with transitions between consecutive
 * scenes. The background colour is the palette `bg` token when present (spec §6.2), else transparent.
 */
export const SceneIRComposition: React.FC<SceneIRCompositionProps> = (props) => {
  const sceneIR = props;
  const { width, height } = useVideoConfig();
  // P3 (alpha): a transparent render omits the opaque background fill (else every pixel is opaque and
  // the PNG/codec carries no alpha). The `_alpha` hint is a render-time prop, not persisted to the IR.
  const alpha = props._alpha === true;
  const bg = alpha ? undefined : sceneIR.defs.palette?.['bg'];
  const scenes = sceneIR.scenes;
  const smoothEasing = smoothEasingFor(sceneIR.defs.easings ?? {});

  // Build the TransitionSeries children: for each scene a `.Sequence` (length = its duration_frames),
  // preceded — for every scene after the first whose `transition_in` is a real (non-`cut`)
  // transition — by a `.Transition` of that scene's overlap, presented per its `kind` (resolved via
  // the engine transitions registry). A `cut` / no transition_in emits no `.Transition`, so the two
  // segments butt together (a hard cut).
  const children: React.ReactNode[] = [];
  scenes.forEach((scene, i) => {
    if (i > 0) {
      const tIn = scene.transition_in;
      const overlap = transitionOverlap(tIn);
      if (tIn && overlap > 0) {
        children.push(
          <TransitionSeries.Transition
            key={`t-${scene.id}`}
            presentation={presentationFor(tIn, width, height)}
            timing={linearTiming({
              durationInFrames: overlap,
              easing: smoothEasing,
            })}
          />
        );
      }
    }
    children.push(
      <TransitionSeries.Sequence
        key={scene.id}
        durationInFrames={scene.duration_frames}
        layout="none"
      >
        <SceneSegment scene={scene} defs={sceneIR.defs} alpha={alpha} />
      </TransitionSeries.Sequence>
    );
  });

  return (
    <AbsoluteFill style={bg ? { backgroundColor: bg } : undefined}>
      <TransitionSeries>{children}</TransitionSeries>
      {/* Music bed (A3): one looping <Audio> under the whole film, ducked per-frame while narration
          speaks. Rendered first so it sits beneath narration/sfx in the mix. Dropped on alpha. */}
      {!alpha && <MusicTrack cues={sceneIR.audio} />}
      {/* Narration track (M3): <Audio> cues muxed by Remotion. Dropped on an alpha (compositing) render
          — the canonical muxed record is the default h264 mp4 (audio belongs to the finished film). */}
      {!alpha && <NarrationTrack cues={sceneIR.audio} />}
      {/* SFX track (A2): event-anchored one-shot sound effects, muxed by Remotion. Dropped on alpha. */}
      {!alpha && <SfxTrack cues={sceneIR.audio} />}
      {/* Caption track (A1): narration-synced on-screen subtitles, derived from the same cues. Dropped
          on an alpha render — captions belong to the finished film, like the narration track. */}
      {!alpha && <CaptionTrack captions={sceneIR.captions} />}
    </AbsoluteFill>
  );
};

export default SceneIRComposition;
