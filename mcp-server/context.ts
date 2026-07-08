// Shared paths + defaults for the MCP tool layer. The MCP server lives at the repo root (sibling to
// src/ and plugins/, like render-entry.tsx) and exposes the factory's callable core as tools, so an
// autonomous agent (or any MCP client) can drive the pipeline. PROJECT_ROOT is one level up from here.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIBRARY_DIR = resolve(PROJECT_ROOT, 'library');
export const LIB_SFX_DIR = resolve(LIBRARY_DIR, 'sfx');
export const PROJECTS_DIR = resolve(PROJECT_ROOT, 'projects');

/** Default composition frame rate (matches the render default). */
export const DEFAULT_FPS = 30;
