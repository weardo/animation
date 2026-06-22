// Project layer — locate, read, and write a video PROJECT bundle (see manifest.ts for the format).
// Thin file helpers over the `projects/<id>/` directory convention; the CLI orchestrates them.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import type { SceneIR } from '../ir/index.js';
import { parseManifest, type ProjectManifest } from './manifest.js';

export type { ProjectManifest } from './manifest.js';
export { parseManifest } from './manifest.js';

export interface ProjectPaths {
  dir: string;
  manifest: string;
  source: string;
  scene: string;
  lock: string;
  mediaDir: string;
  video: string;
  thumbnail: string;
}

/** All canonical paths for a project id under `<root>/projects/<id>/`. */
export function projectPaths(rootDir: string, id: string): ProjectPaths {
  const dir = resolvePath(rootDir, 'projects', id);
  return {
    dir,
    manifest: resolvePath(dir, 'project.json'),
    source: resolvePath(dir, 'story.yaml'),
    scene: resolvePath(dir, 'scene.json'),
    lock: resolvePath(dir, 'project.lock'),
    mediaDir: resolvePath(dir, 'media'),
    video: resolvePath(dir, 'media', 'out.mp4'),
    thumbnail: resolvePath(dir, 'media', 'thumbnail.png'),
  };
}

/** True if a compiled project exists (has a manifest). */
export function projectExists(rootDir: string, id: string): boolean {
  return existsSync(projectPaths(rootDir, id).manifest);
}

export function ensureDirs(p: ProjectPaths): void {
  mkdirSync(p.dir, { recursive: true });
  mkdirSync(p.mediaDir, { recursive: true });
}

export function writeSource(p: ProjectPaths, yamlText: string): void {
  writeFileSync(p.source, yamlText, 'utf8');
}

export function writeSceneIR(p: ProjectPaths, sceneIR: SceneIR): void {
  writeFileSync(p.scene, JSON.stringify(sceneIR, null, 2) + '\n', 'utf8');
}

export function readSceneIR(p: ProjectPaths): SceneIR {
  return JSON.parse(readFileSync(p.scene, 'utf8')) as SceneIR;
}

export function writeManifest(p: ProjectPaths, manifest: ProjectManifest): void {
  writeFileSync(p.manifest, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

export function readManifest(p: ProjectPaths): ProjectManifest {
  return parseManifest(JSON.parse(readFileSync(p.manifest, 'utf8')));
}
