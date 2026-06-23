// CLI — export a compiled PROJECT's timeline to an OpenTimelineIO `.otio` document.
//
//   tsx src/cli/export-otio.ts <project-id> [--out <path>] [--stdout]
//
// Reads the project's pinned `scene.json` (the deterministic compiled timeline — NO pipeline, no
// library re-resolution; cf. the render.ts reproduce path) and maps it to an OTIO-aligned Timeline
// JSON via src/export/otio.ts. Default output is `projects/<id>/media/<id>.otio` (a sibling of the
// rendered video — the OTIO doc is a delivery artifact alongside out.mp4); `--out` overrides the path
// and `--stdout` prints to stdout instead of writing a file.
//
// DETERMINISM (CLAUDE.md r.1): the export is a pure function of scene.json, so re-exporting an
// unchanged project yields a byte-identical .otio.

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { projectPaths, projectExists, readSceneIR, readManifest } from '../project/index.js';
import { sceneIRToOtio, otioToJSON } from '../export/otio.js';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Args {
  id: string;
  out?: string | undefined;
  stdout: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const id = positional[0];
  if (!id) throw new Error('usage: export-otio <project-id> [--out <path>] [--stdout]');
  return { id, out: flag('--out'), stdout: argv.includes('--stdout') };
}

function main(): void {
  const { id, out, stdout } = parseArgs(process.argv.slice(2));
  if (!projectExists(PROJECT_ROOT, id)) {
    throw new Error(`no compiled project '${id}' (looked for projects/${id}/project.json)`);
  }
  const paths = projectPaths(PROJECT_ROOT, id);
  const sceneIR = readSceneIR(paths);
  // Use the project's display name (manifest) as the OTIO timeline name; fall back to the id.
  let name = id;
  try {
    name = readManifest(paths).name || id;
  } catch {
    /* manifest optional for the export */
  }

  const timeline = sceneIRToOtio(sceneIR, name);
  const json = otioToJSON(timeline);

  if (stdout) {
    process.stdout.write(json);
    return;
  }

  const outPath = out ? resolvePath(PROJECT_ROOT, out) : resolvePath(paths.mediaDir, `${id}.otio`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json, 'utf8');

  const sceneCount = sceneIR.scenes.length;
  const layerCount = sceneIR.scenes.reduce((n, s) => n + s.layers.length, 0);
  const audioCount = (sceneIR.audio ?? []).length;
  console.log(
    `[export-otio] ${id}: ${sceneCount} scene(s), ${layerCount} layer(s), ${audioCount} audio cue(s) → ${outPath}`,
  );
}

try {
  main();
} catch (err) {
  console.error('[export-otio] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
