// objectMarkup — the GENERALIZED prop builder OWNED by the core-objects provider (peer of
// blob-creature's characterMarkup). One function + an ObjectSpec → the SVG markup for a flat-vector
// Kurzgesagt prop, animated as a pure function of the frame. Returns an SVG markup STRING (a `<g>`
// centred on local origin) so it drives BOTH the runtime (injected via dangerouslySetInnerHTML) and
// offline previews (wrapped in an <svg>, rasterised) — exactly like characterMarkup.
//
// DETERMINISM (CLAUDE.md r.1): pure function of (spec, frame, fps, liveness). No Date.now/Math.random;
// idle motion is trig of frame/fps; numbers are fixed-precision so the STRING is byte-stable across
// runs and across processes. `liveness` gates the ambient idle (ADR-008 floor): false → static pose.

import type { ObjectSpec } from './spec.js';

const TAU = Math.PI * 2;
const f2 = (n: number): string => n.toFixed(2);

/** Five-point (or N-point) star path centred on origin, outer radius r, inner ratio 0.42. */
function starPath(r: number, points = 5): string {
  const inner = r * 0.42;
  const segs: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : inner;
    const a = (i / (points * 2)) * TAU - Math.PI / 2;
    segs.push(`${i === 0 ? 'M' : 'L'} ${f2(Math.cos(a) * rad)} ${f2(Math.sin(a) * rad)}`);
  }
  return segs.join(' ') + ' Z';
}

/** Gear/cog path: a toothed ring centred on origin, outer radius r, `teeth` teeth. */
function gearPath(r: number, teeth: number): string {
  const root = r * 0.82;
  const segs: string[] = [];
  const n = teeth * 2;
  for (let i = 0; i < n; i++) {
    const rad = i % 2 === 0 ? r : root;
    const a = (i / n) * TAU;
    segs.push(`${i === 0 ? 'M' : 'L'} ${f2(Math.cos(a) * rad)} ${f2(Math.sin(a) * rad)}`);
  }
  return segs.join(' ') + ' Z';
}

/**
 * Build the animated SVG markup for a prop at a frame. Drawn centred on local origin (0,0).
 * `liveness` (default true) gates ambient idle motion; false → a static neutral pose.
 */
