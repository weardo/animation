// Generator registry. Spec §10: "adding a generator = adding one module, no IR or pipeline
// changes." The compositor resolves a Scene IR `generator.gen` string to a component via this map.
// Registration is the ONLY wiring step a new generator needs (add-generator skill step 3).

import type { GeneratorComponent } from './types.js';
import { BeadString } from './bead-string.js';

/** Name → component. Keys MUST match the Scene IR `generator.gen` field (e.g. "bead-string"). */
const REGISTRY: Record<string, GeneratorComponent> = {
  'bead-string': BeadString,
};

/** All registered generator names (for diagnostics / validation). */
export function generatorNames(): string[] {
  return Object.keys(REGISTRY);
}

/** True if a generator name is registered. */
export function hasGenerator(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

/**
 * Resolve a generator component by name. Throws on an unknown name so a Scene IR typo fails loudly
 * (never silently renders nothing) — consistent with the "no silent fallbacks" rule.
 */
export function getGenerator(name: string): GeneratorComponent {
  const gen = REGISTRY[name];
  if (!gen) {
    throw new Error(
      `Unknown generator "${name}". Registered: ${generatorNames().join(', ') || '(none)'}.`,
    );
  }
  return gen;
}

/**
 * Register (or override) a generator at runtime. Returns the registry for chaining. Intended for
 * tests and future dynamic registration; the static map above is the canonical M1 wiring.
 */
export function registerGenerator(name: string, component: GeneratorComponent): typeof REGISTRY {
  REGISTRY[name] = component;
  return REGISTRY;
}
