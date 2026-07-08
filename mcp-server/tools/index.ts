// Tool registry — every tool family registers here. Adding a capability = a new register*Tools module
// wired in below (additive; never a core edit). This mirrors the engine's plugin-registry pattern at
// the agent/tool boundary.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerSfxTools } from './sfx.js';
import { registerMusicTools } from './music.js';
import { registerNarrateTools } from './narrate.js';
import { registerLibraryTools } from './library.js';
import { registerFootageTools } from './footage.js';
import { registerPhotoTools } from './photo.js';
import { registerNewsTools } from './news.js';
import { registerRenderTools } from './render.js';

export function registerAllTools(server: McpServer): void {
  // Asset + query tools (agents call these to gather material)
  registerLibraryTools(server);
  registerFootageTools(server);
  registerPhotoTools(server);
  registerNewsTools(server);
  // Audio tools
  registerNarrateTools(server);
  registerSfxTools(server);
  registerMusicTools(server);
  // Pipeline terminal stage
  registerRenderTools(server);
}
