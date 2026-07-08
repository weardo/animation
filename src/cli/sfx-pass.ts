// sfx-pass.ts — the WIRING that turns a story's `sfx` directives into Scene-IR `audio[]` sfx cues.
//
// EVENT MODEL (A2, spec §12). A sound effect is attached to an EVENT and lowered to an audio cue at
// that event's frame. Two event sources, both authored in the Story IR (intent), resolved here against
// the lowered Scene IR (which already knows each scene's GLOBAL start frame `at`):
//   • show[].sfx  — an ELEMENT entrance. The cue fires at the SCENE START (the element appears with the
//                   beat), so `at = scene.at`. (Per-element timing past the entrance is future work.)
//   • beat.sfx[]  — a beat-level ACCENT (swoosh/impact). The cue fires at `scene.at + offset`, where
//                   `offset` is the directive's `at` (frames from the beat opening; default 0).
//
// Like narration (narrate-pass.ts), this is an OFFLINE asset-gen step in the COMPILE path: it runs
// AFTER lowering (to read scene `at`) and BEFORE scene.json is written. Each named sfx is SYNTHESIZED
// ONCE into the shared `library/sfx/` cache (ffmpeg, deterministic — sfx.ts) and COPIED into the
// project's self-contained `assets/audio/`; the cue `src` is the public-relative `audio://audio/<name>.wav`
// the compositor resolves with staticFile. DETERMINISM (golden rule 1): a fixed recipe → a fixed wav →
// a byte-identical audio stream; re-running reuses the cache. Additive: existing narration/sfx/music
// cues are preserved.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { SceneIR, AudioCue, StoryIR } from '../ir/index.js';
import type { BeatSfx } from '../ir/story.js';
import { synthSfx } from './sfx.js';

export interface SfxOptions {
  /** Project assets dir (the render publicDir); sfx wavs are copied to `<assets>/audio/`. */
  assetsDir: string;
  /** Repo root (to locate the shared `library/sfx/` cache). */
  rootDir: string;
}

/** Normalize a beat `sfx[]` entry (string shorthand or object) to `{ name, at }`. */
function normalizeBeatSfx(entry: string | BeatSfx): { name: string; at: number } {
  if (typeof entry === 'string') return { name: entry, at: 0 };
  return { name: entry.name, at: entry.at ?? 0 };
}

/**
 * Augment a lowered Scene IR with `kind:"sfx"` `audio[]` cues synthesized from the story's `sfx`
 * directives. Pure-ish (deterministic given the cache): synthesizes each NAMED effect once into the
 * shared library cache, copies it into the project assets, and appends a cue at the resolved event
 * frame. Returns the SAME IR object with `audio` extended (existing cues kept, re-sorted by frame).
 */
export function applySfx(sceneIR: SceneIR, story: StoryIR, opts: SfxOptions): SceneIR {
  const fps = sceneIR.config.fps;
  const audioDir = resolvePath(opts.assetsDir, 'audio');
  const libSfxDir = resolvePath(opts.rootDir, 'library', 'sfx');

  // scene.id === beat.id; index scene start frames by id for the event→timeline lookup.
  const sceneAt = new Map<string, number>();
  for (const scene of sceneIR.scenes) sceneAt.set(scene.id, scene.at ?? 0);

  // Preserve existing cues (narration, and any other kind); only this run's sfx cues are (re)built.
  const cues: AudioCue[] = (sceneIR.audio ?? []).filter((c) => c.kind !== 'sfx');

  // Synthesize each distinct effect ONCE per run (cache the result so two cues of the same name reuse
  // one synth call + one vendored wav copy). Maps name → its vendored result.
  const synthed = new Map<string, ReturnType<typeof synthSfx>>();
  const ensure = (name: string) => {
    let res = synthed.get(name);
    if (!res) {
      res = synthSfx(name, libSfxDir, fps);
      // Copy the cached library wav into the project's self-contained assets/audio/ (the publicDir).
      mkdirSync(audioDir, { recursive: true });
      const dst = resolvePath(audioDir, `${name}.wav`);
      if (!existsSync(dst)) copyFileSync(res.libPath, dst);
      synthed.set(name, res);
    }
    return res;
  };

  let cueCount = 0;
  for (const beat of story.beats) {
    const at = sceneAt.get(beat.id);
    if (at === undefined) continue; // beat produced no scene — no place to anchor an event

    // 1. Per-element entrance sounds (show[].sfx) — anchored at the scene start (the element appears).
    (beat.show ?? []).forEach((item, i) => {
      if (!item.sfx) return;
      const res = ensure(item.sfx);
      cues.push({
        id: `sfx-${beat.id}-show${i}`,
        kind: 'sfx',
        src: `audio://${res.publicRel}`,
        at,
        duration_frames: res.durationFrames,
        volume: res.mix, // duck SFX under the VO — they're accents, not the lead
      });
      cueCount += 1;
    });

    // 2. Beat-level accents (beat.sfx[]) — anchored at scene.at + offset frames.
    (beat.sfx ?? []).forEach((entry, i) => {
      const { name, at: offset } = normalizeBeatSfx(entry);
      const res = ensure(name);
      cues.push({
        id: `sfx-${beat.id}-beat${i}`,
        kind: 'sfx',
        src: `audio://${res.publicRel}`,
        at: at + offset,
        duration_frames: res.durationFrames,
        volume: res.mix, // duck SFX under the VO — they're accents, not the lead
      });
      cueCount += 1;
    });
  }

  // Stable, diffable ordering (deterministic scene.json).
  cues.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));

  if (cueCount > 0) {
    const synthList = [...synthed.values()];
    const fresh = synthList.filter((r) => !r.cached).length;
    console.log(
      `[sfx] ${cueCount} sfx cue(s) from ${synthed.size} effect(s) ` +
        `(${fresh} synthesized, ${synthList.length - fresh} cached) → ${audioDir}`,
    );
  }

  return { ...sceneIR, audio: cues };
}
