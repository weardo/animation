// Pipeline pass P0 — Parse + validate a story script (YAML) → Story IR. Spec §5, §6.1, §15.
//
// A PURE function: `(yamlText) → StoryIR`. No wall-clock, no Math.random, no I/O — the caller
// supplies the script text (the CLI reads the file; this pass only transforms a string). The
// boundary contract is enforced by Zod (spec §4: validate at every IR arrow) via `validateStoryIR`,
// which applies defaults (e.g. `characters: {}`) and throws a labelled error on malformed input.
//
// We also derive deterministic, content-addressed values here that the LOWERING pass (P5) needs:
//   • `storyHash(story)` — a stable hash of the Story IR (for Scene-IR `provenance.story_ir_hash`),
//   • `deriveSeed(...)`  — a deterministic seed for seeded generators, derived from the story hash +
//     a stable label (so a generator's seed is a pure function of the story, never a wall-clock).
//
// 'yaml' is the parser (spec stack decision); 'object-hash' is the content-addressing primitive
// (spec §13.2 / §4). Both are pure over their inputs.

import { parse as parseYaml } from 'yaml';
import objectHash from 'object-hash';
import { validateStoryIR, type StoryIR } from '../ir/index.js';

/** This pass's id + version — folded into cache keys / provenance by the orchestrator (spec §5). */
export const PASS_ID = 'parse';
export const PASS_VERSION = '1.0';

/**
 * P0: parse a YAML story script into a validated Story IR.
 *
 * Pure: same `yamlText` ⇒ same `StoryIR`. Steps:
 *   1. `yaml.parse` the text into a plain JS value (throws on invalid YAML syntax),
 *   2. Zod-validate against `StoryIRSchema` (throws a labelled IR error; applies schema defaults).
 *
 * @param yamlText raw `script.yaml` contents (the CLI is responsible for reading the file).
 * @returns the validated, defaults-applied Story IR.
 */
export function parseStory(yamlText: string): StoryIR {
  const raw: unknown = parseYaml(yamlText);
  if (raw === null || raw === undefined) {
    throw new Error('IR validation failed (Story IR):\n  - <root>: empty document');
  }
  return validateStoryIR(raw);
}

/**
 * Content hash of a Story IR. `object-hash` canonicalizes key order, so the hash is a pure
 * function of the IR's *content* regardless of authoring/field order. Tagged `sha1:` for clarity
 * (matches the spec's `story_ir_hash:"sha256:…"` shape — the algorithm prefix is explicit).
 */
export function storyHash(story: StoryIR): string {
  return `sha1:${objectHash(story, { algorithm: 'sha1', encoding: 'hex' })}`;
}

/**
 * Derive a deterministic integer seed from a story hash + a stable label (e.g. a beat id or a
 * layer handle). This is the seed source for seeded generators (spec §2/§10: seeded RNG only).
 *
 * Uses a cyrb53-style string hash over `hash + ':' + label` → a non-negative 31-bit integer
 * (fits the Scene-IR generator `seed: z.number().int()` field and stays well within JS safe-int).
 * Pure and stable: same (hash, label) ⇒ same seed, on every machine, with no wall-clock.
 */
export function deriveSeed(hash: string, label: string): number {
  const str = `${hash}:${label}`;
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
  // Combine to a non-negative 31-bit integer (deterministic, platform-independent).
  return (h2 >>> 0) % 0x7fffffff;
}
