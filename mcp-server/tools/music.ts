// Music tools — mirrors the SFX tool family. `synthMusic` is already a pure, exported callable (name →
// deterministic cached wav), so it wraps cleanly with zero extraction. An Audio Designer agent uses
// `music_list` to see the bed palette and `music_synth` to materialize a bed's wav before placing it.
import { resolve } from 'node:path';

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { synthMusic, MUSIC_NAMES } from '../../src/cli/music.js';
import { LIBRARY_DIR } from '../context.js';

const LIB_MUSIC_DIR = resolve(LIBRARY_DIR, 'music');

export function registerMusicTools(server: McpServer): void {
  server.registerTool(
    'music_list',
    {
      title: 'List music beds',
      description:
        'List the built-in ambient music-bed names an Audio Designer can place as a story\'s music track (calm, drone, uplift, …). Each is a deterministic, content-addressed loopable pad.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ names: MUSIC_NAMES }, null, 2) }],
    }),
  );

  server.registerTool(
    'music_synth',
    {
      title: 'Synthesize a music bed',
      description:
        'Synthesize (or reuse the cached) named music bed into the shared library cache. Deterministic + content-addressed by name (skip-if-exists). Returns where the wav lives and its loop length in seconds (the renderer loops it under the whole video).',
      inputSchema: {
        name: z.enum(MUSIC_NAMES as [string, ...string[]]).describe('One of the built-in bed names (see music_list).'),
      },
    },
    async ({ name }) => {
      const res = synthMusic(name, LIB_MUSIC_DIR);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );
}
