// Smoke test for the MCP server: spawns it over stdio, lists tools, calls sfx_synth end-to-end.
// Run: npx tsx mcp-server/_smoke.mts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({ command: 'npx', args: ['tsx', 'mcp-server/index.ts'] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

const res = await client.callTool({ name: 'sfx_synth', arguments: { name: 'whoosh', fps: 30 } });
const text = (res.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')?.text ?? '';
console.log('sfx_synth →', text.replace(/\s+/g, ' ').slice(0, 200));

await client.close();
console.log('SMOKE OK');
