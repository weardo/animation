// Effects compositor (ADR-003 #2) — resolves a layer's Scene-IR `effects[]` stack into the three
// deterministic contribution channels the engine's `effects` registry produces, and applies them to a
// layer subtree. This is the THIN compositor glue (spec §4 "genuinely ours (small)") between the
// generic engine contract (EffectImpl/EffectContribution) and the per-frame DOM/SVG the renderer emits.
//
// The engine owns the generic registry + contract; the actual effects live in the core-effects plugin.
// Here we only (a) look each effect up by `kind` through `engine.effects`, (b) validate+build it for
// the current frame, and (c) COMPOSE the contributions in `effects[]` order:
//
//   • SVG <filter> primitives  → chained inside ONE <filter id="fx-<layer.id>">: each effect's output
//     `result` feeds the next effect's input (SourceGraphic → e0 → e1 → … → output). Deterministic
//     filter id from the layer id (mirrors the ShapeLayer gradient-id pattern) → byte-identical markup.
//   • CSS filter fragments     → concatenated in order into one `filter:` style.
//   • wrap(node)               → wraps the whole subtree (motion_blur's <Trail>, vignette overlay),
//     applied OUTERMOST in stack order (last effect wraps last → outermost).
//
// This composites cleanly ON TOP of the existing §11.1 shading drop-shadow + parallax: the shading
// filter stays on its own wrapper (Scene.tsx), and the authored effects stack is a SEPARATE wrapper
// applied around the sub-renderer, so the two never fight for the single CSS `filter` slot.
//
// DETERMINISM (CLAUDE.md r.1): pure function of (layer.effects, frame, registry). Each EffectImpl.build
// is pure; the filter id is content-derived; no clock, no RNG. SVG/CSS filters + motion-blur are
// frame-deterministic on the CPU raster default (no WebGL — that would be Tier-B, ADR-003).

import React from 'react';
import { effects as effectsRegistry } from '../engine/index.js';
import type { Effect } from '../ir/index.js';

/** The composed result of a layer's `effects[]` for one frame, ready to apply to the subtree. */
export interface ResolvedEffects {
  /** The SVG <filter> element (with a deterministic id) to reference, or null if no SVG-filter ops. */
  svgFilter: React.ReactNode | null;
  /** `filter:` style value combining `url(#id)` (if any) + all CSS fragments, or undefined. */
  cssFilter: string | undefined;
  /** Wrappers (in stack order) to apply around the subtree; outermost = last. Empty if none. */
  wraps: ReadonlyArray<(node: React.ReactNode) => React.ReactNode>;
}

/** Stable, collision-free filter id for a layer (mirrors ShapeLayer's gradient-id convention). */
function filterId(layerId: string): string {
  return `fx-${layerId}`;
}

/**
 * Resolve a layer's `effects[]` at `frame` into composed channels. Each entry's `{ kind, ...params }`
 * is looked up in the engine `effects` registry (throws loudly on an unknown kind), validated by the
 * effect's own Zod, and built into a contribution. SVG-filter primitives are chained; CSS fragments
 * concatenated; wraps collected. Returns empty channels when the layer has no `effects[]`.
 */
export function resolveEffects(
  layerId: string,
  effects: readonly Effect[] | undefined,
  frame: number,
): ResolvedEffects {
  if (!effects || effects.length === 0) {
    return { svgFilter: null, cssFilter: undefined, wraps: [] };
  }

  const cssParts: string[] = [];
  const wraps: Array<(node: React.ReactNode) => React.ReactNode> = [];
  // Each filter-primitive "stage" is the set of nodes one effect contributes, threaded by result names.
  const filterStages: React.ReactNode[] = [];
  let prevResult = 'SourceGraphic';
  let stageIndex = 0;

  for (let i = 0; i < effects.length; i++) {
    const entry = effects[i]!;
    const { kind, ...params } = entry as { kind: string } & Record<string, unknown>;
    const impl = effectsRegistry.get(kind); // throws on unknown kind (loud, lists registered)
    const parsed = impl.parse(params);
    const contribution = impl.build(parsed, frame);

    if (contribution.cssFilter) cssParts.push(contribution.cssFilter);
    if (contribution.wrap) wraps.push(contribution.wrap);

    if (contribution.filterPrimitives && contribution.filterPrimitives.length > 0) {
      // Thread this effect's primitives: in = prevResult, out = a fresh per-effect result name.
      // A single effect may emit several primitives; they share one in/out window (the effect wires
      // its own intermediate `-suffix` results internally and writes the final one to `outResult`).
      const outResult = `fx-${layerId}-${stageIndex}`;
      for (let j = 0; j < contribution.filterPrimitives.length; j++) {
        const builder = contribution.filterPrimitives[j]!;
        filterStages.push(
          <React.Fragment key={`s${stageIndex}-${j}`}>{builder(prevResult, outResult)}</React.Fragment>,
        );
      }
      prevResult = outResult;
      stageIndex++;
    }
  }

  let svgFilter: React.ReactNode | null = null;
  let css: string | undefined;
  if (filterStages.length > 0) {
    const id = filterId(layerId);
    svgFilter = (
      <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden data-effects={layerId}>
        <defs>
          <filter id={id} x="-30%" y="-30%" width="160%" height="160%" colorInterpolationFilters="sRGB">
            {filterStages}
          </filter>
        </defs>
      </svg>
    );
    css = `url(#${id})`;
  }

  // CSS fragments append after the SVG filter reference (so e.g. drop_shadow follows the SVG chain).
  const allCss = [css, ...cssParts].filter(Boolean).join(' ');
  return {
    svgFilter,
    cssFilter: allCss.length > 0 ? allCss : undefined,
    wraps,
  };
}

/**
 * Apply resolved effects to a sub-renderer node: emit the SVG <filter> def, wrap the node in a div
 * carrying the combined `filter:` style, then apply each `wrap` (outermost = last effect). Returns the
 * node unchanged when there are no effects (backward-compatible: layers without `effects[]` untouched).
 */
export function applyEffects(
  resolved: ResolvedEffects,
  layerId: string,
  node: React.ReactNode,
): React.ReactNode {
  const { svgFilter, cssFilter, wraps } = resolved;
  if (!svgFilter && !cssFilter && wraps.length === 0) return node;

  let out: React.ReactNode = cssFilter ? (
    <div style={{ position: 'absolute', inset: 0, filter: cssFilter }} data-fx={layerId}>
      {node}
    </div>
  ) : (
    node
  );

  // wraps applied in order → the last effect's wrap ends up outermost.
  for (const wrap of wraps) out = wrap(out);

  return (
    <>
      {svgFilter}
      {out}
    </>
  );
}
