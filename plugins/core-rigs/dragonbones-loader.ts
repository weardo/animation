// DragonBones loader — the spike-proven init path, factored into a pure async function.
//
// Builds a Pixi v8 Application with its clock fully disabled, parses a DragonBones armature via
// `pixi-dragonbones-runtime`'s PixiFactory, and returns the live handles the <RigLayer> seeks
// each frame. This is the EXACT loader the spike validated:
//
//   PixiFactory.factory
//     -> parseDragonBonesData(skeJson)
//     -> parseTextureAtlasData(texJson, texture)
//     -> buildArmatureDisplay(armatureName)
//
// Determinism (spec §8, §14.1; spike findings):
//   • app.init({ autoStart:false, sharedTicker:false }) AND app.ticker.stop() — Pixi NEVER runs
//     its own clock. We also force `PixiFactory.useSharedTicker = false` so the factory does not
//     spin up a WorldClock.
//   • The armature is driven ONLY by absolute-time seeks from <RigLayer> (state.currentTime = t),
//     never by incremental advanceTime(dt). This keeps frame rendering order-independent.
//
// No wall-clock, no Math.random here. The only inputs are the rig's URIs.

import { Application, Assets, Texture } from 'pixi.js';
import { PixiFactory } from 'pixi-dragonbones-runtime';
import type { Armature, PixiArmatureDisplay } from 'pixi-dragonbones-runtime';

/** The three files that make up a DragonBones rig (skeleton + texture atlas + atlas image). */
export interface RigSources {
  /** URL/path to the `*_ske.json` skeleton data (resolve via Remotion `staticFile`). */
  readonly skeletonUrl: string;
  /** URL/path to the `*_tex.json` texture-atlas data. */
  readonly atlasUrl: string;
  /** URL/path to the `*_tex.png` atlas image. */
  readonly textureUrl: string;
  /**
   * Armature name to build (e.g. "starter"). If omitted, the loader builds the first armature
   * declared in the skeleton data (so a caller that doesn't know the name still gets a rig).
   */
  readonly armatureName?: string | undefined;
}

/** Live handles for a loaded rig. <RigLayer> caches these in a ref and seeks them per frame. */
export interface LoadedRig {
  /** The Pixi application whose canvas is mounted into the DOM. Its clock is stopped. */
  readonly app: Application;
  /** The factory the armature was built from (kept so we can dispose cleanly). */
  readonly factory: PixiFactory;
  /** The armature display container (a Pixi Container) — added to the stage. */
  readonly display: PixiArmatureDisplay;
  /** The underlying armature — the thing we seek + flush each frame. */
  readonly armature: Armature;
  /** The cache name the DragonBones data was registered under (for disposal). */
  readonly dragonBonesName: string;
}

/** Read the armature names out of raw DragonBones skeleton JSON (format v5.x: `{ armature: [...] }`). */
function firstArmatureName(skeletonData: unknown): string | undefined {
  if (
    typeof skeletonData === 'object' &&
    skeletonData !== null &&
    'armature' in skeletonData
  ) {
    const arr = (skeletonData as { armature?: unknown }).armature;
    if (Array.isArray(arr) && arr.length > 0) {
      const first = arr[0] as { name?: unknown };
      if (typeof first.name === 'string') return first.name;
    }
  }
  return undefined;
}

/**
 * Initialize Pixi + DragonBones for one rig. Async (Pixi v8 `Application.init` is async; the atlas
 * texture is loaded via `Assets.load`). Call ONCE per rig instance and cache the result — re-initing
 * per frame leaks GL contexts. The returned `app.canvas` is what you mount into the DOM.
 *
 * @param sources   the three rig file URLs (already resolved through `staticFile`).
 * @param width     canvas width in px (the composition width).
 * @param height    canvas height in px (the composition height).
 */
export async function loadRig(
  sources: RigSources,
  width: number,
  height: number,
): Promise<LoadedRig> {
  // Fetch skeleton + atlas JSON, and the atlas texture, in parallel.
  const [skeletonData, atlasData, texture] = await Promise.all([
    fetch(sources.skeletonUrl).then((r) => r.json() as Promise<unknown>),
    fetch(sources.atlasUrl).then((r) => r.json() as Promise<unknown>),
    Assets.load(sources.textureUrl) as Promise<Texture>,
  ]);

  // Pixi v8: init is async; canvas option is `canvas` (not `view`). Disable the clock two ways.
  const app = new Application();
  await app.init({
    width,
    height,
    autoStart: false, // do not start Pixi's render loop
    sharedTicker: false, // do not attach to the shared ticker
    backgroundAlpha: 0, // transparent so the rig composites over SVG/React layers (spec §14.2)
    antialias: true,
    // Retain the drawn buffer so Remotion's screenshot reliably captures the rendered frame even if
    // the browser composite lags the rAF — without this, ~2% of frames captured stale under full-render
    // load, breaking byte-identical determinism. Verified 2026-06-22.
    preserveDrawingBuffer: true,
  });
  app.ticker.stop(); // belt-and-suspenders: Pixi never advances its own clock

  // Do not let the factory drive a WorldClock either.
  PixiFactory.useSharedTicker = false;
  const factory = PixiFactory.factory;

  const dbData = factory.parseDragonBonesData(skeletonData as object);
  if (!dbData) {
    throw new Error(`failed to parse DragonBones skeleton data from ${sources.skeletonUrl}`);
  }
  factory.parseTextureAtlasData(atlasData as object, texture);

  const name = sources.armatureName ?? firstArmatureName(skeletonData) ?? dbData.armatureNames[0];
  if (!name) {
    throw new Error(`no armature found in skeleton data from ${sources.skeletonUrl}`);
  }

  const display = factory.buildArmatureDisplay(name, dbData.name);
  if (!display) {
    throw new Error(`failed to build armature "${name}" from ${sources.skeletonUrl}`);
  }

  // A DragonBones armature draws around its own (0,0) origin, which Pixi maps to the canvas
  // TOP-LEFT. Place the display at the canvas centre so the armature sits in the middle of the
  // frame, where <RigLayer>'s Scene-IR transform (authored relative to the composition centre)
  // expects it. This is a fixed, deterministic layout offset — not animation (CLAUDE.md r.1).
  display.x = width / 2;
  display.y = height / 2;

  app.stage.addChild(display);

  return {
    app,
    factory,
    display,
    armature: display.armature,
    dragonBonesName: dbData.name,
  };
}

/** Dispose a loaded rig's GPU resources (canvas unmount / hot-reload cleanup). */
export function disposeRig(rig: LoadedRig): void {
  try {
    rig.display.dispose(true);
  } catch {
    // already disposed
  }
  // Drop this rig's data from the factory cache so a remount re-parses cleanly.
  rig.factory.removeDragonBonesData(rig.dragonBonesName, true);
  rig.app.destroy(true, { children: true, texture: false });
}
