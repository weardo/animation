// Smoke test for the MCP server: spawns it over stdio, lists tools, exercises the safe read-only ones.
// Proves (a) every tool module imports without firing a CLI main() (the guards work), (b) the boundary
// round-trips. Network/key-dependent tools (footage/photo/news/narrate/render) are listed but not called.
// Run: npx tsx mcp-server/_smoke.mts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'mcp-server/index.ts'] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`tools (${tools.length}):`, tools.map((t) => t.name).sort().join(', '));

const textOf = (res: unknown): string =>
  ((res as { content?: Array<{ type: string; text?: string }> }).content ?? [])
    .find((c) => c.type === 'text')?.text ?? '';

// Safe, read-only, no external deps:
for (const [name, args] of [
  ['sfx_list', {}],
  ['music_list', {}],
  ['library_list', {}],
  ['sfx_synth', { name: 'whoosh', fps: 30 }],
] as const) {
  const res = await client.callTool({ name, arguments: args });
  console.log(`${name} →`, textOf(res).replace(/\s+/g, ' ').slice(0, 150));
}

await client.close();
console.log('SMOKE OK');
