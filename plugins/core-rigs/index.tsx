// core-rigs — the built-in DRAGONBONES provider shipped AS A CORE PLUGIN (ADR-005/006). It
// contributes the vendor (Pixi + DragonBones) rig renderer into the engine's generic `providers`
// extension point via `api.registerProvider('dragonbones', …)`.
//
// ADR-006: the engine specializes in NOTHING — the former "procedural" rig kind is no longer a core
// concern. The code-only flat-vector character renderer moved OUT of core into the `blob-creature`
// PROVIDER plugin (it owns the CharacterSpec it interprets). core-rigs keeps only the vendor provider.
// The old hardcoded `rigDef.kind === 'procedural' ? … : …` dispatch in src/render/Scene.tsx is gone;
// the compositor now resolves `rigDef.provider` through the `providers` registry uniformly.
//
// ADR-007: the entire DragonBones runtime (RigLayer + loader + clips + liveness + animated-eval) lives
// in THIS plugin (the local files alongside this index), not in core — the dependency arrow points
// plugin→core (delete-the-plugin test). Core keeps only the generic provider dispatch in Scene.tsx.
//
// PROVIDER PROPS: the engine's uniform `ProviderProps` is `{ layer, rigDef, easings }`. The dragonbones
// provider forwards the full rig definition to the vendor <RigLayer>.
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring; the provider reads the frame clock
// itself and stays a pure function of (props + frame) — unchanged by this migration.

import React from 'react';
import type { EngineAPI, Plugin, ProviderProps } from '../../src/engine/index.js';
import { RigLayer } from './runtime.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/** DragonBones provider: forwards the full rig definition to the vendor <RigLayer>. */
const DragonBonesProvider: React.FC<ProviderProps> = ({ layer, rigDef, easings }) => (
  <RigLayer layer={layer} rigDef={rigDef} easings={easings} />
);

/** The core-rigs plugin: registers the vendor dragonbones provider under its id. */
export const coreRigsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    api.registerProvider('dragonbones', DragonBonesProvider);
  },
};

export default coreRigsPlugin;
