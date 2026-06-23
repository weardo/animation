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
import { lightVector, type Light, type Paint, type ShadingSpec } from './stylekit.js';
import { backdropGradient } from './paint.js';

/**
 * Merge an authored (partial) light over the DEFAULT light — which now comes from the SELECTED
 * stylekit (`defs.stylekit.light`), passed in by the compositor (ADR-008 I2). No core light constant.
 */
export function resolveLight(
  light: Partial<Light> | undefined,
  defaultLight: Light,
): Light {
  return { ...defaultLight, ...(light ?? {}) };
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
 * Merge authored per-layer shading onto the DEFAULT shading — which now comes from the SELECTED
 * stylekit (`defs.stylekit.shading`), passed in by the compositor (ADR-008 I2). Field-by-field with
 * `??` (NOT a spread) so an explicit-`undefined` field falls back to the default instead of
 * clobbering it. No core shading constant.
 */
export function resolveShading(
  s: ShadingInput | undefined,
  defaultShading: ShadingSpec,
): ShadingSpec {
  return {
    form: s?.form ?? defaultShading.form,
    contact_shadow: s?.contact_shadow ?? defaultShading.contact_shadow,
    rim: s?.rim ?? defaultShading.rim,
    ao: s?.ao ?? defaultShading.ao,
    glow: s?.glow ?? defaultShading.glow,
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
export const SceneLook: React.FC<{
  light?: Partial<Light> | undefined;
  defaultLight: Light;
  /** Optional paint model — its `atmosphere.vignette` scales the vignette strength (design §3). */
  paint?: Paint | undefined;
}> = ({ light, defaultLight, paint }) => {
  const L = resolveLight(light, defaultLight);
  const v = lightVector(L.dir);
  // gradient runs along the light direction: lit color at the source side → cool shade opposite.
  const angle = (Math.atan2(-v.y, -v.x) * 180) / Math.PI + 90;
  const litA = 0.18 * L.intensity;
  const shadeA = 0.26 * (1 - L.ambient);
  // Vignette strength: the paint model's `atmosphere.vignette` (design §3) when present; else the
  // long-standing default 0.42 (so existing demos are unchanged when no paint is set).
  const vig = paint ? Math.max(0, Math.min(0.95, paint.atmosphere.vignette)) : 0.42;
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
          background: `radial-gradient(125% 105% at 50% 40%, rgba(0,0,0,0) 56%, rgba(4,6,12,${vig.toFixed(3)}) 100%)`,
        }}
      />
    </AbsoluteFill>
  );
};

/**
 * Scene ATMOSPHERE (design §3) — the dark rich BACKDROP gradient + a warm FOCAL light pool, rendered
 * BEHIND the world (the first thing painted) so every layer sits in an atmospheric space like the
 * reference frames. Screen-space, static per frame (pure CSS gradients) → deterministic. Gated by the
 * caller (`floor.shading` + a `paint` present); returns null when there is no backdrop authored.
 *
 *   • BACKDROP — a top→bottom linear gradient over `paint.atmosphere.backdrop` (deep rich base).
 *   • FOCAL    — a soft radial pool (`paint.atmosphere.focal`) of warm light over the centre of
 *     interest, screen-blended so it adds luminance without washing the backdrop flat.
 */
export const Atmosphere: React.FC<{ paint: Paint }> = ({ paint }) => {
  const bg = backdropGradient(paint);
  if (!bg) return null;
  const f = paint.atmosphere.focal;
  const radiusPct = (Math.max(0, Math.min(1, f.radius)) * 100).toFixed(0);
  const focal =
    f.intensity > 0
      ? `radial-gradient(${radiusPct}% ${radiusPct}% at 50% 42%, ${rgba(f.color, Math.min(1, f.intensity))} 0%, rgba(0,0,0,0) 70%)`
      : undefined;
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }} data-atmosphere>
      <AbsoluteFill style={{ background: bg }} />
      {focal ? (
        <AbsoluteFill style={{ background: focal, mixBlendMode: 'screen' }} />
      ) : null}
    </AbsoluteFill>
  );
};
