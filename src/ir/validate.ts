// Validation helpers + JSON-Schema export. Spec §4 (Zod single source of truth), §5 (validate at
// every IR boundary), §14.4 (two-IR contract drift mitigation).
//
// `validate()` parses+throws (boundary guard), `safeValidate()` returns a typed result, and per-IR
// convenience wrappers (validateStoryIR / validateSceneIR) make the call sites self-documenting.
// JSON-Schema export feeds the future LLM front-end (authoring/repair against a published schema).

import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { StoryIRSchema, type StoryIR } from './story.js';
import {
  SceneIRSchema,
  LayerSchema,
  type SceneIR,
  type Layer,
} from './scene.js';

/**
 * Parse `input` against `schema`, throwing a ZodError on failure. Use at IR boundaries where an
 * invalid value is a hard pipeline error. Returns the parsed (defaults-applied) value, typed.
 */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown,
  label?: string
): z.infer<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    const where = label ? ` (${label})` : '';
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new Error(`IR validation failed${where}:\n${detail}`);
  }
  return result.data;
}

/** Non-throwing variant: returns Zod's SafeParseReturnType for callers that want to branch. */
export function safeValidate<S extends z.ZodTypeAny>(
  schema: S,
  input: unknown
): z.SafeParseReturnType<unknown, z.infer<S>> {
  return schema.safeParse(input);
}

// --- per-boundary convenience wrappers ---

export const validateStoryIR = (input: unknown): StoryIR =>
  validate(StoryIRSchema, input, 'Story IR');

export const validateSceneIR = (input: unknown): SceneIR =>
  validate(SceneIRSchema, input, 'Scene IR');

/** Validate a single Scene-IR layer (used by the compositor / generator/rig registries). */
export const validateLayer = (input: unknown): Layer =>
  validate(LayerSchema, input, 'Layer');

// --- JSON-Schema export (for the future LLM front-end / external tooling) ---

/** JSON-Schema for the Story IR. */
export const storyIRJsonSchema = () =>
  zodToJsonSchema(StoryIRSchema, 'StoryIR');

/** JSON-Schema for the Scene IR. */
export const sceneIRJsonSchema = () =>
  zodToJsonSchema(SceneIRSchema, 'SceneIR');
