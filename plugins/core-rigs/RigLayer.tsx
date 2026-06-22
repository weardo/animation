// <RigLayer> — the Remotion compositor entry point for a Scene-IR `rig` layer. Spec §8, §8.1 (M1).
//
// Renders an identity-stable DragonBones character via Pixi v8 + pixi-dragonbones-runtime, using the
// EXACT spike-proven determinism technique (spec §14.1, retired risk):
//
//   1. Init Pixi + DragonBones ONCE, cached in refs across frames (autoStart:false, sharedTicker:
//      false, ticker.stop()). Mount the Pixi canvas into the DOM. Gated by delayRender so Remotion
//      waits for the async init before screenshotting frame 0.
//   2. Each frame:
//        a. ABSOLUTE-SEEK the active clip's AnimationState: state.currentTime = (frame - at)/fps.
//           The setter wraps looping internally and is render-order-independent (NOT incremental
//           advanceTime(dt)).
//        b. armature.advanceTime(0) to FLUSH bone/slot/mesh (FFD) transforms to the seeked pose.
//        c. Apply StyleKit "alive" overlays deterministically: damped-spring head-bob, breathing,
//           seeded idle sway (bone offsets) + Poisson blink (eye-slot visibility). Re-flush.
//        d. app.render() exactly once.
//        e. requestAnimationFrame(() => continueRender(handle)) so the canvas paint is committed
//           before Remotion screenshots (releasing synchronously risks a stale/blank frame).
//   3. The whole canvas is wrapped in a transform div driven by the layer's Scene-IR `transform`
//      `{a,k}` channels (position/scale/rotation/opacity), evaluated with StyleKit easing.
//
// DETERMINISM (CLAUDE.md r.1): no Date.now / Math.random anywhere. All motion is a pure function of
// `useCurrentFrame()` (+ the layer seed). The Pixi clock never runs. Liveness uses Remotion seeded
// `random` + seeded simplex noise. Two renders of the same frame are byte-identical (spike result).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AbsoluteFill,
  continueRender,
  delayRender,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type { Easings, RigDef, RigLayer as RigLayerIR } from '../../src/ir/index.js';
import { loadRig, disposeRig, type LoadedRig, type RigSources } from './dragonbones-loader.js';
import { selectClip } from './clips.js';
import {
  headBob,
  breathing,
  idleSway,
  addOffsets,
  blinkSchedule,
  isBlinking,
  type BlinkEvent,
  type BoneOffset,
  ZERO_OFFSET,
} from './liveness.js';
import { evalNumber, evalVec2 } from './animated-eval.js';

// ----------------------------------------------------------------------------------------------
// Bone/slot name conventions. DragonBones rigs vary; these are the names <RigLayer> LOOKS FOR and
// applies overlays to when present. Missing bones/slots are skipped silently (a rig need not have
// every one). Overridable per layer via `liveness.bones` (reserved for tuning later).
// ----------------------------------------------------------------------------------------------

const DEFAULT_HEAD_BONES = ['head', 'neck', 'Head'];
const DEFAULT_BODY_BONES = ['body', 'torso', 'chest', 'spine', 'Body'];
const DEFAULT_ROOT_BONES = ['root', 'Root', 'armatureRoot'];
const DEFAULT_EYE_SLOTS = ['eye', 'eyes', 'eyeL', 'eyeR', 'eye_l', 'eye_r'];

export interface RigLayerProps {
  /** The Scene-IR rig layer ({ ref, transform?, rig_state, … }). */
  layer: RigLayerIR;
  /** The resolved rig definition (defs.rigs[layer.ref]) — the DragonBones JSON ref. */
  rigDef: RigDef;
  /** Scene `defs.easings` so transform keyframes resolve their `e` names (never linear). */
  easings?: Easings | undefined;
  /**
   * Explicit rig file sources. If omitted, the three files are derived from `rigDef.uri`'s base
   * name: `<base>_ske.json`, `<base>_tex.json`, `<base>_tex.png`, resolved via `staticFile`.
   */
  sources?: RigSources | undefined;
  /** Override the armature name to build (else the skeleton's first armature). */
  armatureName?: string | undefined;
}

