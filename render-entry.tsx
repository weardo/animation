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

import { loadPlugins, type Plugin } from './src/engine/index.js';
import { ENABLED_PLUGINS } from './plugins/enabled.js';
import { gpuEffectsPlugin } from './plugins/gpu-effects/index.js';

// TIER GATE (M6, CLAUDE.md r.1): the Tier-B GPU effects/transitions plugin (gpu-effects) is REGISTERED
// only when the bundle was built for the GPU perceptual tier. `render.ts --gpu` injects a webpack
// DefinePlugin that replaces `process.env.GPU_TIER` with a literal; this is the ONE place that branches
// on it. On the CPU/byte-exact tier the GPU plugin is NEVER registered, so none of its WebGL/Pixi code
// enters the render path and the CPU output stays byte-identical to before — the perceptual tier is
// strictly opt-in. (The static import keeps render-entry synchronous; the gpu plugin's `register` is the
// only thing that wires WebGL into the engine, and it runs ONLY under this guard. PixiHost ALSO self-
// gates at runtime on a real hardware WebGL context — belt-and-braces.)
const gpuTier = (() => {
  try {
    return typeof process !== 'undefined' && process.env != null && !!process.env.GPU_TIER;
  } catch {
    return false;
  }
})();

const plugins: Plugin[] = gpuTier ? [...ENABLED_PLUGINS, gpuEffectsPlugin] : [...ENABLED_PLUGINS];

loadPlugins(plugins);

// Importing the compositor surface triggers `registerRoot(RemotionRoot)` (side effect) AFTER plugins
// are loaded. Re-export the surface so this entry is a drop-in for the former src/render/index.ts.
export * from './src/render/index.js';
