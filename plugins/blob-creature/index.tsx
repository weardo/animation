// blob-creature — the first PROVIDER plugin (ADR-006). The engine specializes in NOTHING: a
// "character" is just ONE provider among many (peers: dragonbones; future chart/widget/diagram). This
// plugin OWNS the former core `src/factory/` — its CharacterSpec (spec.ts), the procedural builder
// (character.ts), the renderer (renderer.tsx), and the source-material generator (generator.ts).
//
// register(api) contributes the renderer into the engine's generic `providers` registry under the id
// `blob-creature`. At render time the compositor dispatches a `rig` layer to it by `rigDef.provider`,
// handing it the layer's OPAQUE `spec` (core treats it as `z.record(unknown)`); the provider validates
// that spec with its OWN CharacterSpec and draws it. Core has ZERO character knowledge.
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring; the renderer reads the frame clock
// itself and stays a pure function of (props + frame) — this migration is a relocation, not a
// behaviour change (blip renders identically).

import type { EngineAPI, Plugin } from '../../src/engine/index.js';
import { BlobCreatureProvider } from './renderer.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/** The provider id this plugin registers under (the `rigDef.provider` value the loader emits). */
export const PROVIDER_ID = 'blob-creature';

/** The blob-creature plugin: registers its renderer as the `blob-creature` provider. */
export const blobCreaturePlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    api.registerProvider(PROVIDER_ID, BlobCreatureProvider);
  },
};

export default blobCreaturePlugin;

// Re-export the plugin's spec + builder (pure, browser-safe) so tooling can import them from the
// plugin root. NOTE: the source-material GENERATOR (generator.ts) is deliberately NOT re-exported
// here — it imports Node-only modules (fs/child_process) and this index is bundled into the Remotion
// (browser) build via the engine's enabled-plugin list. Import it directly: `./generator.js`.
export { CharacterSpecSchema, parseSpec, BLIP_SPEC, type CharacterSpec } from './spec.js';
export { characterMarkup } from './character.js';