export function objectMarkup(spec: ObjectSpec, frame: number, fps: number, liveness = true): string {
  const t = frame / fps;
  const P = spec.palette;
  const r = spec.size;
  const sw = spec.stroke;
  const amp = spec.motion.amp;
  const parts = spec.parts;

  switch (spec.kind) {
    case 'star': {
      // idle: twinkle (scale pulse) + a slow rotation.
      const pulse = liveness ? 1 + 0.06 * amp * Math.sin(t * TAU * 0.8) : 1;
      const spin = liveness ? Math.sin(t * TAU * 0.1) * 6 * amp : 0;
      const pts = parts.points ? Math.max(3, parseInt(parts.points, 10) || 5) : 5;
      return (
        `<g transform="scale(${pulse.toFixed(4)}) rotate(${f2(spin)})">` +
        `<path d="${starPath(r, pts)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}" stroke-linejoin="round"/>` +
        `<circle cx="${f2(-r * 0.18)}" cy="${f2(-r * 0.18)}" r="${f2(r * 0.16)}" fill="${P.accent}" opacity="0.6"/>` +
        `</g>`
      );
    }
    case 'cloud': {
      const drift = liveness ? Math.sin(t * TAU * 0.12) * 4 * amp : 0;
      const lobe = (cx: number, cy: number, rr: number): string =>
        `<circle cx="${f2(cx)}" cy="${f2(cy)}" r="${f2(rr)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}"/>`;
      return (
        `<g transform="translate(${f2(drift)} 0)">` +
        // base bar to merge lobes, drawn first under the lobes (no inner strokes show due to overlap)
        `<rect x="${f2(-r)}" y="${f2(-r * 0.1)}" width="${f2(r * 2)}" height="${f2(r * 0.55)}" rx="${f2(r * 0.27)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}"/>` +
        lobe(-r * 0.55, -r * 0.05, r * 0.4) +
        lobe(0, -r * 0.3, r * 0.5) +
        lobe(r * 0.55, -r * 0.08, r * 0.42) +
        `</g>`
      );
    }
    case 'tree': {
      const sway = liveness ? Math.sin(t * TAU * 0.25) * 2 * amp : 0;
      const trunkW = r * 0.22;
      const trunkH = r * 0.9;
      const detailed = parts.detail === 'detailed';
      return (
        `<g>` +
        `<rect x="${f2(-trunkW / 2)}" y="0" width="${f2(trunkW)}" height="${f2(trunkH)}" rx="${f2(trunkW * 0.3)}" fill="${P.fillDark}" stroke="${P.ink}" stroke-width="${sw}"/>` +
        `<g transform="rotate(${f2(sway)} 0 0)">` +
        `<circle cx="0" cy="${f2(-r * 0.5)}" r="${f2(r * 0.8)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}"/>` +
        (detailed
          ? `<circle cx="${f2(-r * 0.35)}" cy="${f2(-r * 0.7)}" r="${f2(r * 0.45)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}"/>` +
            `<circle cx="${f2(r * 0.35)}" cy="${f2(-r * 0.7)}" r="${f2(r * 0.45)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}"/>`
          : '') +
        `<circle cx="${f2(-r * 0.2)}" cy="${f2(-r * 0.6)}" r="${f2(r * 0.12)}" fill="${P.accent}" opacity="0.5"/>` +
        `</g></g>`
      );
    }
    case 'planet': {
      const bob = liveness ? Math.sin(t * TAU * 0.2) * 3 * amp : 0;
      const crescent = parts.variant === 'crescent';
      const ring =
        `<ellipse cx="0" cy="0" rx="${f2(r * 1.5)}" ry="${f2(r * 0.45)}" fill="none" stroke="${P.accent}" stroke-width="${f2(sw * 1.5)}" transform="rotate(-18)"/>`;
      return (
        `<g transform="translate(0 ${f2(bob)})">` +
        ring +
        `<circle cx="0" cy="0" r="${f2(r)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}"/>` +
        (crescent
          ? `<circle cx="${f2(r * 0.45)}" cy="${f2(-r * 0.1)}" r="${f2(r * 0.9)}" fill="${P.fillDark}" opacity="0.35"/>`
          : `<circle cx="${f2(-r * 0.3)}" cy="${f2(-r * 0.3)}" r="${f2(r * 0.22)}" fill="${P.accent}" opacity="0.4"/>`) +
        `</g>`
      );
    }
    case 'gear': {
      const spin = liveness ? (t * spec.motion.spinHz * 360) % 360 : 0;
      const teeth = parts.teeth ? Math.max(6, parseInt(parts.teeth, 10) || 8) : 8;
      return (
        `<g transform="rotate(${f2(spin)})">` +
        `<path d="${gearPath(r, teeth)}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}" stroke-linejoin="round"/>` +
        `<circle cx="0" cy="0" r="${f2(r * 0.3)}" fill="${P.fillDark}" stroke="${P.ink}" stroke-width="${sw}"/>` +
        `</g>`
      );
    }
    case 'arrow': {
      // direction set by parts.dir ("right"|"up"|"left"|"down"); static prop.
      const dir = parts.dir ?? 'right';
      const rot = dir === 'up' ? -90 : dir === 'left' ? 180 : dir === 'down' ? 90 : 0;
      const shaftW = r * 0.5;
      const headW = r * 1.0;
      const d =
        `M ${f2(-r)} ${f2(-shaftW / 4)} L ${f2(r * 0.3)} ${f2(-shaftW / 4)} ` +
        `L ${f2(r * 0.3)} ${f2(-headW / 2)} L ${f2(r)} 0 ` +
        `L ${f2(r * 0.3)} ${f2(headW / 2)} L ${f2(r * 0.3)} ${f2(shaftW / 4)} ` +
        `L ${f2(-r)} ${f2(shaftW / 4)} Z`;
      return (
        `<g transform="rotate(${rot})">` +
        `<path d="${d}" fill="${P.fill}" stroke="${P.ink}" stroke-width="${sw}" stroke-linejoin="round"/>` +
        `</g>`
      );
    }
    default:
      return '';
  }
}
