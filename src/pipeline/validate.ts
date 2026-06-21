// V — Validate Scene IR at the pipeline boundary. Spec §5 ("Validate Scene IR (Zod)"), §14.4
// (two-IR contract drift mitigation: "Zod validation at every arrow"). CLAUDE.md golden rule 4.
//
// This is the pipeline-side wrapper over the IR module's `validateSceneIR` (src/ir/validate.ts).
// It exists so the composition (`index.ts`) calls a pass-shaped function, and so the boundary has a
// pass identity for provenance/caching. The lowered passes (layout, camera) leave the IR in final
// Scene-IR shape (anchors resolved, camera_intent expanded); this pass proves that — turning the
// loosely-typed `LoweredSceneIR` into a guaranteed-valid `SceneIR` (defaults applied, strict-checked).

import { validateSceneIR } from '../ir/index.js';
import type { SceneIR } from '../ir/index.js';
import type { LoweredSceneIR } from './contract.js';

/** Pass identity for cache keys / provenance (spec §5: per-stage versioning). */
export const VALIDATE_PASS = 'validate@0.1' as const;

/**
 * Run the Zod Scene-IR validation at the boundary. Accepts the lowered IR (which, after layout+camera,
 * should already be in final form) as `unknown` and returns a strict, defaults-applied {@link SceneIR}.
 * Throws (via `validateSceneIR`) with a readable, path-annotated message if anything is off — e.g. a
 * leftover `anchor`/`camera_intent` (strict schema rejects unknown keys) signals a pass wiring bug.
 */
export function validate(ir: LoweredSceneIR | unknown): SceneIR {
  return validateSceneIR(ir);
}
