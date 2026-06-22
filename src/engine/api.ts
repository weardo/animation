// EngineAPI (ADR-005). The ONE object handed to every plugin's `register(api)` hook. It exposes a
// `register*` method per extension point; each writes into the corresponding registry (registry.ts).
// A plugin never imports the registries directly — it only ever touches this API, so the core keeps a
// single, swappable seam between "capability authored as a plugin" and "the registries the core owns"
// (Blender-style register/unregister; ADR-005 "Plugin contract").
//
// Today THREE register methods are live (generators, rig providers, character styles — the existing
// built-ins migrate through them in the Migrate phase) and FOUR are STUBS (effects / transitions /
// layer types / passes) — present with the right shape so future plugins compile and wire in without
// a core change, but with no contributors yet. Do NOT implement the stub capabilities now.
//
// DETERMINISM: the API only performs registration (pure data wiring). It owns no clock and no
// per-frame state; contributed implementations carry the determinism contract (CLAUDE.md r.1).

import type { ComponentType } from 'react';
import type { CharacterSpec } from '../factory/spec.js';
import type { Easings, RigClip, RigDef, RigLayer } from '../ir/index.js';
import type { GeneratorComponent } from '../generators/types.js';
import {
  characterStyles,
  effects,
  generators,
  layerTypes,
  passes,
  rigProviders,
  transitions,
} from './registry.js';

/**
 * A RIG PROVIDER renders a Scene-IR `rig` layer for one provider `kind` (ADR-001). It is a React
 * component the compositor dispatches to by `rigDef.kind` (today: `procedural` → ProceduralRig,
 * `dragonbones` → RigLayer). The props are the union of what those two existing providers need; a
 * provider reads only the fields its kind uses. Like every sub-renderer it reads the frame clock
 * itself (useCurrentFrame) and must be a pure function of (props + frame) — CLAUDE.md r.1.
 */
export interface RigProviderProps {
  /** The Scene-IR rig layer (transform `{a,k}` channels + rig_state.clips). */
  layer: RigLayer;
  /** The resolved rig definition (`defs.rigs[layer.ref]`): `kind` + optional embedded spec/sources. */
  rigDef: RigDef;
  /** The scene easing table for resolving `{a,k}` channels. */
  easings?: Easings | undefined;
}

/** A rig provider is a React component consuming {@link RigProviderProps}. */
export type RigProviderComponent = ComponentType<RigProviderProps>;

/**
 * A CHARACTER STYLE builds the deterministic SVG markup for a CharacterSpec at a frame (ADR-005
 * "Character styles"). The default `blob-creature` style is today's `characterMarkup`. A style is a
 * PURE function of (spec, frame, fps, clips) returning a byte-stable `<g>` markup string — it drives
 * both the runtime procedural rig and offline factory previews, so it owns no clock.
 */
export type CharacterStyleBuilder = (
  spec: CharacterSpec,
  frame: number,
  fps: number,
  clips: readonly RigClip[],
) => string;

/**
 * The surface a plugin's `register(api)` uses to contribute capability into the engine's extension
 * points. Mirrors the registries in registry.ts one-to-one. LIVE methods write real contributions;
 * STUB methods exist with the right shape but have no consumers wired yet (future backlog).
 */
export interface EngineAPI {
  // --- LIVE extension points (real contributors today) ---

  /** Register a generator implementation under its `gen` name (e.g. "scatter"). */
  registerGenerator(name: string, component: GeneratorComponent): void;

  /** Register a rig provider under its rig `kind` (e.g. "procedural", "dragonbones"). */
  registerRigProvider(kind: string, component: RigProviderComponent): void;

  /** Register a character-style builder under its style id (e.g. "blob-creature"). */
  registerCharacterStyle(id: string, builder: CharacterStyleBuilder): void;

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
  registerRigProvider: (kind, component) => void rigProviders.register(kind, component),
  registerCharacterStyle: (id, builder) => void characterStyles.register(id, builder),
  registerEffect: (name, effect) => void effects.register(name, effect),
  registerTransition: (kind, transition) => void transitions.register(kind, transition),
  registerLayerType: (type, impl) => void layerTypes.register(type, impl),
  registerPass: (name, pass) => void passes.register(name, pass),
};
