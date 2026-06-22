// core-rigs — the built-in RIG PROVIDERS shipped AS A CORE PLUGIN (ADR-005; generalises ADR-001's
// provider split). It contributes the two provider `kind`s the engine has always supported into the
// `rigProviders` extension point via `api.registerRigProvider`:
//   • "procedural"  → <ProceduralRig> (code-only flat-vector character; resolves a CharacterSpec)
//   • "dragonbones" → <RigLayer>      (vendor Pixi + DragonBones skeleton/mesh)
// The old hardcoded `rigDef.kind === 'procedural' ? … : …` dispatch in src/render/Scene.tsx is now
// resolved through this registry — no parallel branch.
//
// PROVIDER PROPS: the engine's uniform `RigProviderProps` is `{ layer, rigDef, easings }`. Each
// provider here is a thin adapter that reads only the fields ITS kind needs and forwards them to the
// underlying component (procedural needs `rigDef.spec`; dragonbones needs the full `rigDef`).
//
// DETERMINISM (CLAUDE.md r.1): `register` is pure data wiring; each provider reads the frame clock
// itself and stays a pure function of (props + frame) — unchanged by this migration.

import React from 'react';
import type { EngineAPI, Plugin, RigProviderProps } from '../../src/engine/index.js';
import { ProceduralRig } from '../../src/render/ProceduralRig.js';
import { RigLayer } from '../../src/rig/index.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/**
 * Procedural provider adapter: pulls the embedded CharacterSpec out of `rigDef.spec` and hands it to
 * <ProceduralRig> (the code-only character renderer). `rigDef.spec` is loose-typed in the IR;
 * ProceduralRig validates it (parseSpec) and falls back to BLIP_SPEC if absent/invalid.
 */
const ProceduralProvider: React.FC<RigProviderProps> = ({ layer, rigDef, easings }) => (
  <ProceduralRig
    layer={layer}
    spec={rigDef.spec as Record<string, unknown> | undefined}
    easings={easings}
  />
);

/** DragonBones provider adapter: forwards the full rig definition to the vendor <RigLayer>. */
const DragonBonesProvider: React.FC<RigProviderProps> = ({ layer, rigDef, easings }) => (
  <RigLayer layer={layer} rigDef={rigDef} easings={easings} />
);

/** The core-rigs plugin: registers the procedural + dragonbones providers by their rig `kind`. */
export const coreRigsPlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    api.registerRigProvider('procedural', ProceduralProvider);
    api.registerRigProvider('dragonbones', DragonBonesProvider);
  },
};

export default coreRigsPlugin;
