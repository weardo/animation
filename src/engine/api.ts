// EngineAPI (ADR-005). The ONE object handed to every plugin's `register(api)` hook. It exposes a
// `register*` method per extension point; each writes into the corresponding registry (registry.ts).
// A plugin never imports the registries directly — it only ever touches this API, so the core keeps a
// single, swappable seam between "capability authored as a plugin" and "the registries the core owns"
// (Blender-style register/unregister; ADR-005 "Plugin contract").
//
// Today THREE register methods are live (generators, providers, effects — the existing built-ins plus
// the core-effects plugin, ADR-003 #2) and THREE are STUBS (transitions / layer types / passes) —
// present with the right shape so future plugins compile and wire in without a core change, but with
// no contributors yet. Do NOT implement the stub capabilities now.
//
// ADR-006: the engine specializes in NOTHING. There is no "character style" extension point — a
// "character" is just one PROVIDER among many. A provider renders a `rig` layer from an OPAQUE spec
// (`z.record(unknown)`) that the provider itself validates/interprets; core has zero domain knowledge.
//
// DETERMINISM: the API only performs registration (pure data wiring). It owns no clock and no
// per-frame state; contributed implementations carry the determinism contract (CLAUDE.md r.1).

import type { ComponentType, ReactNode } from 'react';
import type { Easings, RigDef, RigLayer, StyleKit } from '../ir/index.js';
import type { GeneratorComponent } from './generator.js';
import { effects, generators, layerTypes, passes, providers, transitions } from './registry.js';

/**
 * An EFFECT (ADR-003 #2) is the engine's generic, composable per-layer look op. It is contributed by
 * a plugin into the `effects` extension point and consumed by the compositor when it walks a layer's
 * Scene-IR `effects[]` stack. The engine owns ONLY this generic contract — it knows nothing about any
 * specific effect (blur/glow/grade/…); those live entirely in the `core-effects` plugin (no domain
 * leakage to core, ADR-005/006).
 *
 * An effect's {@link EffectImpl.build} is a PURE function of (params, frame) → an {@link EffectContribution}.
 * Three independent contribution channels compose cleanly with the existing §11.1 shading + parallax:
 *
 *   1. `filterPrimitives` — SVG <filter> primitive(s) (feGaussianBlur, feColorMatrix, feTurbulence +
 *      feDisplacementMap, …). The compositor CHAINS them: it threads each effect's input/output
 *      `result` names so the stack composites in `effects[]` order inside one deterministic <filter>.
 *   2. `cssFilter` — a CSS `filter` fragment (e.g. `brightness(1.2)`), concatenated in order. Used for
 *      cheap ops that have a direct CSS form (and for silhouette-following drop-shadow glow).
 *   3. `wrap` — wraps the whole layer subtree (used by motion_blur's @remotion/motion-blur <Trail>).
 *
 * DETERMINISM (CLAUDE.md r.1): `build` is a pure function of (params, frame) — no clock, no RNG. The
 * frame is passed IN so an effect's parameters can themselves be animated by the compositor; the effect
 * never reads a clock. SVG/CSS filters + motion-blur are frame-deterministic on the CPU raster default.
 */
export interface EffectContribution {
  /**
   * SVG <filter> primitive builder(s), each a pure function of (inResult, outResult) → a filter
   * primitive node. `inResult` is the prior stage's output (or `SourceGraphic` for the first); the
   * builder MUST set its `in=` to `inResult` and its `result=` to `outResult` so the compositor can
   * chain effects in `effects[]` order. May contribute several primitives (e.g. turbulence+displace).
   */
  filterPrimitives?: ReadonlyArray<(inResult: string, outResult: string) => ReactNode>;
  /** A CSS `filter` fragment (e.g. "brightness(1.2) saturate(0.8)"), concatenated in stack order. */
  cssFilter?: string;
  /** Wrap the entire layer subtree (e.g. motion_blur's <Trail>). Applied outermost, in stack order. */
  wrap?: (node: ReactNode) => ReactNode;
}

/**
 * An effect implementation registered under its Scene-IR `kind` (e.g. "blur", "glow", "motion_blur").
 * The plugin narrows the loose `{ kind, ...params }` IR entry with its OWN Zod (`parse`) and produces
 * a deterministic {@link EffectContribution} from the validated params at `frame`.
 */
