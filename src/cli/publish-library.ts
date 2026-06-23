// factory:publish-library — emit a STATIC-SERVABLE mirror of the local `library/` + a hash manifest.
//
// ADR-001 §"Bundle export/import" + the LibraryResolver remote variant: the engine depends on a thin
// resolver (`name@version → content hash + data`), NOT on where the library lives. This CLI is the
// PUBLISH half of the remote story for a local-first user: it copies the whole `library/` tree into a
// portable output dir and writes `files.json` (every file + its sha256 + a single content_hash). Serve
// that dir over any static host (e.g. `python -m http.server`) and a peer can `factory:fetch-library`
// it into a local mirror that the UNCHANGED `Library` (src/library/loader.ts) resolves byte-for-byte.
//
// DETERMINISM (golden rule 1): files.json lists files sorted by path, each with the sha256 of its bytes.
// The per-file sha256 is the integrity contract (fetch verifies every byte against it). The aggregate
// content_hash is a quick summary, computed from the ROUND-TRIPPED file (not the in-memory array) with
// the exact operation fetch uses, so publisher + fetcher agree by construction. No wall-clock, no net.

import { readdirSync, statSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve as resolvePath, relative, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const LIB = resolvePath(ROOT, 'library');

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/** Recursively list every file under `dir` (absolute paths). */
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** sha256 over `path\thash` per entry — the shared aggregate-summary formula (publish + fetch). */
export function filesContentHash(files: readonly { path: string; hash: string }[]): string {
  return createHash('sha256').update(files.map((f) => `${f.path}\t${f.hash}`).join('\n')).digest('hex');
}

function main(): void {
  if (!existsSync(LIB)) throw new Error(`no library/ at ${LIB}`);
  const out = resolvePath(ROOT, flag('--out') ?? join('dist', 'library-pub'));
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const files = walk(LIB).sort();
  const manifest = files.map((abs) => {
    const path = relative(LIB, abs).split('\\').join('/'); // POSIX-relative → portable
    const bytes = readFileSync(abs);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const dst = join(out, 'library', path);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, bytes);
    return { path, hash, size: bytes.length };
  });

  // Write the manifest, then derive content_hash from the PERSISTED file (same op fetch uses).
  const filesJsonPath = join(out, 'files.json');
  const base = { files_format_version: '1', source: 'library', count: manifest.length, files: manifest };
  writeFileSync(filesJsonPath, JSON.stringify({ ...base, content_hash: '' }, null, 2));
  const persisted = JSON.parse(readFileSync(filesJsonPath, 'utf8')) as { files: { path: string; hash: string }[] };
  const contentHash = filesContentHash(persisted.files);
  writeFileSync(filesJsonPath, JSON.stringify({ ...base, content_hash: contentHash }, null, 2));

  console.log(
    `[publish-library] ${manifest.length} files → ${out}\n` +
      `  content_hash sha256:${contentHash.slice(0, 16)}…\n` +
      `  serve it (e.g. \`cd ${out} && python -m http.server 8087\`) then on a peer:\n` +
      `  npm run factory:fetch-library -- http://HOST:8087 --into ./vendor-lib`,
  );
}

main();
