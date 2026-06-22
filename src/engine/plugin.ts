// Plugin contract (ADR-005). A plugin is a self-contained unit of CAPABILITY (code) that contributes
// implementations into the engine's extension points. It is the code peer of a library entry (data):
// same manifest + content-addressed + verify-gate sharing model (ADR-005 "Self-contained + shareable").
//
//   plugins/<id>/
//     plugin.json   ← validated by PluginManifestSchema below (id, version, contributes[], deps?, …)
//     index.ts      ← exports a Plugin { manifest, register(api) }
//
// Zod is the single source (CLAUDE.md r.3): one schema → the manifest TS type + runtime validation +
// JSON-Schema. The loader (loader.ts) parses each manifest with this schema before calling register.

import { z } from 'zod';
import type { EngineAPI } from './api.js';
import type { RegistryName } from './registry.js';

/** Semver-ish version string (e.g. "1.0.0", "0.2.1-rc.1"). Kept permissive; pinned by the lockfile. */
const Version = z.string().regex(/^\d+\.\d+\.\d+(?:[-+].+)?$/, 'expected semver (e.g. 1.0.0)');

/**
 * The extension-point categories a plugin may declare it contributes to. Matches the engine registry
 * names (registry.ts) — three live, four stubs — so a manifest documents WHICH sockets it plugs into.
 * Declarative metadata for discovery/diagnostics; the actual wiring happens in `register(api)`.
 */
const CONTRIBUTION_KINDS = [
  'generators',
  'rigProviders',
  'characterStyles',
  'effects',
  'transitions',
  'layerTypes',
  'passes',
] as const satisfies readonly RegistryName[];

export const ContributionKindSchema = z.enum(CONTRIBUTION_KINDS);
export type ContributionKind = z.infer<typeof ContributionKindSchema>;

/** Provenance for safe redistribution (ADR-001 §"License + provenance"): who authored it, from where. */
export const ProvenanceSchema = z
  .object({
    author: z.string().optional(),
    source: z.string().optional(),
    url: z.string().optional(),
  })
  .partial()
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

/**
 * The plugin.json manifest. `id` namespaces the plugin (`@author/name` later); `contributes[]` lists
 * the extension points it plugs into; `deps` names other plugin ids it requires (loaded first);
 * `license`/`provenance` make it safely shareable like a library entry.
 */
export const PluginManifestSchema = z
  .object({
    /** Unique plugin id (e.g. "core-generators", later "@author/name"). */
    id: z.string().min(1),
    version: Version,
    /** Extension points this plugin contributes to (documentation/diagnostics). */
    contributes: z.array(ContributionKindSchema).default([]),
    /** Other plugin ids this plugin depends on (must load first). */
    deps: z.array(z.string().min(1)).optional(),
    license: z.string().optional(),
    provenance: ProvenanceSchema.optional(),
  })
  .strict();
export type PluginManifest = z.infer<typeof PluginManifestSchema>;

/** Parse + validate raw plugin.json data → a typed manifest (throws on invalid). */
export function parseManifest(data: unknown): PluginManifest {
  return PluginManifestSchema.parse(data);
}

/**
 * A loaded plugin: its validated `manifest` plus a `register` hook that the loader calls with the
 * EngineAPI to wire the plugin's contributions into the core's registries (Blender-style register).
 * `register` MUST only perform registration — no clock, no per-frame state (CLAUDE.md r.1).
 */
export interface Plugin {
  manifest: PluginManifest;
  register(api: EngineAPI): void;
}
