// Clip (nested-composition) render helpers — PURE param substitution + per-instance namespacing/seed
// derivation for the `clip` layer (M2). Spec §13.3 + the clip design doc §5/§6. These are the only
// genuinely-ours pieces of the precomp render; the timeline itself is Remotion's `<Sequence>` (never
// reimplemented). All functions here are pure (a function of their inputs) so a clip used twice with
// different args renders DISTINCTLY yet each byte-identically across cold processes (CLAUDE.md r.1).
//
// THE ESSENTIAL-GRAPHICS RULE (AE / .mogrt): only props a clip author WIRED to a param via
// `{ "$param": "name" }` (any value) or a `"…{{name}}…"` string are overridable per instance; a prop
// not wired to a param is fixed by the author. `resolveParams` substitutes those references from the
// merged `{ ...defaults, ...instanceArgs }` map, leaving everything else untouched.

import type { ClipParam } from '../ir/index.js';

/** A param-reference object `{ "$param": "name" }` (substituted with the param's value, any type). */
function isParamRef(v: unknown): v is { $param: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    '$param' in v &&
    typeof (v as { $param: unknown }).$param === 'string'
  );
}

/** Stringify a param value for `{{}}` string interpolation (deterministic, locale-independent). */
function stringifyParam(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Substitute `{{name}}` occurrences in a string with the corresponding param value (stringified).
 * An unknown `{{name}}` is left verbatim (so a literal brace pair is harmless). Pure.
 */
function interpolateString(s: string, values: Record<string, unknown>): string {
  return s.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, name: string) =>
    name in values ? stringifyParam(values[name]) : whole,
  );
}

/**
 * Recursively substitute `$param`/`{{}}` references in a clip layer TEMPLATE against the resolved
 * param `values` (the merged `{ ...defaults, ...instanceArgs }`). Returns a NEW value (never mutates
 * the shared def). Rules:
 *   • `{ "$param": "name" }`         → `values[name]` verbatim (any type; the AE master-property).
 *   • a string containing `{{name}}` → that name's value spliced in (string interpolation).
 *   • arrays / plain objects         → mapped recursively.
 *   • everything else                → returned unchanged.
 * Pure + deterministic — a function of (template, values) only.
 */
export function resolveParams<T = unknown>(template: T, values: Record<string, unknown>): T {
  return resolveValue(template, values) as T;
}

function resolveValue(v: unknown, values: Record<string, unknown>): unknown {
  if (isParamRef(v)) {
    return values[v.$param];
  }
  if (typeof v === 'string') {
    return interpolateString(v, values);
  }
  if (Array.isArray(v)) {
    return v.map((item) => resolveValue(item, values));
  }
  if (typeof v === 'object' && v !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = resolveValue(val, values);
    }
    return out;
  }
  return v;
}

/**
 * Merge a clip def's param DEFAULTS with the per-instance `args` overrides → the resolved value map
 * `resolveParams` substitutes. Defaults come from `params[name].default`; an instance `arg` of the
 * same name wins (the override). Only EXPOSED params (keys of `params`) get a default; an instance arg
 * for an unexposed name still passes through (loose at the boundary), but a template can only reference
 * exposed ones meaningfully. Pure.
 */
export function mergeParamValues(
  params: Record<string, ClipParam> | undefined,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, p] of Object.entries(params ?? {})) {
    if (p.default !== undefined) out[name] = p.default;
  }
  for (const [name, v] of Object.entries(args ?? {})) {
    out[name] = v;
  }
  return out;
}

/**
 * The namespaced effective id of an inner layer of a clip instance: `<clipLayerId>/<innerId>`. So the
 * SAME clip used twice (two different clip-layer ids) yields distinct inner ids that never collide,
 * and nesting composes (`outer/inner/leaf`). Pure.
 */
export function namespaceId(clipLayerId: string, innerId: string): string {
  return `${clipLayerId}/${innerId}`;
}

/**
 * Derive a deterministic non-negative 31-bit seed from a (namespaced) string id — the SAME cyrb53
 * mixing the lowering pass uses (pipeline/parse.ts `deriveSeed`), re-implemented locally so the
 * renderer doesn't depend on the pipeline. A clip's generator seed is therefore a pure function of its
 * per-instance namespaced id (`hash(<clipLayerId>/<innerId>)`): two instances of one clip get
 * DISTINCT seeds (different namespaces) yet each is stable across runs — never baked into the shared
 * def. Pure + platform-independent.
 */
export function deriveClipSeed(namespacedId: string): number {
  const str = namespacedId;
  let h1 = 0xdeadbeef ^ str.length;
  let h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) % 0x7fffffff;
}
