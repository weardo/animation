// News-evidence tools — screenshot a public news article (newsshot_capture) or pull a public news video
// clip (newsclip_fetch) into the content-addressed library cache, for use as documentary EVIDENCE (the
// ubiquity montage / real event footage). Both wrap the existing `factory:newsshot`/`factory:newsclip` CLI
// cores 1:1 (captureNewsshot/fetchNewsclip) — same fair-use/attribution posture, same skip-if-exists cache.
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { captureNewsshot } from '../../src/cli/newsshot.js';
import { fetchNewsclip } from '../../src/cli/newsclip.js';
import { PROJECT_ROOT } from '../context.js';

export function registerNewsTools(server: McpServer): void {
  server.registerTool(
    'newsshot_capture',
    {
      title: 'Capture a news-article screenshot',
      description:
        'Screenshot a PUBLICLY-ACCESSIBLE news article as documentary evidence (e.g. for a ubiquity montage — "everyone is reporting this"). Deterministic + content-addressed by {url, selector, fullPage, width, height} (skip-if-exists). Records publisher (from og:site_name) + URL + capture date in provenance for on-screen/description attribution. Editorial/fair-use only — no paywall/DRM circumvention.',
      inputSchema: {
        url: z.string().url().describe('Public https URL of the news article to capture.'),
        id: z.string().optional().describe('Asset id to register in the library catalog (default: derived from a content hash).'),
        selector: z.string().optional().describe('CSS selector to screenshot just that element instead of the viewport/full page.'),
        fullPage: z.boolean().default(false).describe('Capture the full scrollable page instead of just the viewport.'),
        width: z.number().int().positive().default(1200).describe('Viewport width in px.'),
        height: z.number().int().positive().default(1600).describe('Viewport height in px.'),
        wait: z.number().int().nonnegative().default(1200).describe('Milliseconds to wait after load (for lazy content) before capturing.'),
        date: z.string().optional().describe('Capture date (YYYY-MM-DD) recorded in provenance for attribution.'),
      },
    },
    async ({ url, id, selector, fullPage, width, height, wait, date }) => {
      const res = await captureNewsshot({
        url,
        rootDir: PROJECT_ROOT,
        ...(id ? { id } : {}),
        ...(selector ? { selector } : {}),
        fullPage,
        width,
        height,
        wait,
        ...(date ? { date } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );

  server.registerTool(
    'newsclip_fetch',
    {
      title: 'Fetch a news-video clip',
      description:
        'Pull a PUBLICLY-AVAILABLE news video clip (via yt-dlp) as documentary evidence (real event footage), transcoded to the same light footage proxy used elsewhere (≤1920px, CRF 26, muted). Deterministic + content-addressed by {url, start, duration} (skip-if-exists). Records publisher/title/URL in provenance for attribution. Prefer a short duration so clips stay brief. Editorial/fair-use only — does not bypass paywalls/DRM (gated media errors cleanly).',
      inputSchema: {
        url: z.string().url().describe('Public https URL of the news video (most news/social hosts supported via yt-dlp).'),
        id: z.string().optional().describe('Asset id to register in the library catalog (default: derived from a content hash).'),
        start: z.number().nonnegative().optional().describe('Clip start time in seconds. Combine with `duration` to pull just that section.'),
        duration: z.number().positive().optional().describe('Clip length in seconds. With `start` set, bounds the downloaded section; alone, caps the transcode (default 20s).'),
        date: z.string().optional().describe('Capture date (YYYY-MM-DD) recorded in provenance for attribution.'),
      },
    },
    async ({ url, id, start, duration, date }) => {
      const res = await fetchNewsclip({
        url,
        rootDir: PROJECT_ROOT,
        ...(id ? { id } : {}),
        ...(start !== undefined ? { start } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(date ? { date } : {}),
      });
      return { content: [{ type: 'text', text: JSON.stringify(res, null, 2) }] };
    },
  );
}
