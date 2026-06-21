// <Scene> — the per-frame COMPOSITOR. Spec §3 ("Remotion as compositor"), §6.2, §7, §9, §15 (M1).
//
// Takes one Scene-IR `scene` (and the scene `defs`) and renders all of its layers in z-order, each
// driven by Remotion's `useCurrentFrame()`. This is the thin per-frame glue (spec §4 "genuinely
// ours (small)") that composes the work of the rig + generator + asset sub-renderers into one frame:
//
//   1. CAMERA as a parent transform. The scene `camera.position`/`camera.zoom` are `{a,k}` props
//      evaluated at the current frame; the whole layer stack is scaled (zoom) about the composition
//      centre and translated by `-cameraPosition` (camera pans right ⇒ the world shifts left).
//   2. PER-LAYER PARALLAX (2.5D depth, spec §9). Each layer carries a `parallax` factor (asset
//      layers explicitly; others default to fully-attached = 1). On top of the camera parent, a
//      layer is shifted by `cameraPosition * (1 - parallax)`: a far layer (parallax→0) gets the full
//      counter-shift so it appears static, a near layer (parallax→1) gets none so it rides the
//      camera. This is exactly the spec's "offset by camera position * (1 - parallax)".
//   3. Z-ORDER. Layers are sorted by `z` ascending (higher = front) and stacked in that order.
//   4. DISPATCH by layer `type` to the right sub-renderer: `asset` → <AssetLayer>, `generator` →
//      <GeneratorLayer> (src/generators), `rig` → <RigLayer> (src/rig). Each sub-renderer reads the
//      frame clock itself and resolves its own `{a,k}` channels with StyleKit easing.
//
// DETERMINISM (CLAUDE.md r.1): pure function of (scene, defs) + `useCurrentFrame()`. No Date.now /
// Math.random; every animated value flows through the seeded/StyleKit-eased evaluator (eval.ts).

import React, { useMemo } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import type { Defs, Easings, Layer, Scene as SceneIR } from '../ir/index.js';
import { RigLayer } from '../rig/index.js';
import { GeneratorLayer } from '../generators/index.js';
import { AssetLayer } from './AssetLayer.js';
import { evalNumber, evalVec2 } from './eval.js';
import type { Light } from './stylekit.js';
import {
  ContactShadow,
  objectFilter,
  resolveLight,
  resolveShading,
  SceneLook,
} from './shading.js';

export interface SceneProps {
  /** One Scene-IR `scene` (its layers + camera + labels). */
  scene: SceneIR;
  /** The Scene-IR `defs` (palette / easings / assets / rigs) the layers resolve against. */
  defs: Defs;
}

/**
 * The parallax factor for a layer. Asset layers carry an explicit `parallax`; every other layer
 * type is treated as fully camera-attached (factor 1 ⇒ no parallax counter-shift), which is the
 * right default for foreground subjects (rig/generator) that should ride the camera.
 */
function layerParallax(layer: Layer): number {
  return layer.type === 'asset' ? layer.parallax : 1;
}

export const Scene: React.FC<SceneProps> = ({ scene, defs }) => {
  const frame = useCurrentFrame();
  const easings: Easings = defs.easings ?? {};
  // Effective scene light (default-on StyleKit light when none authored) — drives all shading (§11.1).
  const light = resolveLight(scene.light);

  // --- 1. Camera (evaluated at this frame) → parent transform values ---
  const [camX, camY] = evalVec2(scene.camera.position, frame, easings, [0, 0]);
  const zoom = evalNumber(scene.camera.zoom, frame, easings, 1);

  // --- 3. Z-order: sort a COPY by `z` ascending (stable; higher z paints last → front) ---
  const ordered = useMemo(
    () => scene.layers.map((l, i) => ({ l, i })).sort((a, b) => a.l.z - b.l.z || a.i - b.i),
    [scene.layers],
  );

  // The camera parent: scale about the centre (zoom), then translate by -cameraPosition so a pan
  // moves the world opposite the camera. transformOrigin centre keeps zoom anchored to the middle.
  const cameraStyle: React.CSSProperties = {
    transform: `scale(${zoom}) translate(${-camX}px, ${-camY}px)`,
    transformOrigin: 'center center',
  };

  return (
    <AbsoluteFill data-scene={scene.id}>
      <AbsoluteFill style={cameraStyle}>
        {ordered.map(({ l }) => {
          // --- 2. Per-layer parallax counter-shift: cameraPosition * (1 - parallax) ---
          const p = layerParallax(l);
          const parallaxOffset: readonly [number, number] = [camX * (1 - p), camY * (1 - p)];
          return (
            <LayerView
              key={l.id}
              layer={l}
              defs={defs}
              easings={easings}
              parallaxOffset={parallaxOffset}
              light={light}
            />
          );
        })}
      </AbsoluteFill>
      {/* --- Scene-level look (screen-space): directional light wash + vignette (§11.1) --- */}
      <SceneLook light={scene.light} />
    </AbsoluteFill>
  );
};

