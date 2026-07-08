// Footage tools — OFFLINE free-stock-video sourcing (Pexels) for a reel/documentary's b-roll layer.
// `searchFootage`/`pickFootage` are already pure, exported callables (query → ranked candidates;
// candidate → downloaded + proxy-transcoded + cataloged asset), so they wrap cleanly with zero behavior
// change. An agent uses `footage_search` to browse candidates (the top result is not always the best
// clip — a subject may be off-frame or only revealed late) and `footage_pick` to fetch + register one.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { searchFootage, pickFootage, type PickFootageOptions } from '../../src/cli/footage.js';
import { PROJECT_ROOT } from '../context.js';

const ORIENTATION = z.enum(['portrait', 'landscape', 'square']);
const SIZE = z.enum(['large', 'medium', 'small']);

export function registerFootageTools(server: McpServer): void {
  server.registerTool(
    'footage_search',
    {
      title: 'Search stock footage',
      description:
        'Browse candidate stock-video clips for a query from Pexels (free for commercial use, no attribution required on the media). Returns ranked candidates (id, dimensions, duration, poster + mid-clip preview thumbnails, page URL) — inspect before picking, the top result is not always the best clip. Requires PEXELS_API_KEY.',
      inputSchema: {
        query: z.string().describe('Search phrase, e.g. "oil tanker at sea".'),
        orientation: ORIENTATION.default('portrait').describe('Match the reel aspect (portrait for 9:16, landscape for 16:9).'),
        size: SIZE.default('medium').describe('Pexels quality bucket: large(4K) / medium(FullHD) / small(HD).'),
        minDuration: z.number().positive().default(3).describe('Minimum clip length in seconds.'),
        perPage: z.number().int().positive().max(80).default(20).describe('How many Pexels results to fetch/rank.'),
      },
    },
    async ({ query, orientation, size, minDuration, perPage }) => {
      const result = await searchFootage({ query, orientation, size, minDuration, perPage });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'footage_pick',
    {
      title: 'Pick and download stock footage',
      description:
        'Fetch a specific search candidate (default index 0 — browse with footage_search first), proxy-transcode it to a light h264/yuv420p clip (so <OffthreadVideo> never RAM-balloons), and register/update it as an `asset` catalog entry in library/index.json. A plain re-run of the same query/id reuses the cached file (skip-if-exists) — pass videoId or index to re-choose a different candidate, which always re-fetches. Returns the asset:// ref, local path, and provenance to place in a story as `{ footage: <id>, as: broll, args: { z: 1, loop: true, muted: true, fit: cover } }`. Requires PEXELS_API_KEY unless the file is already cached.',
      inputSchema: {
        query: z.string().describe('Search phrase — also the content-address key if id is omitted.'),
        orientation: ORIENTATION.default('portrait').describe('Must match the footage_search call to land on the same candidate ranking.'),
        size: SIZE.default('medium'),
        minDuration: z.number().positive().default(3),
        id: z.string().optional().describe('Asset id (catalog key + filename stem). Default: derived from a content hash of query+orientation+size+minDuration.'),
        videoId: z.number().int().optional().describe('Fetch this EXACT Pexels video id (from footage_search), not just the ranked pick.'),
        index: z.number().int().nonnegative().optional().describe('Fetch the candidate at this rank (0 = top pick, the default; see footage_search).'),
        rootDir: z
          .string()
          .default(PROJECT_ROOT)
          .describe('Project root the public/video + library/index.json paths resolve against.'),
      },
    },
    async ({ query, orientation, size, minDuration, id, videoId, index, rootDir }) => {
      const params: PickFootageOptions = {
        query,
        orientation,
        size,
        minDuration,
        rootDir,
        ...(id !== undefined ? { id } : {}),
        ...(videoId !== undefined ? { videoId } : {}),
        ...(index !== undefined ? { index } : {}),
      };
      const result = await pickFootage(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );
}