/**
 * Derive the three DragonBones file URLs from a rig `uri`.
 * Convention: `rig://<base>.dbones.json` (or any `<base>.*`) → `<base>_ske.json` / `<base>_tex.json`
 * / `<base>_tex.png`, each resolved through Remotion `staticFile` so they load from `public/`.
 */
export function deriveSources(uri: string): RigSources {
  // strip a `scheme://` prefix and any extension after the base token.
  const noScheme = uri.includes('://') ? uri.slice(uri.indexOf('://') + 3) : uri;
  const fileName = noScheme.split('/').pop() ?? noScheme;
  const base = fileName.replace(/\.(dbones|ske)?\.?json$/i, '').replace(/\.[^.]+$/, '');
  const dir = noScheme.includes('/') ? noScheme.slice(0, noScheme.lastIndexOf('/') + 1) : '';
  return {
    skeletonUrl: staticFile(`${dir}${base}_ske.json`),
    atlasUrl: staticFile(`${dir}${base}_tex.json`),
    textureUrl: staticFile(`${dir}${base}_tex.png`),
  };
}

export const RigLayer: React.FC<RigLayerProps> = ({
  layer,
  rigDef,
  easings,
  sources,
  armatureName,
}) => {
  const frame = useCurrentFrame();
  const { fps, width, height, durationInFrames } = useVideoConfig();

  const containerRef = useRef<HTMLDivElement | null>(null);
  const rigRef = useRef<LoadedRig | null>(null);
  // delayRender handle for the one-time async init (held until the rig is mounted & first-rendered).
  const [initHandle] = useState(() =>
    delayRender(`RigLayer:init:${layer.id}`),
  );

  const easingTable: Easings = easings ?? {};

  // A stable per-layer string seed for all deterministic liveness (CLAUDE.md r.1).
  const seed = useMemo(() => `rig:${layer.id}:${rigDef.uri}`, [layer.id, rigDef.uri]);

  // Pre-compute the deterministic Poisson blink schedule for the whole scene span. Pure function of
  // (durationInFrames, fps, seed) → identical every render.
  const blinks: BlinkEvent[] = useMemo(
    () => blinkSchedule(durationInFrames, fps, seed),
    [durationInFrames, fps, seed],
  );

  const resolvedSources: RigSources = useMemo(
    () => ({
      ...(sources ?? deriveSources(rigDef.uri)),
      ...(armatureName !== undefined ? { armatureName } : {}),
    }),
    [sources, rigDef.uri, armatureName],
  );

  // ---- one-time init (mount Pixi canvas, build armature) ----
  useEffect(() => {
    let cancelled = false;
    const el = containerRef.current;
    if (!el) return;

    loadRig(resolvedSources, width, height)
      .then((rig) => {
        if (cancelled) {
          disposeRig(rig);
          return;
        }
        rigRef.current = rig;
        el.appendChild(rig.app.canvas as HTMLCanvasElement);
        // Render the very first frame's pose before releasing init, so frame 0 is never blank.
        applyFrame(rig, 0);
        if (!cancelled) continueRender(initHandle); // synchronous; preserveDrawingBuffer keeps the pose
      })
      .catch((err: unknown) => {
        // Surface the failure to Remotion instead of hanging on the delayRender.
        // eslint-disable-next-line no-console
        console.error(`RigLayer ${layer.id} init failed:`, err);
        continueRender(initHandle);
      });

    return () => {
      cancelled = true;
      if (rigRef.current) {
        disposeRig(rigRef.current);
        rigRef.current = null;
      }
    };
    // Init depends only on the rig identity + canvas size; frame-driven work happens in the second
    // effect. Deliberately excludes `frame`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedSources, width, height]);

  // ---- per-frame seek + overlays + render, gated by delayRender ----
  useEffect(() => {
    const rig = rigRef.current;
    if (!rig) return; // not yet initialized; the init effect handles frame 0.
    const handle = delayRender(`RigLayer:frame:${layer.id}:${frame}`);
    applyFrame(rig, frame);
    // Synchronous release: with preserveDrawingBuffer:true the rendered buffer persists until the next
    // render(), so Remotion's screenshot reads correct pixels whenever it fires — no rAF timing race.
    // (rAF gating interacts badly with Remotion's controlled frame clock → non-determinism.)
    continueRender(handle);
    // The next frame's effect supersedes this one; no cleanup needed beyond the rAF release above.
  });

  /**
   * Apply a single frame to a loaded rig: absolute-seek the active clip, flush, apply liveness
   * overlays, flush again, render once. Pure given (rig, f) + the captured deterministic inputs.
   */
  function applyFrame(rig: LoadedRig, f: number): void {
    const { armature } = rig;

    // (a) Absolute-seek the active clip. Ensure the animation is the one playing, then set time.
    const seek = selectClip(layer.rig_state.clips, f, fps);
    const anim = armature.animation;
    if (anim.lastAnimationState?.name !== seek.anim) {
      // Start the target animation (playTimes 0 = loop; the absolute-seek time drives the actual
      // pose, so this just establishes the active state). Non-loop clips still seek absolutely and
      // hold via the currentTime clamp below.
      anim.play(seek.anim, seek.loop ? 0 : 1);
    }
    const state = anim.getState(seek.anim);
    if (state) {
      // The setter wraps looping internally; for non-loop we let it clamp at the end naturally.
      state.currentTime = seek.time;
    }

    // (b) Flush the seeked pose (recomputes bone + slot + mesh/FFD transforms).
    armature.advanceTime(0);

    // (c) StyleKit "alive" overlays (deterministic). Bone offsets are additive nudges on TOP of the
    // seeked pose; blink toggles eye-slot visibility.
    const head = addOffsets(headBob(f, fps, seed), idleSway(f, fps, seed));
    const body = breathing(f, fps);
    applyBoneOffset(rig, DEFAULT_HEAD_BONES, head);
    applyBoneOffset(rig, DEFAULT_BODY_BONES, body);
    applyBoneOffset(rig, DEFAULT_ROOT_BONES, idleSway(f, fps, `${seed}:root`));
    applyBlink(rig, isBlinking(blinks, f));

    // Re-flush so the overlay bone offsets propagate to slots/mesh before rendering.
    armature.advanceTime(0);

    // (d) Render exactly once.
    rig.app.render();
  }

  // ---- compute the layer transform (Scene-IR `{a,k}` channels) for this frame ----
  const t = layer.transform;
  const [px, py] = evalVec2(t?.position, frame, easingTable, [width / 2, height / 2]);
  const scalePct = evalNumber(t?.scale, frame, easingTable, 100);
  const rotationDeg = evalNumber(t?.rotation, frame, easingTable, 0);
  const opacityPct = evalNumber(t?.opacity, frame, easingTable, 100);

  // The Pixi canvas fills the composition; we offset/scale/rotate the canvas as a unit so the
  // armature follows the Scene-IR transform. The canvas's internal origin is the composition center
  // by construction (the armature is positioned in armature space within the same-size canvas).
  const wrapperStyle: React.CSSProperties = {
    position: 'absolute',
    left: 0,
    top: 0,
    width,
    height,
    opacity: opacityPct / 100,
    transform: [
      `translate(${px - width / 2}px, ${py - height / 2}px)`,
      `rotate(${rotationDeg}deg)`,
      `scale(${scalePct / 100})`,
    ].join(' '),
    transformOrigin: 'center center',
  };

  return (
    <AbsoluteFill data-rig-layer={layer.id}>
      <div ref={containerRef} style={wrapperStyle} />
    </AbsoluteFill>
  );
};

// ----------------------------------------------------------------------------------------------
// Bone/slot overlay helpers (operate on the live armature). Missing bones/slots are skipped.
// ----------------------------------------------------------------------------------------------

/** Reset then set the additive `offset` on the FIRST matching bone (so overlays don't accumulate). */
function applyBoneOffset(rig: LoadedRig, candidates: readonly string[], off: BoneOffset): void {
  for (const name of candidates) {
    const bone = rig.armature.getBone(name);
    if (bone) {
      bone.offset.x = off.x;
      bone.offset.y = off.y;
      bone.offset.rotation = off.rotation;
      bone.invalidUpdate();
      return; // only the first match in the candidate list
    }
  }
}

/** Toggle eye-slot visibility for a blink. No-op if the rig has no recognized eye slots. */
function applyBlink(rig: LoadedRig, closed: boolean): void {
  for (const name of DEFAULT_EYE_SLOTS) {
    const slot = rig.armature.getSlot(name);
    if (slot) slot.visible = !closed;
  }
}

export { ZERO_OFFSET };
export default RigLayer;
