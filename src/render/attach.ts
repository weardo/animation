// attach.ts — INTER-RIG scene-graph parenting (spec §8.1). The genuinely-ours, PURE compositor helper
// that resolves a layer's `attach` into a per-frame WORLD anchor: the parent layer's evaluated
// position, plus the offset of the named bone/slot MOUNT (read from the parent RIG DEF's `mounts`),
// plus any explicit `attach.offset`. The child layer is then rendered AT that anchor (its own
// transform composing on top), so a prop rides its parent's hand, a hat its head, a rider a vehicle.
//
// WHY a position-anchor (not a full matrix): a rig is a typed BLACK BOX (spec §8.1) — core never pokes
// a provider's live skeleton. A rig's library manifest declares each mount's APPROXIMATE local offset
// as DATA (`mounts[name].offset`), carried into the Scene-IR rig def by the loader. Composing the
// parent's `transform.position` + that mount offset gives a deterministic anchor with no provider
// coupling. `inherit` selects which parent channels propagate (default `["position"]`); rotation/scale
// inheritance scale/rotate the mount offset about the parent origin so the child tracks the parent's
// orientation. This is the spec's "transforms compose down the tree (camera → layer → parent → child)".
//
// DETERMINISM (CLAUDE.md r.1): a pure function of (layer graph, defs, frame, easings) via the shared
// `{a,k}` evaluator — no clock, no RNG. Resolution is single-level by design (a child attaches to ONE
// parent); a parent that is itself attached resolves its own anchor first (recursive, cycle-guarded).

import type { Defs, Easings, Layer, RigDef, RigMount, Transform } from '../ir/index.js';
import { evalNumber, evalVec2 } from './eval.js';

/** The resolved world placement of an attached child: where its local origin sits + inherited spin/size. */
export interface AttachAnchor {
  /** World position (px) the child's local origin is placed at. */
  position: [number, number];
  /** Inherited rotation (deg) from the parent chain (0 when `rotation` not inherited). */
  rotation: number;
  /** Inherited scale (1 = 100%) from the parent chain (1 when `scale` not inherited). */
  scale: number;
  /** Inherited opacity multiplier (1 when `opacity` not inherited). */
  opacity: number;
}

/** Pick a layer's `transform` (every renderable layer type carries an optional one). */
function transformOf(layer: Layer): Transform | undefined {
  return 'transform' in layer ? layer.transform : undefined;
}

/** Resolve the named mount (bone or slot) on a parent rig def → its local offset (px), or [0,0]. */
function mountOffset(rigDef: RigDef | undefined, bone?: string, slot?: string): [number, number] {
  const mounts = rigDef?.mounts;
  if (!mounts) return [0, 0];
  // Match by the requested bone/slot name; a mount entry may declare either field.
  for (const m of Object.values(mounts) as RigMount[]) {
    if (bone && m.bone === bone) return m.offset ?? [0, 0];
    if (slot && m.slot === slot) return m.offset ?? [0, 0];
  }
  // Also accept the mount keyed directly by the requested name (common authoring shorthand).
  const direct = (bone && mounts[bone]) || (slot && mounts[slot]);
  if (direct) return direct.offset ?? [0, 0];
  return [0, 0];
}

/** Rotate a local offset by `deg` (about the parent origin) so an inherited rotation carries the child. */
function rotateOffset([x, y]: [number, number], deg: number): [number, number] {
  if (deg === 0) return [x, y];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [x * c - y * s, x * s + y * c];
}

/**
 * Resolve a layer's `attach` to a world {@link AttachAnchor} at `frame`. Returns `null` when the layer
 * has no `attach` (the common case) or its parent id is missing. Recurses up the parent chain (a parent
 * that is itself attached), guarded against cycles by `seen`.
 */
export function resolveAttach(
  layer: Layer,
  layersById: Map<string, Layer>,
  defs: Defs,
  frame: number,
  easings: Easings,
  width: number,
  height: number,
  seen: ReadonlySet<string> = new Set(),
): AttachAnchor | null {
  if (layer.type !== 'rig' || !layer.attach) return null;
  const attach = layer.attach;
  const parent = layersById.get(attach.to);
  if (!parent || seen.has(layer.id)) return null;

  // Parent base anchor: if the parent is itself attached, resolve ITS anchor first (compose down the
  // tree); else the parent's own evaluated transform.position (default scene centre).
  const parentT = transformOf(parent);
  const parentAttach = resolveAttach(
    parent,
    layersById,
    defs,
    frame,
    easings,
    width,
    height,
    new Set([...seen, layer.id]),
  );
  const parentScale = (parentAttach?.scale ?? 1) * (evalNumber(parentT?.scale, frame, easings, 100) / 100);
  const parentRot = (parentAttach?.rotation ?? 0) + evalNumber(parentT?.rotation, frame, easings, 0);
  const parentOpacity = (parentAttach?.opacity ?? 1) * (evalNumber(parentT?.opacity, frame, easings, 100) / 100);
  const parentPos: [number, number] = parentAttach
    ? parentAttach.position
    : evalVec2(parentT?.position, frame, easings, [width / 2, height * 0.6]);

  // The named mount's local offset on the PARENT rig def, scaled + rotated by the parent's orientation
  // (so the child tracks where the bone/slot actually is as the parent moves), then the explicit offset.
  const parentRigDef = parent.type === 'rig' ? defs.rigs[parent.ref] : undefined;
  const local = mountOffset(parentRigDef, attach.bone, attach.slot);
  const scaledLocal: [number, number] = [local[0] * parentScale, local[1] * parentScale];
  const rotated = rotateOffset(scaledLocal, parentRot);
  const extra = attach.offset ?? [0, 0];

  const inherit = new Set(attach.inherit ?? ['position']);
  return {
    position: [parentPos[0] + rotated[0] + extra[0], parentPos[1] + rotated[1] + extra[1]],
    rotation: inherit.has('rotation') ? parentRot : 0,
    scale: inherit.has('scale') ? parentScale : 1,
    opacity: inherit.has('opacity') ? parentOpacity : 1,
  };
}
