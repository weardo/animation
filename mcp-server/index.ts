// animation-factory MCP server (P0 — the tool boundary).
//
// Exposes the deterministic factory's callable core as MCP tools over stdio, so an autonomous agent
// (or any MCP client — Claude Desktop, our orchestrator) can drive the pipeline: pick footage, synth
// SFX, probe narration, compile, render, publish. The engine + library stay unchanged; this is a thin
// adapter, the same way the render layer adapts the IR to Remotion.
//
// ⚠️ PROTOCOL SAFETY: on a stdio server, STDOUT is the JSON-RPC channel — a stray console.log there
// corrupts every message. The factory's callable core logs progress liberally to stdout, so we
// redirect console.log/info/debug to STDERR before anything else runs. stderr is free for logging.
console.log = (...a: unknown[]) => console.error(...a);
console.info = (...a: unknown[]) => console.error(...a);
console.debug = (...a: unknown[]) => console.error(...a);

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerAllTools } from './tools/index.js';

const server = new McpServer({ name: 'animation-factory', version: '0.1.0' });
registerAllTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[mcp] animation-factory server ready (stdio)');