export interface EffectImpl {
  /**
   * Validate + narrow this effect's loose IR params (the `{ kind, ...params }` object minus `kind`).
   * Throws on invalid params (loud failure, matching the registry contract). Returns the typed params.
   */
  parse(params: Record<string, unknown>): unknown;
  /** Pure (params, frame) → contribution. `params` is the value returned by {@link EffectImpl.parse}. */
  build(params: unknown, frame: number): EffectContribution;
}

/**
 * A PROVIDER renders a Scene-IR `rig` layer (ADR-006). It is a React component the compositor
 * dispatches to by `rigDef.provider` (today: `blob-creature`, `dragonbones`; future: `chart`,
 * `widget`, …). The `rigDef.spec` is OPAQUE to the core — the provider validates/interprets it with
 * its OWN schema. Like every sub-renderer it reads the frame clock itself (useCurrentFrame) and must
 * be a pure function of (props + frame) — CLAUDE.md r.1.
 */
export interface ProviderProps {
  /** The Scene-IR rig layer (transform `{a,k}` channels + rig_state.clips). */
  layer: RigLayer;
  /** The resolved rig definition (`defs.rigs[layer.ref]`): `provider` id + the opaque `spec`/sources. */
  rigDef: RigDef;
  /** The scene easing table for resolving `{a,k}` channels. */
  easings?: Easings | undefined;
  /**
   * The resolved stylekit (ADR-008 I2/I3) the scene renders under (`defs.stylekit`). A provider reads
   * `stylekit.motion` for liveness magnitudes and HONORS `stylekit.floor.liveness` — when false it
   * skips idle/breathe/blink for a static/technical look. Optional for back-compat (absent → the
   * provider's own defaults / always-alive). Domain-agnostic: core hands the whole stylekit through.
   */
  stylekit?: StyleKit | undefined;
}

/** A provider is a React component consuming {@link ProviderProps}. */
export type ProviderComponent = ComponentType<ProviderProps>;

/**
 * The surface a plugin's `register(api)` uses to contribute capability into the engine's extension
 * points. Mirrors the registries in registry.ts one-to-one. LIVE methods write real contributions;
 * STUB methods exist with the right shape but have no consumers wired yet (future backlog).
 */
export interface EngineAPI {
  // --- LIVE extension points (real contributors today) ---

  /** Register a generator implementation under its `gen` name (e.g. "scatter"). */
  registerGenerator(name: string, component: GeneratorComponent): void;

  /**
   * Register a provider under its id (e.g. "blob-creature", "dragonbones", future "chart"). The
   * provider renders a `rig` layer from the layer's OPAQUE `spec`, which it validates itself (ADR-006).
   */
  registerProvider(id: string, component: ProviderComponent): void;

  /**
   * Register an `effects[]` channel op under its Scene-IR `kind` (ADR-003 #2). The {@link EffectImpl}
   * validates its own params (in-plugin Zod) and produces a deterministic {@link EffectContribution}
   * (SVG <filter> primitives / CSS filter fragment / layer wrapper) the compositor composites in order.
   * The core owns ONLY the generic registry + this contract; specific effects live in a plugin.
   */
  registerEffect(kind: string, impl: EffectImpl): void;

  // --- STUB extension points (shape only; no consumers wired yet — do not implement now) ---

  /** STUB: register a scene-boundary transition presentation. No consumer yet. */
  registerTransition(kind: string, transition: unknown): void;

  /** STUB: register a Scene-IR layer type. No consumer yet. */
  registerLayerType(type: string, impl: unknown): void;

  /** STUB: register a pipeline IR pass. No consumer yet. */
  registerPass(name: string, pass: unknown): void;
}

/**
 * The single EngineAPI instance, bound to the engine's registries. `loadPlugins` hands this to every
 * plugin's `register(api)` (loader.ts). Registration is pure data wiring done once before render.
 */
export const engineApi: EngineAPI = {
  registerGenerator: (name, component) => void generators.register(name, component),
  registerProvider: (id, component) => void providers.register(id, component),
  registerEffect: (kind, impl) => void effects.register(kind, impl),
  registerTransition: (kind, transition) => void transitions.register(kind, transition),
  registerLayerType: (type, impl) => void layerTypes.register(type, impl),
  registerPass: (name, pass) => void passes.register(name, pass),
};
