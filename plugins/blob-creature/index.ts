// blob-creature — the DEFAULT character style, shipped AS A CORE PLUGIN (ADR-005 "Character styles":
// "a consistent style in character generation = a character-style plugin"). It contributes today's
// `characterMarkup` (the generalized flat-vector Kurzgesagt creature builder) into the engine's
// `characterStyles` extension point under the id `blob-creature` via `api.registerCharacterStyle`.
//
// A CharacterSpec names its `style` (defaulting to `blob-creature`); ProceduralRig resolves the
// matching builder from this registry instead of importing `characterMarkup` directly. Future styles
// (kurzgesagt-humanoid, flat-mascot, …) ship as sibling plugins and coexist.
//
// DETERMINISM (CLAUDE.md r.1): `characterMarkup` is a PURE function of (spec, frame, fps, clips) that
// returns a byte-stable SVG markup string — its signature is exactly `CharacterStyleBuilder`, so this
// migration is a rename of the lookup path, not a behaviour change (blip renders identically).

import type {
  CharacterStyleBuilder,
  EngineAPI,
  Plugin,
} from '../../src/engine/index.js';
import { characterMarkup } from '../../src/factory/character.js';

import manifestJson from './plugin.json' with { type: 'json' };
import { parseManifest } from '../../src/engine/index.js';

const manifest = parseManifest(manifestJson);

/** The default style id. CharacterSpec.style defaults to this; ProceduralRig resolves it here. */
export const DEFAULT_CHARACTER_STYLE = 'blob-creature';

/** The blob-creature builder IS today's characterMarkup (its signature already matches the contract). */
const blobCreatureStyle: CharacterStyleBuilder = characterMarkup;

/** The blob-creature plugin: registers `characterMarkup` as the default `blob-creature` style. */
export const blobCreaturePlugin: Plugin = {
  manifest,
  register(api: EngineAPI): void {
    api.registerCharacterStyle(DEFAULT_CHARACTER_STYLE, blobCreatureStyle);
  },
};

export default blobCreaturePlugin;
