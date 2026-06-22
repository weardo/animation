// StyleKit (render side) — the easing HELPER fns + the NEUTRAL fallback (ADR-008 I2/I3).
//
// ADR-008 I2/I3: the STYLE is DATA, not core code. The PURE schema + types live in the IR layer
// (`src/ir/stylekit.ts`, no remotion dependency); this module adds the RENDER-side concerns:
//   1. Re-export the StyleKit schema/types from the IR (one source of truth).
//   2. The easing HELPER fns (`easingFn`/`bezierFn`) that resolve a cubic-bezier tuple / curve NAME
//      to a Remotion `Easing.bezier` function — calling the Remotion PRIMITIVE, never reimplementing.
//   3. A minimal NEUTRAL fallback (`NEUTRAL_STYLEKIT`): generic greys + standard easings + the floor
//      OFF. NO Kurzgesagt-specific hex (#ffcf4d / #0d1b33 / …) or magic liveness numbers live here.
//
// The actual VALUES — the Kurzgesagt look + a `plain` flat look — live as DATA in
// `library/stylekits/*.json`, resolved by the lowering pass through the Library and carried in the
// Scene IR as `defs.stylekit`. Render-time reads style from `defs.stylekit` (props/context), NOT from
// core constants, so the engine specializes in NO look.
//
// PURE + DETERMINISTIC (CLAUDE.md golden rule 1): only re-exports, pure helpers, and a frozen
// constant. No `Date.now`, no `Math.random`, no wall-clock.

import { Easing } from 'remotion';
import {
  StyleKitSchema,
  type StyleKit,
  type StyleEasingDef,
  type CubicBezier,
} from '../ir/stylekit.js';

// Re-export the IR-owned schema + every stylekit type so render-side consumers import from one place.
export {
  StyleKitSchema,
  StyleEasingDefSchema,
  CubicBezierSchema,
  SpringConfigSchema,
  IdleSchema,
  BreathingSchema,
  BlinkSchema,
  StaggerSchema,
  ParallaxSchema,
  StyleMotionSchema,
  StyleLightSchema,
  StyleShadingSchema,
  FloorSchema,
} from '../ir/stylekit.js';
export type {
  StyleKit,
  StyleEasingDef,
  CubicBezier,
  SpringConfig,
  Idle,
  Breathing,
  Blink,
  Stagger,
  Parallax,
  StyleMotion,
  StyleLight as Light,
  StyleShading as ShadingSpec,
  Floor,
} from '../ir/stylekit.js';

// A resolved easing function: maps a normalized progress t∈[0,1] → eased value (often outside
// [0,1] for overshoot curves). This is the shape Remotion's `interpolate({ easing })` expects.
export type EasingFunction = (t: number) => number;

/** Parse + validate an opaque stylekit JSON document into a typed {@link StyleKit}. Throws on invalid. */
export function parseStyleKit(raw: unknown): StyleKit {
  return StyleKitSchema.parse(raw);
}

// ---------------------------------------------------------------------------------------------
// Easing helpers — resolve an `EasingDef` to a Remotion easing function. These call the Remotion
// `Easing.bezier` PRIMITIVE (never reimplement it). The `easings` TABLE they resolve names against
// is the Scene-IR `defs.easings` (seeded from the selected stylekit), passed by callers.
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a cubic-bezier tuple to a Remotion `EasingFunction`. The single place a bezier curve
 * becomes a usable easing function — via the Remotion `Easing.bezier` primitive (ADR-003).
 */
export function bezierFn(def: CubicBezier): EasingFunction {
  const [x1, y1, x2, y2] = def;
  return Easing.bezier(x1, y1, x2, y2);
}

/**
 * Resolve an easing definition to a Remotion `EasingFunction` usable by `interpolate({ easing })`.
 *
 * Accepts the Scene-IR `EasingDef` shapes against an OPTIONAL name table (the scene's
 * `defs.easings`):
 *   - a cubic-bezier tuple `[x1,y1,x2,y2]`            → `Easing.bezier(...)`
 *   - a known curve NAME present in `table`           → resolved (recursively) via the table
 *
 * Pure: same input ⇒ same function behavior. Throws on an unknown name so a typo can never silently
 * fall back to linear motion (spec §9). Without a table, names cannot resolve (only tuples do).
 */
