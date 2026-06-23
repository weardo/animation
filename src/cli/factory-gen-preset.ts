// factory:gen-preset — register a GENERATOR PRESET as a library entry (ADR-004 §2).
//
// A generator preset is the "add a procedural world as we want" unit: pure DATA that pins ONE
// generator implementation (`gen`) + locked `params` under a `name@version`. Authoring needs ZERO
// code — write a small spec, run this CLI, the catalog entry + the canonical sidecar are written.
// A Scene-IR `generator.gen` may then name the preset ref (`starfield@1.0.0`); the library resolver
// (`Library.expandGeneratorRef`) expands it to `{ gen, params }` at lowering time (preset params are
// defaults; the layer's own args override).
//
//   npm run factory:gen-preset <preset-spec.json>
//
// Input spec shape (a superset of the sidecar body):
//   { "id": "starfield", "version"?: "1.0.0", "gen": "scatter",
//     "params": { … },                       // generator-specific, opaque here (validated at render)
//     "tags"?: ["…"], "description"?: "…", "license"?: "CC0" }
//
// Pipeline (all deterministic, pure file I/O over a validated spec):
//   read spec → validate (Zod) → write canonical sidecar `library/generators/<id>.preset.json`
//   → content-hash the body → register/update the `generators` namespace catalog entry
//   (kind='generator-preset', format='generator-preset', uri='preset://<id>').
//
// This is a pure-library operation (no provider plugin dispatch — unlike `factory:gen` for rigs),
// so it lives in src/cli and imports only the library layer + Zod.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import objectHash from 'object-hash';
import { GeneratorPresetSchema, SemverSchema } from '../library/index.js';

/** The on-disk spec the CLI accepts: the sidecar body + catalog metadata. */
const PresetSpecSchema = z
  .object({
    /** Catalog id (the human name of the preset). */
    id: z.string().min(1),
    /** Semver; defaults to 1.0.0 if omitted. */
    version: SemverSchema.optional(),
    /** The generator IMPLEMENTATION this preset configures. */
    gen: z.string().min(1),
    /** Locked, generator-specific params (opaque here; the generator's Zod validates at render). */
    params: z.record(z.unknown()).default({}),
    /** Catalog tags. */
    tags: z.array(z.string()).default([]),
    /** Human description (catalog metadata; not part of the content hash body). */
    description: z.string().optional(),
    /** SPDX-ish license string for provenance. */
    license: z.string().min(1).default('CC0'),
  })
  .strict();

function main(): void {
  const specArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
  if (!specArg) {
    console.error('usage: npm run factory:gen-preset <preset-spec.json>');
    process.exit(1);
  }

  const rootDir = process.cwd();
  const raw = JSON.parse(readFileSync(resolvePath(rootDir, specArg), 'utf8'));
  const spec = PresetSpecSchema.parse(raw); // validate → throws on invalid
  const id = spec.id;
  const version = spec.version ?? '1.0.0';

  // 1. canonical sidecar body → library/generators/<id>.preset.json (the DATA the loader reads).
  //    Validated by the same schema the loader uses, so what we write is exactly what resolves.
  const body = GeneratorPresetSchema.parse({ gen: spec.gen, params: spec.params });
  const genDir = resolvePath(rootDir, 'library', 'generators');
  mkdirSync(genDir, { recursive: true });
  const sidecarPath = resolvePath(genDir, `${id}.preset.json`);
  writeFileSync(sidecarPath, JSON.stringify(body, null, 2) + '\n', 'utf8');

  // 2. content hash of the body (the addressable identity of this preset version).
  const hash = objectHash(body, { algorithm: 'sha1', encoding: 'hex' });

  // 3. register/update the catalog entry under the `generators` namespace.
  const idxPath = resolvePath(rootDir, 'library', 'index.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  idx.entries ??= {};
  idx.entries.generators ??= {};
  const prev = idx.entries.generators[id] ?? {};
  const uri = `preset://${id}`;
  idx.entries.generators[id] = {
    id,
    version,
    kind: 'generator-preset',
    format: 'generator-preset',
    uri,
    tags: spec.tags.length > 0 ? spec.tags : prev.tags ?? ['generator-preset', spec.gen],
    // The preset depends on the implementation it configures (DAG hint; the impl is code, not a
    // catalog entry yet, so we record the bare gen name — informational, not a resolvable ref).
    deps: [],
    provenance: {
      source: spec.description ?? `generator preset for "${spec.gen}"`,
      generator: spec.gen,
      spec_hash: hash,
      license: spec.license,
    },
  };
  writeFileSync(idxPath, JSON.stringify(idx, null, 2) + '\n', 'utf8');

  console.log(`[factory] registered generator-preset "${id}@${version}"  (gen: ${spec.gen})`);
  console.log(`[factory]   sidecar → ${sidecarPath}`);
  console.log(`[factory]   hash    → ${hash}`);
  console.log(`[factory]   catalog → library/index.json  (${uri})`);
  console.log(`[factory]   use     → a story show item: { generator: "${id}", args: { …overrides } }`);
}

main();
