// Generator registry — now a thin DELEGATE over the engine's `generators` extension point (ADR-005).
// The canonical name→component map lives in src/engine/registry.ts and is POPULATED by the
// core-generators plugin (plugins/core-generators) via the EngineAPI — there is NO parallel registry.
// This module keeps the historical helper API (getGenerator/hasGenerator/generatorNames/
// registerGenerator) so existing consumers (GeneratorLayer, the add-generator skill) are unchanged,
// but every call now reads/writes the single engine registry.
//
// Spec §10: "adding a generator = adding one module, no IR or pipeline changes." Under ADR-005 the
// one wiring step is `api.registerGenerator` inside a (core or third-party) plugin, replacing the
// former static map here. The engine Registry's `get` already throws loudly on an unknown name (no
// silent fallback), preserving the old contract.

import type { GeneratorComponent } from './types.js';
import { generators } from '../engine/registry.js';

/** All registered generator names (for diagnostics / validation). */
export function generatorNames(): string[] {
  return generators.names();
}

/** True if a generator name is registered. */
export function hasGenerator(name: string): boolean {
  return generators.has(name);
}

/**
 * Resolve a generator component by name. Throws on an unknown name so a Scene IR typo fails loudly
 * (never silently renders nothing) — consistent with the "no silent fallbacks" rule.
 */
export function getGenerator(name: string): GeneratorComponent {
  return generators.get(name);
}

/**
 * Register (or override) a generator at runtime — delegates to the engine registry. Intended for
 * tests and dynamic registration; the canonical wiring is `api.registerGenerator` in a plugin.
 */
export function registerGenerator(name: string, component: GeneratorComponent): void {
  generators.register(name, component);
}