export function easingFn(
  def: CubicBezier | string,
  table?: Record<string, StyleEasingDef> | undefined,
): EasingFunction {
  if (typeof def === 'string') {
    const resolved = table?.[def];
    if (resolved === undefined) {
      const known = table ? Object.keys(table).join(', ') : '<no easing table provided>';
      throw new Error(`Unknown easing name "${def}". Known: ${known}.`);
    }
    // A named curve may alias another name; resolve recursively (cycles fail via a missing key).
    if (typeof resolved === 'string') return easingFn(resolved, table);
    return bezierFn(resolved as CubicBezier);
  }
  return bezierFn(def);
}

/** Unit light vector in screen space (y-down). Points TOWARD the light source. */
export function lightVector(dir: number): { x: number; y: number } {
  const r = (dir * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

// ---------------------------------------------------------------------------------------------
// NEUTRAL fallback — a minimal, STYLE-CLEAN stylekit used when no library stylekit resolves
// (standalone lowering with no Library). Generic greys + standard CSS easings + the floor OFF.
// NO Kurzgesagt hex / magic liveness numbers (those are DATA in library/stylekits/kurzgesagt.json).
// ---------------------------------------------------------------------------------------------

/**
 * The neutral fallback stylekit. Deliberately plain: greyscale palette, the standard cubic-bezier
 * easings every CSS engine ships, a single calm spring, zero-amplitude liveness, and the quality
 * FLOOR fully OFF. This is what a story gets when no stylekit can be resolved — a runnable, generic
 * baseline with no house-style opinion. The Kurzgesagt opinion lives in DATA.
 */
export const NEUTRAL_STYLEKIT: StyleKit = Object.freeze({
  easings: {
    linear: [0, 0, 1, 1],
    smooth: [0.25, 0.1, 0.25, 1], // CSS "ease"
    easeIn: [0.42, 0, 1, 1],
    easeOut: [0, 0, 0.58, 1],
    easeInOut: [0.42, 0, 0.58, 1],
  },
  defaultEasings: {
    linear: [0, 0, 1, 1],
    smooth: [0.25, 0.1, 0.25, 1],
    easeIn: [0.42, 0, 1, 1],
    easeOut: [0, 0, 0.58, 1],
    easeInOut: [0.42, 0, 0.58, 1],
    pop: 'smooth',
  },
  palette: {
    bg: '#202020',
    bg2: '#2c2c2c',
    accent: '#808080',
    accent2: '#a0a0a0',
    ink: '#101010',
    light: '#e0e0e0',
    shadow: '#000000',
  },
  motion: {
    spring: { stiffness: 100, damping: 20, mass: 1 },
    springHeavy: { stiffness: 100, damping: 20, mass: 1 },
    springBouncy: { stiffness: 100, damping: 20, mass: 1 },
    idle: {
      swayAmplitudeDeg: 0,
      swaySpeedHz: 0,
      driftAmplitudePx: 0,
      driftSpeedHz: 0,
      saccadeAmplitudeDeg: 0,
      saccadeMeanSeconds: 1,
    },
    breathing: { amplitude: 0, periodSeconds: 4 },
    blink: { rateHz: 0, closeFrames: 0 },
    stagger: { offsetFrames: 0 },
    parallax: { nearFactor: 1, farFactor: 1 },
    motionBlurShutter: 180,
  },
  light: {
    dir: 270,
    elevation: 90,
    color: '#e0e0e0',
    intensity: 0,
    ambient: 1,
  },
  shading: {
    form: false,
    contact_shadow: false,
    rim: 0,
    ao: false,
    glow: 0,
  },
  floor: {
    liveness: false,
    parallax: false,
    shading: false,
    nonLinearMotion: false,
  },
});
