// Engine extension-point registries (ADR-005). The engine core owns a set of typed REGISTRIES;
// plugins contribute implementations into them via the EngineAPI (api.ts). This generalises the two
// seeds that already exist — `src/generators/registry.ts` (generator name→component) and the rig
// `kind` dispatch in `src/render/Scene.tsx` (procedural vs dragonbones) — into one uniform mechanism.
//
// A Registry is a small typed name→value map with register / get / has / names. `get` THROWS on an
// unknown name (no silent fallback — a Scene-IR typo fails loudly, matching the existing generator
// registry contract). Re-registering the same name is allowed (last wins) so a plugin can override a
// core contribution; the loader is responsible for ordering.
//
// DETERMINISM: a registry is pure data wiring — it holds no clock and no per-frame state. It is
// populated ONCE at module init / before render (see loader.ts), so registration order is fixed and
// the resolved capability set is identical across cold processes (CLAUDE.md r.1).

import type { GeneratorComponent } from '../generators/types.js';
import type { EffectImpl, ProviderComponent } from './api.js';

/** A generic, typed name→value registry. The single building block for every extension point. */
export class Registry<T> {
  /** Human-readable label used in error messages (e.g. "generator", "rig provider"). */
  readonly label: string;
  private readonly entries = new Map<string, T>();

  constructor(label: string) {
    this.label = label;
  }

  /** Register (or override) `name` → `value`. Last registration wins. */
  register(name: string, value: T): this {
    this.entries.set(name, value);
    return this;
  }

  /** True if `name` has been registered. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** All registered names, in insertion order (for diagnostics / validation). */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Resolve `name` → value. THROWS on an unknown name (no silent fallback) so a Scene-IR typo or a
   * missing plugin fails loudly with the list of what IS registered.
   */
  get(name: string): T {
    const value = this.entries.get(name);
    if (value === undefined) {
      throw new Error(
        `Unknown ${this.label} "${name}". Registered: ${this.names().join(', ') || '(none)'}.`,
      );
    }
    return value;
  }
}

// --- The named extension points the engine core owns (ADR-005 / ADR-006 "Extension points"). ---
//
// TWO are populated today (they have real contributors — the existing built-ins are core plugins):
//   • generators  — generator name → React component  (was src/generators/registry.ts)
//   • providers   — provider id    → React component  (was the Scene.tsx kind dispatch; ADR-006)
//
// ADR-006: the engine specializes in NOTHING. The former `rigProviders` and `characterStyles` collapse
// into ONE generic `providers` registry: a provider (id `blob-creature`/`dragonbones`/future `chart`/
// `widget`) renders a `rig` layer from an OPAQUE spec it validates itself. Core knows no "character"/
// "style" — only "a rig layer → a provider id → the provider renders it".
//
// THREE are populated today (generators, providers, effects — effects via the core-effects plugin,
// ADR-003 #2). THREE remain STUBS — defined now with the SAME shape so future backlog items plug in
// WITHOUT touching the core, but left empty (no contributors yet). Do NOT implement these now.

/** Generator implementations: `gen` name → component (e.g. "scatter", "water"). */
export const generators = new Registry<GeneratorComponent>('generator');

/** Providers: provider id → component (e.g. "blob-creature", "dragonbones", future "chart"). */
export const providers = new Registry<ProviderComponent>('provider');

/**
 * Effects: `effects[]` channel op kind → {@link EffectImpl} (e.g. "blur", "glow", "motion_blur").
 * Populated by the core-effects plugin (ADR-003 #2). A registered effect validates its own params and
 * produces a deterministic SVG-filter / CSS-filter / wrapper contribution the compositor composites.
 */
export const effects = new Registry<EffectImpl>('effect');

// --- STUB extension points (defined, empty; future capability plugs in here). ---

/** STUB: scene-boundary transition presentations. Shape only; no contributors yet. */
export const transitions = new Registry<unknown>('transition');

/** STUB: Scene-IR layer types (beyond asset/rig/generator/shape). Shape only; no contributors yet. */
export const layerTypes = new Registry<unknown>('layer type');

/** STUB: pipeline IR passes (IR_n→IR_{n+1} stages). Shape only; no contributors yet. */
export const passes = new Registry<unknown>('pass');

/** Every engine registry, by name — for diagnostics and the loader's post-load report. */
export const registries = {
  generators,
  providers,
  effects,
  transitions,
  layerTypes,
  passes,
} as const;

/** The set of extension-point names the engine owns (the two live + four stubs). */
export type RegistryName = keyof typeof registries;
