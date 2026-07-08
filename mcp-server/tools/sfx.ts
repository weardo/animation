// SFX tools — the first proof of the tool boundary. `synthSfx` is already a pure, exported callable
// (name → deterministic cached wav), so it wraps cleanly with zero extraction. An Audio Designer agent
// uses `sfx_list` to see the palette and `sfx_synth` to materialize a cue's wav before placing it.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { synthSfx, SFX_NAMES } from '../../src/cli/sfx.js';
import { LIB_SFX_DIR, DEFAULT_FPS } from '../context.js';

export function registerSfxTools(server: McpServer): void {
  server.registerTool(
    'sfx_list',
    {
      title: 'List sound effects',
      description:
        'List the built-in sound-effect names an Audio Designer can place in a story (whoosh, boom, riser, shutter, …). Each is deterministic and content-addressed by name.',
      inputSchema: {},
    },
    async () => ({
      content: [{ type: 'text', text: JSON.stringify({ names: SFX_NAMES }, null, 2) }],
    }),
  );

  server.registerTool(
    'sfx_synth',
    {
      title: 'Synthesize a sound effect',
      description:
        'Synthesize (or reuse the cached) named SFX into the shared library cache. Deterministic + content-addressed by name (skip-if-exists). Returns where the wav lives, its cue length in frames, and its mix level (SFX sit UNDER the voice).',
      inputSchema: {
        name: z.enum(SFX_NAMES as [string, ...string[]]).describe('One of the built-in effect names (see sfx_list).'),
        fps: z.number().int().positive().default(DEFAULT_FPS).describe('Frames per second used to compute the cue length.'),
      },
    },
    async ({ name, fps }) => {
      const res = synthSfx(name, LIB_SFX_DIR, fps);
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );
}
