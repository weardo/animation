// StyleKit — the Kurzgesagt "house style" as shared, tunable constants. Spec §9 (+ §6.2, §8).
//
// This module is PURE and DETERMINISTIC: it exports only constants and pure functions of their
// inputs. No `Date.now`, no `Math.random`, no wall-clock, no frame side effects. Other modules
// (the lowering pass, the compositor, rigs, generators) consume these so that "quality is a
// consistent, tunable constant rather than per-scene hand-tuning" — the quality FLOOR, not an
// upgrade. A plainly-authored scene already comes out polished because these defaults apply.
//
// Three exports families, matching spec §9:
//   1. EASINGS / DEFAULT_EASINGS / easingFn — the curated, never-linear easing library
//      (anticipation + overshoot). Curves are expressed as cubic-bezier tuples [x1,y1,x2,y2],
//      which is exactly the Scene IR `EasingDef` canonical form (src/ir/scene.ts), and are
//      resolved to Remotion easing functions (usable by `interpolate`) via `Easing.bezier`.
//   2. DEFAULT_PALETTE — the default palette token set (a limited, premium per-scene palette).
//   3. MOTION_DEFAULTS — idle/breathing params, Poisson blink rate, spring stiffness/damping,
//      stagger, parallax, and the motion-blur shutter default.
//
// SCOPE: M1. No audio, no effects/post stack, no morph — only the motion + look constants M1 and
// the IR's `defs.easings` / `defs.palette` need. Later milestones extend these tables in place.

import { Easing } from 'remotion';

// A cubic-bezier easing curve as control-point tuple [x1, y1, x2, y2] — the Scene IR `EasingDef`
// canonical form. Usable directly by Remotion `Easing.bezier(...)` and thus by `interpolate`.
export type CubicBezier = readonly [number, number, number, number];

// A resolved easing function: maps a normalized progress t∈[0,1] → eased value (often outside
// [0,1] for overshoot curves). This is the shape Remotion's `interpolate({ easing })` expects.
export type EasingFunction = (t: number) => number;

// ---------------------------------------------------------------------------------------------
// 1. Easing library — curated Kurzgesagt curves. Snappy, never linear, with anticipation +
//    overshoot. All are cubic-bezier tuples so they round-trip into the IR's `defs.easings`.
// ---------------------------------------------------------------------------------------------

/**
 * Named easing curves as cubic-bezier control tuples. These are the building blocks; the default
 * token set (`DEFAULT_EASINGS`) maps short StyleKit names (used by the IR `e` field) onto these.
 *
 * NOTE: cubic-bezier control points cannot express true overshoot beyond the [0,1] *output*
 * range with arbitrary magnitude, but standard "back"/overshoot beziers (y2 > 1 or y1 < 0)
 * give the anticipation/overshoot read Kurzgesagt motion relies on. Spring-style overshoot that
 * a bezier can't express is handled by `MOTION_DEFAULTS.spring` via Remotion `spring()`.
 */
export const EASINGS = {
  /** Linear — provided ONLY as an explicit escape hatch; never a default (spec §9: no accidental linear). */
  linear: [0, 0, 1, 1],
  /** Gentle symmetric ease-in-out — camera moves, ambient drifts. The workhorse "smooth". */
  smooth: [0.4, 0, 0.2, 1],
  /** Standard ease-out — decelerate into rest. */
  easeOut: [0, 0, 0.2, 1],
  /** Standard ease-in — accelerate from rest. */
  easeIn: [0.4, 0, 1, 1],
  /** Snappy ease-out with a touch of pace — UI-style "quick settle". */
  snappy: [0.25, 0.1, 0.25, 1],
  /** Anticipate then go — slight pull-back before moving (back-in). */
  anticipate: [0.36, 0, 0.66, -0.56],
  /** Overshoot then settle — the Kurzgesagt "pop" entrance (back-out). */
  backOut: [0.34, 1.56, 0.64, 1],
  /** Anticipate + overshoot — pull back, launch, overshoot, settle (back-in-out). */
  backInOut: [0.68, -0.6, 0.32, 1.6],
  /** Hard out — energetic decelerate, for impacts/whip-stops. */
  expoOut: [0.16, 1, 0.3, 1],
} as const satisfies Record<string, CubicBezier>;

/** A StyleKit easing curve name (key of {@link EASINGS}). */
export type EasingName = keyof typeof EASINGS;

/**
 * Default `defs.easings` token set seeded into every Scene IR (spec §6.2 example uses
 * `"smooth":[0.4,0,0.2,1]` and `"pop":"backOut"`). Values are either a cubic-bezier tuple or a
 * known curve NAME (string) — exactly the IR `EasingDef` union. The lowering pass merges these
 * into `defs.easings` so the `e` field always resolves and motion is never accidentally linear.
 */
export const DEFAULT_EASINGS = {
  smooth: EASINGS.smooth,
  /** The signature entrance curve. Named (not inlined) to match the spec's `"pop":"backOut"`. */
  pop: 'backOut',
  backOut: EASINGS.backOut,
  anticipate: EASINGS.anticipate,
  easeIn: EASINGS.easeIn,
  easeOut: EASINGS.easeOut,
  linear: EASINGS.linear,
} as const satisfies Record<string, CubicBezier | EasingName>;

