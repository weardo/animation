// core-objects — a PROVIDER plugin for simple flat-vector PROPS (ADR-006), a peer of blob-creature.
// The engine specializes in NOTHING: just as a "character" is one provider, an "object/prop" is
// another. This plugin OWNS its ObjectSpec (spec.ts), the deterministic builder (objects.ts), and the
// renderer (renderer.tsx). It contributes the renderer into the engine's generic `providers` registry
// under the id `object`; at render time the compositor dispatches a `rig` layer to it by
// `rigDef.provider`, handing it the layer's OPAQUE `spec` (core treats it as `z.record(unknown)`).
// Core has ZERO prop knowledge — the same arrow (plugin→core) as every other plugin (delete-the-plugin
// test: remove this dir + its enabled.ts entry and the engine still builds).
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring; the renderer reads the frame clock
// itself and stays a pure function of (props + frame). The builder emits a byte-stable markup string.

import type { EngineAPI, Plugin } from '../../src/engine/index.js';
import { ObjectProvider } from './renderer.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/** The provider id this plugin registers under (the `rigDef.provider` value a prop rig layer uses). */
export const PROVIDER_ID = 'object';

/** The core-objects plugin: registers its renderer as the `object` provider. */
export const coreObjectsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    api.registerProvider(PROVIDER_ID, ObjectProvider);
  },
};

export default coreObjectsPlugin;

// Re-export the plugin's spec + builder (pure, browser-safe) so tooling/library generation can import
// them from the plugin root — mirrors blob-creature's re-export surface.
export {
  ObjectSpecSchema,
  ObjectKindSchema,
  parseSpec,
  STAR_SPEC,
  type ObjectSpec,
  type ObjectKind,
} from './spec.js';
export { objectMarkup } from './objects.js';
