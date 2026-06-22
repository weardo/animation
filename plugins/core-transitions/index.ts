// core-transitions — the built-in scene-boundary transitions, shipped AS A PLUGIN (ADR-005 "families
// are sockets; plugins are plugs"; ADR-003 "don't reimplement a Remotion primitive"). It contributes
// every transition presentation into the engine's generic `transitions` extension point via
// `api.registerTransition`. The ENGINE owns only the generic registry + the TransitionImpl contract
// (no domain knowledge of any specific transition); the core Composition.tsx resolves a scene's
// `transition_in.kind` THROUGH this registry instead of a hardcoded switch (the C4 close-the-stub).
//
// "Our families are sockets; free libraries are plugs" (ADR-003): instead of inventing a transition
// engine we adopt the Tier-A, deterministic, disk-safe `@remotion/transitions` catalog for the DOM
// presets (fade / wipe / slide / iris — never reimplemented), and author the remaining kinds as small
// custom `TransitionPresentation`s (presentations.tsx) using native SVG masks + flubber:
//   • fade  → @remotion/transitions `fade()`
//   • wipe  → @remotion/transitions `wipe({direction})`
//   • slide → @remotion/transitions `slide({direction})`
//   • iris  → @remotion/transitions `iris({width,height})`            (was falling back to fade)
//   • mask  → CUSTOM: a soft-edged SVG radial mask REVEAL of the entering scene  (was fade)
//   • morph-match / match-cut → CUSTOM: a flubber-morphed SHARED-ELEMENT shape bridging the cut over a
//                              crossfade (the `from`/`to`/`tint` path passthrough params)  (was fade)
//   • camera-continuous → CUSTOM: a continuous camera push (both scenes share one uninterrupted
//                         translate+scale through the boundary, reading as one move)  (was fade)
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring. Each TransitionImpl.build is a pure
// function of its context (the IR transition + frame box). The presentation components are pure fns of
// `presentationProgress` (a pure fn of frame, timed by the compositor's linearTiming + StyleKit
// easing) — no clock, no RNG. SVG masks + flubber are frame-deterministic on the CPU raster default.

import { type TransitionPresentation } from '@remotion/transitions';
import { fade } from '@remotion/transitions/fade';
import { wipe, type WipeDirection } from '@remotion/transitions/wipe';
import { slide, type SlideDirection } from '@remotion/transitions/slide';
import { iris } from '@remotion/transitions/iris';
import type {
  EngineAPI,
  Plugin,
  TransitionImpl,
  TransitionBuildContext,
} from '../../src/engine/index.js';
import type { Transition } from '../../src/ir/index.js';
import { parseManifest } from '../../src/engine/index.js';
import { maskPresentation, matchPresentation, cameraPresentation } from './presentations.js';
import manifestJson from './plugin.json' with { type: 'json' };

const manifest = parseManifest(manifestJson);

// A presentation typed loosely for the registry (the compositor treats every presentation uniformly).
type LoosePresentation = TransitionPresentation<Record<string, unknown>>;
const loose = <P extends Record<string, unknown>>(p: TransitionPresentation<P>): LoosePresentation =>
  p as unknown as LoosePresentation;

// ---------------------------------------------------------------------------------------------------
// Direction mapping (IR left/right/up/down → @remotion/transitions wipe/slide directions)
// ---------------------------------------------------------------------------------------------------

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

/** Read a string passthrough param off the loose IR transition (e.g. a `from`/`to` path `d`). */
function strParam(t: Transition, key: string): string | undefined {
  const v = (t as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

// ---------------------------------------------------------------------------------------------------
// Default shared-element silhouettes for a match-cut with no authored `from`/`to` paths: a circle
// (200u box) morphing into a rounded square — gives the morph something to deform between by default.
// ---------------------------------------------------------------------------------------------------
const DEFAULT_FROM_D = 'M100,0 A100,100 0 1 1 100,200 A100,100 0 1 1 100,0 Z';
const DEFAULT_TO_D =
  'M20,0 L180,0 Q200,0 200,20 L200,180 Q200,200 180,200 L20,200 Q0,200 0,180 L0,20 Q0,0 20,0 Z';

// ---------------------------------------------------------------------------------------------------
// The TransitionImpl table this plugin contributes (keys MUST match Scene-IR `transition_in.kind`).
// Each `build` is a pure (ctx) → @remotion/transitions presentation. DOM presets reuse the library;
// mask / morph-match / match-cut / camera-continuous are the custom presentations (presentations.tsx).
// ---------------------------------------------------------------------------------------------------

const fadeImpl: TransitionImpl = {
  build: () => loose(fade()),
};

const wipeImpl: TransitionImpl = {
  build: ({ transition }: TransitionBuildContext) =>
    loose(wipe({ direction: wipeDirection(transition.dir) })),
};

const slideImpl: TransitionImpl = {
  build: ({ transition }: TransitionBuildContext) =>
    loose(slide({ direction: slideDirection(transition.dir) })),
};

const irisImpl: TransitionImpl = {
  build: ({ width, height }: TransitionBuildContext) => loose(iris({ width, height })),
};

const maskImpl: TransitionImpl = {
  build: ({ width, height }: TransitionBuildContext) => loose(maskPresentation({ width, height })),
};

const matchImpl: TransitionImpl = {
  build: ({ width, height, transition }: TransitionBuildContext) =>
    loose(
      matchPresentation({
        width,
        height,
        fromD: strParam(transition, 'from') ?? DEFAULT_FROM_D,
        toD: strParam(transition, 'to') ?? DEFAULT_TO_D,
        tint: strParam(transition, 'tint') ?? '#ffffff',
      }),
    ),
};

const cameraImpl: TransitionImpl = {
  build: ({ width, height, transition }: TransitionBuildContext) =>
    loose(cameraPresentation({ width, height, dir: transition.dir ?? 'left' })),
};

/** kind → impl. `cut` is NOT registered: the compositor handles a hard cut by emitting no Transition. */
export const CORE_TRANSITIONS: Readonly<Record<string, TransitionImpl>> = {
  fade: fadeImpl,
  wipe: wipeImpl,
  slide: slideImpl,
  iris: irisImpl,
  mask: maskImpl,
  'morph-match': matchImpl,
  'match-cut': matchImpl,
  'camera-continuous': cameraImpl,
};

/** The core-transitions plugin: registers every built-in transition under its Scene-IR kind. */
export const coreTransitionsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    for (const [kind, impl] of Object.entries(CORE_TRANSITIONS)) {
      api.registerTransition(kind, impl);
    }
  },
};

export default coreTransitionsPlugin;
