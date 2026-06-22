// Engine core (ADR-005) — the minimal PLUGIN system. Public surface: the extension-point registries,
// the EngineAPI plugins register into, the plugin/manifest contract, and the loader. Capability is
// contributed by plugins (code); content stays in the library (data). See ADR-005.

// Generic registry + the named extension points the engine owns (2 live + 4 stubs).
export {
  Registry,
  generators,
  providers,
  effects,
  transitions,
  layerTypes,
  passes,
  registries,
  type RegistryName,
} from './registry.js';

// EngineAPI + the contract types plugins implement against.
export {
  engineApi,
  type EngineAPI,
  type ProviderComponent,
  type ProviderProps,
  type EffectImpl,
  type EffectContribution,
} from './api.js';

// Plugin + manifest contract.
export {
  PluginManifestSchema,
  ContributionKindSchema,
  ProvenanceSchema,
  parseManifest,
  type Plugin,
  type PluginManifest,
  type ContributionKind,
  type Provenance,
} from './plugin.js';

// Loader + enabled core-plugin list.
export { loadPlugins, type LoadResult } from './loader.js';
export { ENABLED_PLUGINS } from './enabled.js';
