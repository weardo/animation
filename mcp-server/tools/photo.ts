// Photo tools — OFFLINE still-image sourcing (Wikimedia Commons real archival subjects + Pexels generic
// mood b-roll) for a documentary's evidence/b-roll layer. `searchPhoto`/`pickPhoto` are already pure,
// exported callables (query → candidates; candidate → downloaded + cataloged asset), so they wrap
// cleanly with zero behavior change. An agent uses `photo_search` to browse candidates (don't take #0
// blindly — Wikimedia results carry required CC/PD attribution) and `photo_pick` to fetch + register one.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { searchPhoto, pickPhoto, PHOTO_SOURCE_IDS, type PickPhotoParams } from '../../src/cli/photo.js';
import { PROJECT_ROOT } from '../context.js';

const ORIENTATION_ENUM = ['landscape', 'portrait', 'any'] as const;

export function registerPhotoTools(server: McpServer): void {
  server.registerTool(
    'photo_search',
    {
      title: 'Search photos',
      description:
        'Browse candidate still images for a query from Wikimedia Commons (real archival subjects — CC/PD, attribution required) or Pexels (generic mood b-roll, no attribution required). Returns indexed candidates (title, dimensions, license, page URL) — inspect before picking, do not take #0 blindly.',
      inputSchema: {
        query: z.string().describe('Search query / subject to find still images for.'),
        source: z
          .enum(PHOTO_SOURCE_IDS)
          .default('wikimedia')
          .describe('wikimedia (real archival subjects, attribution required) or pexels (generic b-roll, no attribution).'),
        orientation: z
          .enum(ORIENTATION_ENUM)
          .default('any')
          .describe('Filter candidates by aspect orientation.'),
        limit: z.number().int().positive().default(10).describe('Max candidates to return (most-relevant first).'),
      },
    },
    async ({ query, source, orientation, limit }) => {
      const candidates = await searchPhoto({ query, source, orientation });
      const result = {
        source,
        query,
        orientation,
        count: candidates.length,
        candidates: candidates.slice(0, limit).map((c, index) => ({
          index,
          title: c.title,
          width: c.width,
          height: c.height,
          license: c.license,
          pageUrl: c.pageUrl,
        })),
      };
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'photo_pick',
    {
      title: 'Pick a photo',
      description:
        'Fetch a specific search candidate (default index 0 — browse with photo_search first), downscale it to a light ≤1600px jpg, and register it as an `asset` catalog entry in library/index.json. Returns the asset:// ref, local path, and provenance (attribution + license) to place in a story as `{ asset: <id>, as: still, args: { z: 1, kenburns: "in" } }`.',
      inputSchema: {
        query: z.string().describe('Same query used to search — re-run to select from its candidates.'),
        source: z
          .enum(PHOTO_SOURCE_IDS)
          .default('wikimedia')
          .describe('wikimedia (real archival subjects, attribution required) or pexels (generic b-roll, no attribution).'),
        orientation: z
          .enum(ORIENTATION_ENUM)
          .default('any')
          .describe('Filter candidates by aspect orientation (must match the photo_search call to land on the same index).'),
        id: z.string().optional().describe('Asset id to register under (default: derived from the query + source).'),
        index: z.number().int().nonnegative().default(0).describe('Which search result to fetch (see photo_search).'),
        rootDir: z
          .string()
          .default(PROJECT_ROOT)
          .describe('Project root the public/img + library/index.json paths resolve against.'),
      },
    },
    async ({ query, source, orientation, id, index, rootDir }) => {
      const params: PickPhotoParams = {
        query,
        source,
        orientation,
        index,
        rootDir,
        ...(id !== undefined ? { id } : {}),
      };
      const result = await pickPhoto(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
