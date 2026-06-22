// Enabled built-in plugins — the composition root's plugin MANIFEST (ADR-005 "an enabled-plugins
// config lists active plugins"; ADR-007 code-location cleanup). This list lives WITH the plugins, NOT
// in core: the engine (src/) specializes in nothing and must not name any plugin. The dependency arrow
// points plugin→core (delete-the-plugin test) — this file imports core's `Plugin` type only.
//
// The built-ins ship AS plugins — the generators (bead-string/scatter/water/particles/fire/crowd), the
// dragonbones provider, the effects channel ops, and the `blob-creature` provider are all entries here,
// proving the engine dogfoods its own plugin system. The bundler entry (render-entry.tsx) feeds this
// list to `loadPlugins()` before registering the Remotion root, so the resolved capability set is a
// pure function of this list — identical across cold processes (CLAUDE.md r.1).

import type { Plugin } from '../src/engine/index.js';
import { coreGeneratorsPlugin } from './core-generators/index.js';
import { coreRigsPlugin } from './core-rigs/index.js';
import { coreEffectsPlugin } from './core-effects/index.js';
import { coreTransitionsPlugin } from './core-transitions/index.js';
import { coreDatavizPlugin } from './core-dataviz/index.js';
import { coreObjectsPlugin } from './core-objects/index.js';
import { blobCreaturePlugin } from './blob-creature/index.js';

/**
 * The active plugins, applied in order by `loadPlugins()`:
 *   • core-generators  — all built-in generators (bead-string/scatter/water/particles/fire/crowd)
 *   • core-rigs        — the dragonbones provider
 *   • core-effects     — the built-in `effects[]` channel ops (blur/glow/drop_shadow/color_grade/
 *                        turbulence/displace/vignette/grain/motion_blur) (ADR-003 #2)
 *   • core-transitions — the scene-boundary transition presentations (fade/wipe/slide/iris/mask/
 *                        match-cut/morph-match/camera-continuous) into the `transitions` registry (C4)
 *   • core-dataviz     — the `chart` generator (bar/line/pie via d3-shape) (P1)
 *   • core-objects     — the `object` provider for simple flat-vector props (P2)
 *   • blob-creature    — the `blob-creature` provider (renders a rig layer from its opaque spec)
 */
export const ENABLED_PLUGINS: readonly Plugin[] = [
  coreGeneratorsPlugin,
  coreRigsPlugin,
  coreEffectsPlugin,
  coreTransitionsPlugin,
  coreDatavizPlugin,
  coreObjectsPlugin,
  blobCreaturePlugin,
];