interface LayerViewProps {
  layer: Layer;
  defs: Defs;
  easings: Easings;
  parallaxOffset: readonly [number, number];
  light: Light;
}

/** Build the bare sub-renderer for a layer (no shading). Asset layers fold parallax themselves. */
function renderSub(
  layer: Layer,
  defs: Defs,
  easings: Easings,
  parallaxOffset: readonly [number, number],
): React.ReactNode {
  switch (layer.type) {
    case 'asset': {
      const assetDef = defs.assets[layer.ref];
      if (!assetDef) {
        throw new Error(`Scene IR: asset layer "${layer.id}" references unknown asset "${layer.ref}".`);
      }
      return (
        <AssetLayer layer={layer} assetDef={assetDef} easings={easings} parallaxOffset={parallaxOffset} />
      );
    }
    case 'generator':
      return (
        <ParallaxWrapper offset={parallaxOffset} id={layer.id}>
          <GeneratorLayer layer={layer} palette={defs.palette} />
        </ParallaxWrapper>
      );
    case 'rig': {
      const rigDef = defs.rigs[layer.ref];
      if (!rigDef) {
        throw new Error(`Scene IR: rig layer "${layer.id}" references unknown rig "${layer.ref}".`);
      }
      return (
        <ParallaxWrapper offset={parallaxOffset} id={layer.id}>
          <RigLayer layer={layer} rigDef={rigDef} easings={easings} />
        </ParallaxWrapper>
      );
    }
    case 'shape':
      // Minimal placeholder (morph lands later); keep z-order/keys stable.
      return <AbsoluteFill data-shape-layer={layer.id} />;
    default: {
      const _exhaustive: never = layer;
      return _exhaustive;
    }
  }
}

/**
 * Dispatch one layer to its sub-renderer, then apply the Shading & Depth model (§11.1):
 *   • a CONTACT SHADOW behind floating objects (the rig), seated by the scene light;
 *   • a silhouette-following OBJECT FILTER (rim/AO/glow) on every non-background layer.
 * The full-frame background asset is exempt (it receives only the scene-level look). Shading is
 * default-on via StyleKit (`resolveShading`), overridable per layer. Determinism is preserved:
 * filters/gradients are static styles; the contact-shadow anchor is a deterministically-evaluated
 * position.
 */
const LayerView: React.FC<LayerViewProps> = ({ layer, defs, easings, parallaxOffset, light }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const sub = renderSub(layer, defs, easings, parallaxOffset);
  const shading = resolveShading(layer.shading);

  // The full-frame background (an asset with no authored position) gets no per-object shading.
  const isBackground = layer.type === 'asset' && layer.transform?.position === undefined;
  const filter = isBackground ? undefined : objectFilter(shading, light);

  // Contact shadow: floating subjects that sit in the scene — the rig (and any positioned object).
  let contact: React.ReactNode = null;
  if (shading.contact_shadow && layer.type === 'rig') {
    const t = layer.transform;
    const [px, py] = evalVec2(t?.position, frame, easings, [width / 2, height * 0.6]);
    const scale = evalNumber(t?.scale, frame, easings, 100) / 100;
    contact = (
      <AbsoluteFill style={{ pointerEvents: 'none' }} data-contact-shadow={layer.id}>
        <ContactShadow x={px} y={py} r={140 * scale} light={light} />
      </AbsoluteFill>
    );
  }

  const shaded = filter ? (
    <AbsoluteFill style={{ filter }} data-shaded={layer.id}>
      {sub}
    </AbsoluteFill>
  ) : (
    sub
  );

  return (
    <>
      {contact}
      {shaded}
    </>
  );
};

/** A thin absolute wrapper that applies a camera-driven parallax translate to a sub-renderer. */
const ParallaxWrapper: React.FC<{
  offset: readonly [number, number];
  id: string;
  children: React.ReactNode;
}> = ({ offset, id, children }) => {
  const [dx, dy] = offset;
  // Skip the wrapper transform entirely when there is no shift (the common foreground case).
  if (dx === 0 && dy === 0) return <>{children}</>;
  return (
    <AbsoluteFill
      data-parallax={id}
      style={{ transform: `translate(${dx}px, ${dy}px)` }}
    >
      {children}
    </AbsoluteFill>
  );
};

export default Scene;