/** True if `name` is a known StyleKit easing curve name. */
export function isEasingName(name: string): name is EasingName {
  return Object.prototype.hasOwnProperty.call(EASINGS, name);
}

/**
 * Resolve an easing definition to a Remotion `EasingFunction` usable by `interpolate({ easing })`.
 *
 * Accepts the Scene IR `EasingDef` shapes:
 *   - a cubic-bezier tuple `[x1,y1,x2,y2]`            → `Easing.bezier(...)`
 *   - a known StyleKit curve NAME (e.g. `"backOut"`)  → resolved via {@link EASINGS}
 *
 * Pure: same input ⇒ same function behavior. Throws on an unknown name so a typo can never
 * silently fall back to linear motion (spec §9: no motion is ever accidentally linear).
 */
export function easingFn(def: CubicBezier | EasingName | string): EasingFunction {
  if (typeof def === 'string') {
    if (!isEasingName(def)) {
      throw new Error(
        `Unknown easing name "${def}". Known: ${Object.keys(EASINGS).join(', ')}.`,
      );
    }
    const [x1, y1, x2, y2] = EASINGS[def];
    return Easing.bezier(x1, y1, x2, y2);
  }
  const [x1, y1, x2, y2] = def;
  return Easing.bezier(x1, y1, x2, y2);
}

// ---------------------------------------------------------------------------------------------
// 2. Palette — the default token set. A limited, premium per-scene palette (spec §9 look layer,
//    §6.2 `defs.palette`). Token names are stable so the IR and assets can reference them.
// ---------------------------------------------------------------------------------------------

/**
 * Default palette tokens seeded into every Scene IR `defs.palette`. Deep, saturated background +
 * warm accent + dark ink is the Kurzgesagt read; supporting tokens cover shading/depth needs that
 * land fully in M2 but are referenced by name now (so adding the model changes nothing upstream).
 */
export const DEFAULT_PALETTE = {
  /** Deep night-blue backdrop. */
  bg: '#1b2a4a',
  /** Slightly lighter mid-ground, for parallax separation. */
  bg2: '#24386b',
  /** Warm signature accent (the "spark"). */
  accent: '#ffcf4d',
  /** Secondary cool accent for contrast / two-tone subjects. */
  accent2: '#4d9fff',
  /** Near-black ink for outlines/text. */
  ink: '#0d1b33',
  /** Off-white for highlights/rim. */
  light: '#fff6e0',
  /** Soft shadow tint (used by contact shadow / AO in M2). */
  shadow: '#0a1326',
} as const satisfies Record<string, string>;

/** A default palette token name. */
export type PaletteToken = keyof typeof DEFAULT_PALETTE;

// ---------------------------------------------------------------------------------------------
// 3. Motion defaults — the "alive" constants every character/scene runs by default (spec §8, §9):
//    idle + breathing + Poisson blink + spring follow-through, plus stagger, parallax, and the
//    motion-blur shutter default. All are plain numbers consumed by rigs/generators/compositor.
// ---------------------------------------------------------------------------------------------

/**
 * Spring defaults for squash-&-stretch entrances and follow-through. Field names match Remotion
 * `spring({ config: { stiffness, damping, mass } })` so callers can spread this directly.
 * Tuned for a snappy-but-settled pop: slightly under-damped for a single gentle overshoot.
 */
export const SPRING_DEFAULTS = {
  /** Snappy default for entrances/impacts (single soft overshoot). */
  stiffness: 180,
  damping: 14,
  mass: 1,
} as const;

/** A heavier, more damped spring for big/weighty elements (less overshoot). */
export const SPRING_HEAVY = {
  stiffness: 120,
  damping: 20,
  mass: 1.4,
} as const;

/** A loose, bouncy spring for playful appendages / follow-through. */
export const SPRING_BOUNCY = {
  stiffness: 220,
  damping: 10,
  mass: 1,
} as const;

/**
 * Idle micro-motion: seeded simplex-noise sway + saccades layered on every character so even a
 * static shot feels alive (spec §8 "alive defaults"). Amplitudes are in degrees / pixels; speeds
 * are cycles-per-second (the consumer multiplies by `frame/fps` — never a wall-clock).
 */
export const IDLE_DEFAULTS = {
  /** Body/limb sway rotation amplitude, degrees. */
  swayAmplitudeDeg: 1.5,
  /** Sway noise speed, Hz (simplex sampled at frame/fps * speed). */
  swaySpeedHz: 0.15,
  /** Positional micro-drift amplitude, pixels. */
  driftAmplitudePx: 2,
  /** Drift noise speed, Hz. */
  driftSpeedHz: 0.1,
  /** Eye-saccade angular amplitude, degrees (quick gaze flicks). */
  saccadeAmplitudeDeg: 3,
  /** Mean seconds between saccades (Poisson-driven, like blink). */
  saccadeMeanSeconds: 1.8,
} as const;

