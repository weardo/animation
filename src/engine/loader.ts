// Plugin loader (ADR-005 "Discovery/loading"; ADR-007 code-location cleanup). `loadPlugins` is the ONE
// place the engine turns a list of enabled plugins into populated extension-point registries: it
// validates each plugin's manifest, orders by declared `deps`, then calls `register(api)` so each
// plugin wires its contributions in.
//
// Loaded ONCE at module init / before render (idempotent — re-registering the same name just last-
// wins; see Registry). The engine core names NO plugin: the caller (the composition root /
// render-entry, outside src/) supplies the enabled-plugin list (plugins/enabled.ts). Keeping load in
// one call makes the resolved capability set a pure function of the supplied list → identical across
// cold processes, preserving determinism (CLAUDE.md r.1; verify-render gates every plugin).

import { engineApi, type EngineAPI } from './api.js';
import { parseManifest, type Plugin } from './plugin.js';
import { registries } from './registry.js';

/** Outcome of a load: the plugin ids that registered, in the order they were applied. */
export interface LoadResult {
  /** Plugin ids in applied order. */
  loaded: string[];
  /** Snapshot of each registry's contributed names after load (diagnostics). */
  contributions: Record<string, string[]>;
}

/**
 * Topologically order plugins so every plugin's declared `deps` register BEFORE it. Deps naming
 * unknown (not-enabled) plugins throw — a plugin must not silently load without its prerequisites.
 * Stable: independent plugins keep their input order.
 */
function orderByDeps(plugins: readonly Plugin[]): Plugin[] {
  const byId = new Map(plugins.map((p) => [p.manifest.id, p]));
  const ordered: Plugin[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();

  const visit = (p: Plugin): void => {
    const id = p.manifest.id;
    if (done.has(id)) return;
    if (visiting.has(id)) {
      throw new Error(`Plugin dependency cycle detected at "${id}".`);
    }
    visiting.add(id);
    for (const depId of p.manifest.deps ?? []) {
      const dep = byId.get(depId);
      if (!dep) {
        throw new Error(`Plugin "${id}" depends on "${depId}", which is not enabled.`);
      }
      visit(dep);
    }
    visiting.delete(id);
    done.add(id);
    ordered.push(p);
  };

  for (const p of plugins) visit(p);
  return ordered;
}

/**
 * Validate + register every plugin into the engine's extension points. For each plugin: re-validate
 * its manifest (Zod — fail loudly on a malformed plugin), then call `register(api)`. Returns the
 * applied order + a snapshot of the contributed names per registry.
 *
 * @param plugins the enabled plugins to load (the caller — the composition root — supplies these; the
 *                engine names no plugin). See plugins/enabled.ts for the built-in list.
 * @param api     the EngineAPI to register into (default: the engine's bound instance).
 */
export function loadPlugins(plugins: readonly Plugin[], api: EngineAPI = engineApi): LoadResult {
  const ordered = orderByDeps(plugins);

  for (const plugin of ordered) {
    // Re-validate the manifest at load (a hand-edited plugin.json must fail here, not at render).
    parseManifest(plugin.manifest);
    plugin.register(api);
  }

  const contributions: Record<string, string[]> = {};
  for (const [name, reg] of Object.entries(registries)) {
    contributions[name] = reg.names();
  }

  return { loaded: ordered.map((p) => p.manifest.id), contributions };
}
