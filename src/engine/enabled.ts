// Enabled CORE plugins (ADR-005 "an enabled-plugins config lists active plugins"). This is the list
// `loadPlugins()` applies by default. The built-ins ship AS core plugins — the existing generators
// (bead-string/scatter/water/particles/fire/crowd), the dragonbones provider, and the `blob-creature`
// provider become entries here, proving the engine dogfoods its own plugin system and shrinking the
// hardcoded core. (ADR-006: `blob-creature` is just one provider among many — no domain entity in core.)
//
// Adding a core plugin here (and nowhere else) is all the wiring a built-in needs — the loader calls
// each plugin's `register(api)` to populate the engine's extension-point registries before render.

import type { Plugin } from './plugin.js';
import { coreGeneratorsPlugin } from '../../plugins/core-generators/index.js';
import { coreRigsPlugin } from '../../plugins/core-rigs/index.js';
import { blobCreaturePlugin } from '../../plugins/blob-creature/index.js';

/**
 * The active core plugins, applied in order by `loadPlugins()`:
 *   • core-generators — all built-in generators (bead-string/scatter/water/particles/fire/crowd)
 *   • core-rigs       — the dragonbones provider
 *   • blob-creature   — the `blob-creature` provider (renders a rig layer from its opaque spec)
 */
export const ENABLED_PLUGINS: readonly Plugin[] = [
  coreGeneratorsPlugin,
  coreRigsPlugin,
  blobCreaturePlugin,
];
