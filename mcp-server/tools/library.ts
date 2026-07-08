// Library tools — read-only introspection over the shared, content-addressed library catalog
// (`library/index.json`). This is the OPT-IN publish/share layer (CLAUDE.md golden rule 6), not
// project-local reuse. An agent uses `library_list` to browse what's been published and
// `library_resolve` to pin a `name[@version]` ref to its catalog definition + content hash (the
// same hash `animation.lock` pins) before referencing it in a story/scene. Pure reads: no writes,
// no lockfile mutation.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { Library, EntryKindSchema } from '../../src/library/index.js';
import { PROJECT_ROOT } from '../context.js';

export function registerLibraryTools(server: McpServer): void {
  server.registerTool(
    'library_list',
    {
      title: 'List library catalog entries',
      description:
        'List entries in the shared content-addressed library catalog (library/index.json) — the OPT-IN publish layer (CLAUDE.md golden rule 6), not project-local reuse. Optionally filter by namespace and/or kind.',
      inputSchema: {
        namespace: z
          .string()
          .optional()
          .describe('Restrict to one catalog namespace (e.g. "characters", "props", "stylekits").'),
        kind: EntryKindSchema.optional().describe(
          'Restrict to one entry kind (e.g. "rig", "asset", "stylekit", "clip", "generator-preset").',
        ),
      },
    },
    async ({ namespace, kind }) => {
      const library = Library.open(PROJECT_ROOT);
      const entries: Array<{
        namespace: string;
        name: string;
        version: string;
        kind: string;
        tags: string[];
        format?: string;
        provider?: string;
      }> = [];
      for (const [ns, table] of Object.entries(library.catalog.entries)) {
        if (namespace && ns !== namespace) continue;
        for (const entry of Object.values(table)) {
          if (kind && entry.kind !== kind) continue;
          entries.push({
            namespace: ns,
            name: entry.id,
            version: entry.version,
            kind: entry.kind,
            tags: entry.tags,
            ...(entry.format ? { format: entry.format } : {}),
            ...(entry.provider ? { provider: entry.provider } : {}),
          });
        }
      }
      return { content: [{ type: 'text', text: JSON.stringify({ entries }, null, 2) }] };
    },
  );

  server.registerTool(
    'library_resolve',
    {
      title: 'Resolve a library ref to its content hash',
      description:
        'Resolve a `name[@version]` library ref to its catalog definition + content-addressed hash (the same hash `animation.lock` pins, spec §13.2). Read-only — does not write a lockfile.',
      inputSchema: {
        name: z.string().min(1).describe('Catalog entry id (e.g. "dragon", "kurzgesagt").'),
        version: z
          .string()
          .optional()
          .describe('Semver to resolve; defaults to whatever version is currently in the catalog for this id.'),
      },
    },
    async ({ name, version }) => {
      const library = Library.open(PROJECT_ROOT);
      // The catalog stores exactly one version per id today (a Record<name, entry>), so an
      // omitted version resolves against the one currently cataloged; an explicit version is
      // still passed straight through to `get()`, which throws a clear error on a mismatch.
      let resolvedVersion = version;
      if (!resolvedVersion) {
        for (const table of Object.values(library.catalog.entries)) {
          const entry = table[name];
          if (entry) {
            resolvedVersion = entry.version;
            break;
          }
        }
        if (!resolvedVersion) {
          throw new Error(`library entry not found: "${name}" (no namespace has this id)`);
        }
      }
      const resolved = library.get(`${name}@${resolvedVersion}`);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                ref: resolved.key,
                namespace: resolved.namespace,
                kind: resolved.entry.kind,
                hash: resolved.hash,
                def: resolved.entry,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
