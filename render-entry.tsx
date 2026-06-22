// Composition root / bundler entry (ADR-005/007). This is Remotion's entry point — the ONE place that
// wires plugins (capability/code) into the engine before the compositor registers its root. It lives
// OUTSIDE src/ on purpose: the engine core specializes in nothing and names no plugin, so the
// plugin→core dependency arrow holds (delete-the-plugin test) and `grep "from .*plugins/" src/` is
// empty. Both `remotion studio` and the CLI renderer point their `entryPoint` here.
//
// Order matters: load the enabled plugins FIRST (populating the engine's `generators`/`providers`/
// `effects` registries), THEN import src/render/index.js, which calls `registerRoot`. By the time any
// composition renders, every contributed capability is resolvable. Loading is pure data wiring
// (idempotent, last-wins) so the resolved set is identical across cold processes (CLAUDE.md r.1).

import { loadPlugins } from './src/engine/index.js';
import { ENABLED_PLUGINS } from './plugins/enabled.js';

loadPlugins(ENABLED_PLUGINS);

// Importing the compositor surface triggers `registerRoot(RemotionRoot)` (side effect) AFTER plugins
// are loaded. Re-export the surface so this entry is a drop-in for the former src/render/index.ts.
export * from './src/render/index.js';
