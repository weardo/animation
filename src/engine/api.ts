// EngineAPI (ADR-005). The ONE object handed to every plugin's `register(api)` hook. It exposes a
// `register*` method per extension point; each writes into the corresponding registry (registry.ts).
// A plugin never imports the registries directly — it only ever touches this API, so the core keeps a
// single, swappable seam between "capability authored as a plugin" and "the registries the core owns"
// (Blender-style register/unregister; ADR-005 "Plugin contract").
//
// Today TWO register methods are live (generators, providers — the existing built-ins are core
// plugins) and FOUR are STUBS (effects / transitions / layer types / passes) — present with the right
// shape so future plugins compile and wire in without a core change, but with no contributors yet. Do
// NOT implement the stub capabilities now.
//
// ADR-006: the engine specializes in NOTHING. There is no "character style" extension point — a
// "character" is just one PROVIDER among many. A provider renders a `rig` layer from an OPAQUE spec
// (`z.record(unknown)`) that the provider itself validates/interprets; core has zero domain knowledge.
//
// DETERMINISM: the API only performs registration (pure data wiring). It owns no clock and no
// per-frame state; contributed implementations carry the determinism contract (CLAUDE.md r.1).

import type { ComponentType } from 'react';
import type { Easings, RigDef, RigLayer } from '../ir/index.js';
import type { GeneratorComponent } from '../generators/types.js';
import { effects, generators, layerTypes, passes, providers, transitions } from './registry.js';

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

  // --- STUB extension points (shape only; no consumers wired yet — do not implement now) ---

  /** STUB: register an effects[] channel op. No consumer yet. */
  registerEffect(name: string, effect: unknown): void;

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
  registerEffect: (name, effect) => void effects.register(name, effect),
  registerTransition: (kind, transition) => void transitions.register(kind, transition),
  registerLayerType: (type, impl) => void layerTypes.register(type, impl),
  registerPass: (name, pass) => void passes.register(name, pass),
};
