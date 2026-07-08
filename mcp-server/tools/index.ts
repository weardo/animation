// Tool registry — every tool family registers here. Adding a capability = a new register*Tools module
// wired in below (additive; never a core edit). This mirrors the engine's plugin-registry pattern at
// the agent/tool boundary.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerSfxTools } from './sfx.js';

export function registerAllTools(server: McpServer): void {
  registerSfxTools(server);
}