/**
 * Breathing: a slow vertical chest/body scale oscillation. Amplitude is a scale delta (fraction),
 * period is in seconds; the consumer drives it from `frame/fps` so it stays deterministic.
 */
export const BREATHING_DEFAULTS = {
  /** Peak scale delta (e.g. 0.02 → chest scales 1.00↔1.02). */
  amplitude: 0.02,
  /** Breath period, seconds (≈ a calm resting breath). */
  periodSeconds: 4,
} as const;

/**
 * Blink: modeled as a Poisson process so blinks feel natural, never metronomic. `rateHz` is the
 * mean blinks-per-second (λ); the consumer turns it into deterministic blink frames via a SEEDED
 * RNG (never `Math.random`). `closeFrames` is the close→open duration of one blink.
 */
export const BLINK_DEFAULTS = {
  /** Mean blink rate, blinks per second (≈ one blink every ~4s). */
  rateHz: 0.25,
  /** Number of frames the eye stays closed during a blink (at the scene fps). */
  closeFrames: 4,
} as const;

/**
 * Stagger: cascading reveals offset each indexed element (spec §9 — `<Sequence>` offset =
 * index * staggerFrames). Default per-index delay in frames.
 */
export const STAGGER_DEFAULTS = {
  /** Per-index delay, frames. */
  offsetFrames: 6,
} as const;

/**
 * Parallax/2.5D defaults. `z` → parallax factor maps depth to camera-follow strength; far layers
 * also get atmospheric blur/desaturation (M2 look, reserved here). M1 uses `nearFactor`/`farFactor`
 * as the bounds the lite camera pass interpolates between by layer `z`.
 */
export const PARALLAX_DEFAULTS = {
  /** Parallax multiplier for the nearest layer (moves most with the camera). */
  nearFactor: 1,
  /** Parallax multiplier for the farthest layer (moves least → depth). */
  farFactor: 0.1,
} as const;

/**
 * Motion blur shutter angle, degrees (spec §9, §11 — the single biggest premium-motion lever).
 * 180° is the cinematic default consumed by `@remotion/motion-blur` on fast moves. M2 wires the
 * effect; the constant lives here now so the default is one tunable place.
 */
export const MOTION_BLUR_SHUTTER = 180;

/**
 * Aggregate of all motion defaults, for callers that want a single import. Individual constants
 * are also exported above for focused imports.
 */
export const MOTION_DEFAULTS = {
  spring: SPRING_DEFAULTS,
  springHeavy: SPRING_HEAVY,
  springBouncy: SPRING_BOUNCY,
  idle: IDLE_DEFAULTS,
  breathing: BREATHING_DEFAULTS,
  blink: BLINK_DEFAULTS,
  stagger: STAGGER_DEFAULTS,
  parallax: PARALLAX_DEFAULTS,
  /** Motion-blur shutter angle, degrees. */
  motionBlurShutter: MOTION_BLUR_SHUTTER,
} as const;

// ---------------------------------------------------------------------------------------------
// 4. Shading & Depth defaults (spec §11.1). A single scene LIGHT drives per-object supporting
//    gradient shapes (contact shadow, form, rim, AO, glow) — default-ON so depth is the quality
//    floor. Pure constants + a pure light-vector helper; the compositor (src/render/shading.tsx)
//    consumes these. No clock / RNG.
// ---------------------------------------------------------------------------------------------

/** A scene light source. `dir` is a screen-space azimuth in degrees (0=+x right, 90=down, 270=up). */
export interface Light {
  dir: number;
  elevation: number;
  color: string;
  intensity: number;
  ambient: number;
}

/** Default scene light: warm key from the upper-right, soft ambient fill. */
export const DEFAULT_LIGHT: Light = {
  dir: 295, // up-and-to-the-right (y is screen-down, so sin(295°)<0 ⇒ upward)
  elevation: 60,
  color: DEFAULT_PALETTE.light,
  intensity: 0.85,
  ambient: 0.38,
};

/** Per-object shading toggles/strengths (spec §11.1). Defaults are ON (quality floor). */
export interface ShadingSpec {
  form: boolean;
  contact_shadow: boolean;
  rim: number;
  ao: boolean;
  glow: number;
}

/** Default-on shading: contact shadow + rim + AO; form is the scene-level wash; glow opt-in. */
export const DEFAULT_SHADING: ShadingSpec = {
  form: true,
  contact_shadow: true,
  rim: 0.3,
  ao: true,
  glow: 0,
};

/** Unit light vector in screen space (y-down). Points TOWARD the light source. */
export function lightVector(dir: number): { x: number; y: number } {
  const r = (dir * Math.PI) / 180;
  return { x: Math.cos(r), y: Math.sin(r) };
}

/**
 * The complete StyleKit, for a single-import convenience. The named exports above are the
 * preferred entry points; this bundle mirrors the spec's "shared StyleKit module" framing.
 */
export const STYLEKIT = {
  easings: EASINGS,
  defaultEasings: DEFAULT_EASINGS,
  palette: DEFAULT_PALETTE,
  motion: MOTION_DEFAULTS,
} as const;
