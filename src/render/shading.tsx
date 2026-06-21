// Shading & Depth model (spec §11.1) — the compositor pieces that give every object Kurzgesagt
// depth from a single scene LIGHT: per-object supporting shapes (contact shadow, rim/AO, glow) +
// a scene-level directional light wash + vignette.
//
// Design (spec §11.1): depth is COMPOSITIONAL, not post-processing, and DEFAULT-ON (quality floor).
//   • <SceneLook>     — screen-space directional light gradient (consistent with `light.dir`) +
//                       vignette. One coherent lit space. Rendered ABOVE the world, below nothing.
//   • <ContactShadow> — a soft gradient ellipse seating a floating object on the ground, offset
//                       AWAY from the light and flattened by elevation. Rendered just behind its
//                       object (same z-slot), inside the camera transform so it tracks the object.
//   • objectFilter()  — a CSS drop-shadow stack (silhouette-following) for rim/AO/glow; works
//                       uniformly on SVG layers AND the Pixi rig <canvas>.
//
// DETERMINISM (CLAUDE.md r.1): everything here is a static style for a given frame — gradients +
// filters + a position the caller evaluated deterministically. No clock, no RNG. The look is the
// same bytes every run (verified via the swangle/decoded-stream check).

import React from 'react';
import { AbsoluteFill } from 'remotion';
import { DEFAULT_LIGHT, DEFAULT_SHADING, lightVector, type Light, type ShadingSpec } from './stylekit.js';

/** Merge an authored (partial) light with the StyleKit default → the effective scene light. */
export function resolveLight(light?: Partial<Light> | undefined): Light {
  return { ...DEFAULT_LIGHT, ...(light ?? {}) };
}

/** The IR's per-layer shading shape (every field optional and possibly explicit-undefined). */
type ShadingInput = {
  form?: boolean | undefined;
  contact_shadow?: boolean | undefined;
  rim?: number | undefined;
  ao?: boolean | undefined;
  glow?: number | undefined;
};

/**
 * Merge authored per-layer shading onto the default-on StyleKit shading. Field-by-field with `??`
 * (NOT a spread) so an explicit-`undefined` field falls back to the default instead of clobbering it.
 */
export function resolveShading(s?: ShadingInput | undefined): ShadingSpec {
  return {
    form: s?.form ?? DEFAULT_SHADING.form,
    contact_shadow: s?.contact_shadow ?? DEFAULT_SHADING.contact_shadow,
    rim: s?.rim ?? DEFAULT_SHADING.rim,
    ao: s?.ao ?? DEFAULT_SHADING.ao,
    glow: s?.glow ?? DEFAULT_SHADING.glow,
  };
}

/** #rrggbb (or #rgb) → `rgba(r,g,b,a)`. Pure; tolerant of a leading '#'. */
function rgba(hex: string, alpha: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * The CSS `filter` for an object's silhouette-following shading: a warm rim drop-shadow on the lit
 * side, an ambient-occlusion drop-shadow on the shadow side, and an optional emissive glow. Returns
 * undefined when nothing applies (so the wrapper can be skipped). drop-shadow follows the alpha
 * silhouette, so this works for SVG content and the transparent-background Pixi canvas alike.
 */
export function objectFilter(shading: ShadingSpec, light: Light): string | undefined {
  const parts: string[] = [];
  const v = lightVector(light.dir);
  if (shading.glow > 0) {
    parts.push(`drop-shadow(0 0 ${(12 * shading.glow).toFixed(1)}px ${rgba(light.color, 0.9)})`);
  }
  if (shading.rim > 0) {
    // bright rim on the lit side (offset toward the light)
    parts.push(
      `drop-shadow(${(v.x * 2.5).toFixed(2)}px ${(v.y * 2.5).toFixed(2)}px 0.6px ${rgba(light.color, 0.55 * shading.rim)})`,
    );
  }
  if (shading.ao) {
    // ambient-occlusion / contact darkening on the shadow side (offset away from light, downward)
    parts.push(`drop-shadow(${(-v.x * 2).toFixed(2)}px ${(-v.y * 2 + 2.5).toFixed(2)}px 3px rgba(6,10,20,0.35))`);
  }
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * A soft contact/cast shadow ellipse seating an object on the ground. `(x,y)` is the object's
 * anchor (its evaluated screen position); `r` is its footprint radius. The shadow sits below the
 * object, shifts AWAY from the light, and flattens as the light elevation rises.
 */
export const ContactShadow: React.FC<{
  x: number;
  y: number;
  r: number;
  light: Light;
}> = ({ x, y, r, light }) => {
  const v = lightVector(light.dir);
  const elev = Math.max(0.2, Math.sin((light.elevation * Math.PI) / 180));
  const rx = r * 1.05;
  const ry = (r * 0.34) / Math.max(0.5, elev); // higher sun → tighter (less tall) shadow
  // sit under the object's base; nudge opposite the light's horizontal direction
  const cx = x - v.x * r * 0.45;
  const cy = y + r * 0.62 - v.y * r * 0.12;
  return (
    <div
      style={{
        position: 'absolute',
        left: cx - rx,
        top: cy - ry,
        width: rx * 2,
        height: ry * 2,
        borderRadius: '50%',
        background: `radial-gradient(closest-side, ${rgba('#060a14', 0.36)} 0%, ${rgba('#060a14', 0.18)} 55%, rgba(0,0,0,0) 78%)`,
        pointerEvents: 'none',
      }}
    />
  );
};

/**
 * The scene-level look: a directional light wash consistent with `light.dir` (soft-light blended so
 * it tints rather than washes) plus a vignette for depth/premium finish. Screen-space — render this
 * ABOVE the world (outside the camera transform) so it stays put as the camera moves.
 */
export const SceneLook: React.FC<{ light?: Partial<Light> | undefined }> = ({ light }) => {
  const L = resolveLight(light);
  const v = lightVector(L.dir);
  // gradient runs along the light direction: lit color at the source side → cool shade opposite.
  const angle = (Math.atan2(-v.y, -v.x) * 180) / Math.PI + 90;
  const litA = 0.18 * L.intensity;
  const shadeA = 0.26 * (1 - L.ambient);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <AbsoluteFill
        style={{
          background: `linear-gradient(${angle.toFixed(0)}deg, ${rgba(L.color, litA)} 0%, rgba(0,0,0,0) 48%, ${rgba('#05070e', shadeA)} 100%)`,
          mixBlendMode: 'soft-light',
        }}
      />
      <AbsoluteFill
        style={{
          background: `radial-gradient(125% 105% at 50% 40%, rgba(0,0,0,0) 56%, rgba(4,6,12,0.42) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};
