// factory:list — inventory the factory: what reusable units the LIBRARY ships, and what PROJECTS
// (reproducible videos) exist on disk. The read-only counterpart to factory:gen / render / bundle.
//
// Two sections, each filterable:
//   factory:list                 → everything (library by namespace + all projects)
//   factory:list library         → just the library catalog
//   factory:list projects        → just the projects
//   factory:list --kind characters   → only that library namespace
//   factory:list --json          → machine-readable (for scripts / the future UI)
//
// Library data comes straight from `library/index.json` via the existing catalog loader (no network,
// no resolution — listing must not need a project context). Projects are discovered by scanning
// `projects/*/project.json` and read with the project manifest parser. Nothing here is a render input,
// so timestamps/derived fields are fine to surface.

import { readdirSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCatalog, type Catalog } from '../library/index.js';
import { projectPaths, readManifest, type ProjectManifest } from '../project/index.js';

const PROJECT_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface Args {
  section: 'all' | 'library' | 'projects';
  kind: string | undefined;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const positional = argv.filter((a) => !a.startsWith('-'));
  const flag = (n: string): string | undefined => {
    const i = argv.indexOf(n);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const sec = positional[0] as Args['section'] | undefined;
  const section: Args['section'] = sec === 'library' || sec === 'projects' ? sec : 'all';
  return { section, kind: flag('--kind'), json: argv.includes('--json') };
}

interface LibraryEntryRow {
  ref: string;
  namespace: string;
  kind: string;
  format: string | undefined;
  provider: string | undefined;
  tags: string[];
  deps: string[];
}

/** Flatten the catalog into one row per entry, optionally filtered to a namespace. */
function listLibrary(catalog: Catalog, kind?: string): LibraryEntryRow[] {
  const rows: LibraryEntryRow[] = [];
  for (const [namespace, entries] of Object.entries(catalog.entries)) {
    if (kind && namespace !== kind) continue;
    for (const [id, e] of Object.entries(entries)) {
      rows.push({
        ref: `${id}@${e.version}`,
        namespace,
        kind: e.kind,
        format: e.format,
        provider: e.provider,
        tags: e.tags,
        deps: e.deps,
      });
    }
  }
  return rows.sort((a, b) => a.namespace.localeCompare(b.namespace) || a.ref.localeCompare(b.ref));
}

interface ProjectRow {
  id: string;
  name: string;
  config: ProjectManifest['config'];
  deps: string[];
  rendered: boolean;
  scene_ir_hash: string;
}

/** Scan each `projects/<id>/project.json` → one row per compiled project. */
function listProjects(): ProjectRow[] {
  const projectsDir = resolvePath(PROJECT_ROOT, 'projects');
  if (!existsSync(projectsDir)) return [];
  const rows: ProjectRow[] = [];
  for (const id of readdirSync(projectsDir).sort()) {
    const dir = resolvePath(projectsDir, id);
    if (!statSync(dir).isDirectory()) continue;
    const p = projectPaths(PROJECT_ROOT, id);
    if (!existsSync(p.manifest)) continue;
    let m: ProjectManifest;
    try {
      m = readManifest(p);
    } catch (e) {
      console.warn(`[list] skipping ${id}: invalid manifest (${(e as Error).message})`);
      continue;
    }
    rows.push({
      id: m.id,
      name: m.name,
      config: m.config,
      deps: m.deps,
      rendered: existsSync(p.video),
      scene_ir_hash: m.scene_ir_hash,
    });
  }
  return rows;
}

function printLibrary(rows: LibraryEntryRow[]): void {
  console.log(`LIBRARY (${rows.length} entries)`);
  let lastNs = '';
  for (const r of rows) {
    if (r.namespace !== lastNs) {
      console.log(`\n  ${r.namespace}/`);
      lastNs = r.namespace;
    }
    const meta = [
      r.kind,
      r.provider ? `provider=${r.provider}` : r.format ? `format=${r.format}` : null,
      r.tags.length ? `[${r.tags.join(', ')}]` : null,
      r.deps.length ? `deps=${r.deps.length}` : null,
    ]
      .filter(Boolean)
      .join('  ');
    console.log(`    ${r.ref.padEnd(28)} ${meta}`);
  }
}

function printProjects(rows: ProjectRow[]): void {
  console.log(`\nPROJECTS (${rows.length})`);
  for (const r of rows) {
    const { w, h, fps, duration_frames } = r.config;
    const secs = (duration_frames / fps).toFixed(1);
    const status = r.rendered ? 'rendered' : 'compiled';
    console.log(
      `  ${r.id.padEnd(20)} ${w}x${h}@${fps}  ${secs}s  ${String(r.deps.length).padStart(2)} deps  ${status}  — ${r.name}`,
    );
  }
}

function main(): void {
  const { section, kind, json } = parseArgs(process.argv.slice(2));

  const lib = section !== 'projects' ? listLibrary(loadCatalog(PROJECT_ROOT), kind) : [];
  const projects = section !== 'library' ? listProjects() : [];

  if (json) {
    console.log(JSON.stringify({ library: lib, projects }, null, 2));
    return;
  }
  if (section !== 'projects') printLibrary(lib);
  if (section !== 'library') printProjects(projects);
}

main();
