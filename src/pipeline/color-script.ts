// Color-script (spec §11.4) — the PURE color machinery for the lowering pass. Resolves a beat's
// `mood`/`palette` intent into a concrete per-scene palette over the stylekit base, and INTERPOLATES
// two palettes in OKLab (a perceptual color space) so a mood change reads as a smooth global shift.
//
// Adopts `culori` (Tier-A, already a dep) for OKLab interpolation — we never hand-roll color math
// (CLAUDE.md rule 3 "reuse over invent"). DETERMINISTIC: pure functions of (palettes, t); no
// wall-clock, no RNG. The output is a flat token map (`Palette`) the renderer reads as `scene.palette`.

import { interpolate as culoriInterpolate, formatHex } from 'culori';
import type { Palette } from '../ir/index.js';

/**
 * Resolve a beat's color intent into the FULL token set for its scene, layered most-specific-last:
 *   base stylekit palette  ←  named `mood` palette (if any)  ←  inline `palette` override (if any).
 * A token absent from the more-specific layer keeps the base value; a new token introduced by an
 * override is added. Pure structural merge — no color math here (that is {@link interpolatePalettes}).
 *
 * @param base   the resolved stylekit palette (`defs.palette` seed) — every token a scene may use.
 * @param mood   the resolved named-mood token map (from a `palette` library entry), or undefined.
 * @param inline the beat's inline `palette` override token map, or undefined.
 */
export function resolveScenePalette(
  base: Palette,
  mood: Palette | undefined,
  inline: Palette | undefined,
): Palette {
  return { ...base, ...(mood ?? {}), ...(inline ?? {}) };
}

/**
 * The DIFF of a fully-resolved scene palette vs the base — only the tokens whose color CHANGED (or are
 * new). This is what the Scene IR carries as `scene.palette` (a minimal override the renderer merges
 * over `defs.palette`), so a scene with no mood shift carries nothing. Colors are compared by their
 * normalized hex so `#FFF` vs `#ffffff` don't spuriously diff.
 */
export function paletteDiff(resolved: Palette, base: Palette): Palette {
  const out: Palette = {};
  for (const [token, color] of Object.entries(resolved)) {
    const baseColor = base[token];
    if (baseColor === undefined || normHex(color) !== normHex(baseColor)) {
      out[token] = color;
    }
  }
  return out;
}

/** Normalize a color string to a comparable lowercase hex (best-effort; falls back to the input). */
function normHex(color: string): string {
  const hex = formatHex(color);
  return (hex ?? color).toLowerCase();
}

/**
 * Interpolate two palettes token-by-token in OKLab at fraction `t` ∈ [0,1] (0 = `from`, 1 = `to`),
 * via culori's perceptual `interpolate(..., 'oklab')`. A token present in only ONE palette is carried
 * through unchanged (nothing to blend toward). Returns a flat blended token map. Deterministic: a pure
 * function of (from, to, t) — culori does fixed float math, no RNG/clock.
 *
 * Used by the lowering color-script pass to compute the entering scene's palette at the LEADING EDGE of
 * a transition (a blend toward the previous scene's palette), so a mood change cross-fades coherently
 * across the boundary rather than snapping (spec §11.4 "palettes interpolate across a transition").
 */
export function interpolatePalettes(from: Palette, to: Palette, t: number): Palette {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const out: Palette = {};
  const tokens = new Set([...Object.keys(from), ...Object.keys(to)]);
  for (const token of tokens) {
    const a = from[token];
    const b = to[token];
    if (a === undefined) {
      out[token] = b as string;
    } else if (b === undefined) {
      out[token] = a;
    } else {
      // OKLab perceptual blend (culori). `formatHex` yields a deterministic #rrggbb the renderer reads.
      const mix = culoriInterpolate([a, b], 'oklab')(clamped);
      out[token] = formatHex(mix) ?? b;
    }
  }
  return out;
}
