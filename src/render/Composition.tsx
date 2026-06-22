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
//   • A scene's `transition_in.kind` maps to a preset: fade → fade(), wipe → wipe({direction}),
//     slide → slide({direction}). Kinds without a dedicated @remotion/transitions preset
//     (iris/mask/morph-match/match-cut/camera-continuous) fall back to `fade()` for now (those land
//     in later milestones as SVG-mask / flubber / shared-element compositors). A `cut` (or no
//     transition_in) is a plain hard cut — NO `.Transition` is emitted, the segments butt together.
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
// and all per-frame motion lives in <Scene> and the sub-renderers via `useCurrentFrame()`. No
// Date.now / Math.random; the transition easing is a fixed StyleKit cubic-bezier.

import React from 'react';
import { AbsoluteFill, Easing } from 'remotion';
import {
  TransitionSeries,
  linearTiming,
  type TransitionPresentation,
} from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { wipe, type WipeDirection } from '@remotion/transitions/wipe';
import { slide, type SlideDirection } from '@remotion/transitions/slide';
import type { SceneIR, Scene as SceneType, Transition, Easings } from '../ir/index.js';
import { Scene } from './Scene.js';
import { easingFn } from './stylekit.js';

export type SceneIRCompositionProps = SceneIR;

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

/** Map the IR transition `dir` (left/right/up/down) to a @remotion/transitions wipe direction. */
function wipeDirection(dir: Transition['dir']): WipeDirection {
  switch (dir) {
    case 'left':
      return 'from-left';
    case 'right':
      return 'from-right';
    case 'up':
      return 'from-top';
    case 'down':
      return 'from-bottom';
    default:
      return 'from-left';
  }
}

/** Map the IR transition `dir` to a @remotion/transitions slide direction. */
function slideDirection(dir: Transition['dir']): SlideDirection {
  switch (dir) {
    case 'left':
      return 'from-left';
    case 'right':
      return 'from-right';
    case 'up':
      return 'from-top';
    case 'down':
      return 'from-bottom';
    default:
      return 'from-right';
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
 * Build the @remotion/transitions presentation for a scene's `transition_in.kind`. fade/wipe/slide
 * use their dedicated presets; every other (later-milestone) kind falls back to fade for now.
 */
function presentationFor(t: Transition): TransitionPresentation<Record<string, unknown>> {
  let p: TransitionPresentation<Record<string, unknown>>;
  switch (t.kind) {
    case 'fade':
      p = fade() as TransitionPresentation<Record<string, unknown>>;
      break;
    case 'wipe':
      p = wipe({ direction: wipeDirection(t.dir) }) as TransitionPresentation<
        Record<string, unknown>
      >;
      break;
    case 'slide':
      p = slide({ direction: slideDirection(t.dir) }) as TransitionPresentation<
        Record<string, unknown>
      >;
      break;
    // iris / mask / morph-match / match-cut / camera-continuous: no dedicated preset yet — fall
    // back to a fade so the boundary still reads as a transition (proper compositors land later).
    default:
      p = fade() as TransitionPresentation<Record<string, unknown>>;
  }
  return p;
}

/** One scene segment, rendered by the existing per-frame <Scene> compositor. */
const SceneSegment: React.FC<{ scene: SceneType; defs: SceneIR['defs'] }> = ({
  scene,
  defs,
}) => <Scene scene={scene} defs={defs} />;

/**
 * Render a full Scene IR as one continuous film: a background fill (so out-of-bounds parallax never
 * shows transparency) plus a TransitionSeries of every scene, with transitions between consecutive
 * scenes. The background colour is the palette `bg` token when present (spec §6.2), else transparent.
 */
export const SceneIRComposition: React.FC<SceneIRCompositionProps> = (props) => {
  const sceneIR = props;
  const bg = sceneIR.defs.palette?.['bg'];
  const scenes = sceneIR.scenes;
  const smoothEasing = smoothEasingFor(sceneIR.defs.easings ?? {});

  // Build the TransitionSeries children: for each scene a `.Sequence` (length = its duration_frames),
  // preceded — for every scene after the first whose `transition_in` is a real (non-`cut`)
  // transition — by a `.Transition` of that scene's overlap, presented per its `kind`. A `cut` / no
  // transition_in emits no `.Transition`, so the two segments butt together (a hard cut).
  const children: React.ReactNode[] = [];
  scenes.forEach((scene, i) => {
    if (i > 0) {
      const tIn = scene.transition_in;
      const overlap = transitionOverlap(tIn);
      if (tIn && overlap > 0) {
        children.push(
          <TransitionSeries.Transition
            key={`t-${scene.id}`}
            presentation={presentationFor(tIn)}
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
        <SceneSegment scene={scene} defs={sceneIR.defs} />
      </TransitionSeries.Sequence>
    );
  });

  return (
    <AbsoluteFill style={bg ? { backgroundColor: bg } : undefined}>
      <TransitionSeries>{children}</TransitionSeries>
    </AbsoluteFill>
  );
};

export default SceneIRComposition;
