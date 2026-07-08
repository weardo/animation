// Render tools — the pipeline's terminal stage, exposed to the Assembler agent.
//
// The render/compile flow lives in a large CLI main() (src/cli/render.ts) that runs the whole
// compile → narrate → sfx → music → render sequence. Rather than extract that (risky), these tools
// SHELL OUT to the existing CLI as a subprocess — which is also the right long-term shape: a render is
// a minutes-long, RAM-heavy job that belongs off the request. So:
//   • compile_probe — runs `--frames auto` (fast stills, ~seconds) and WAITS → cheap layout verify.
//   • render_submit — spawns the FULL render DETACHED and returns immediately with a handle; progress
//     is followed via the project's own media/render.log (the async-job model, ahead of the P1 runner).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { PROJECT_ROOT, PROJECTS_DIR } from '../context.js';

/** Tail the last N non-empty lines of a file (best-effort). */
function tail(path: string, n: number): string {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  return lines.slice(-n).join('\n');
}

export function registerRenderTools(server: McpServer): void {
  server.registerTool(
    'compile_probe',
    {
      title: 'Compile + probe (still frames)',
      description:
        'Compile a story file into a project and render still frames only (`--frames auto`, ~seconds) — a FAST layout/verify pass before the slow full render. Waits for completion. Returns the project id, the media dir, and a log tail.',
      inputSchema: {
        story: z.string().describe('Path to the story .yaml, relative to the repo root (e.g. projects/foo/story.yaml).'),
        projectId: z.string().describe('Target project id (writes to projects/<id>/).'),
        audio: z.boolean().default(false).describe('Include audio passes (usually false for a quick layout probe).'),
      },
    },
    async ({ story, projectId, audio }) => {
      const args = ['tsx', 'src/cli/render.ts', story, '--project', projectId, '--frames', 'auto'];
      if (!audio) args.push('--no-audio');
      const code = await new Promise<number>((res) => {
        const p = spawn('npx', args, { cwd: PROJECT_ROOT, stdio: 'ignore' });
        p.on('close', (c) => res(c ?? -1));
        p.on('error', () => res(-1));
      });
      const mediaDir = resolve(PROJECTS_DIR, projectId, 'media');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projectId,
            status: code === 0 ? 'ok' : 'failed',
            exitCode: code,
            mediaDir,
            log: tail(resolve(mediaDir, 'render.log'), 12),
          }, null, 2),
        }],
      };
    },
  );

  server.registerTool(
    'render_submit',
    {
      title: 'Submit a full render (async)',
      description:
        'Compile a story and render the FULL video (with audio) as a DETACHED background job — returns immediately with the expected output path. Follow progress via the returned render log path (projects/<id>/media/render.log). This is a minutes-long job.',
      inputSchema: {
        story: z.string().describe('Path to the story .yaml, relative to the repo root.'),
        projectId: z.string().describe('Target project id (writes to projects/<id>/).'),
        audio: z.boolean().default(true).describe('Run narration/sfx/music passes and mux audio.'),
        engine: z.string().optional().describe('TTS engine override (e.g. sarvam).'),
        voice: z.string().optional().describe('TTS voice override (e.g. shubh).'),
      },
    },
    async ({ story, projectId, audio, engine, voice }) => {
      const args = ['tsx', 'src/cli/render.ts', story, '--project', projectId];
      if (!audio) args.push('--no-audio');
      if (engine) args.push('--engine', engine);
      if (voice) args.push('--voice', voice);
      const child = spawn('npx', args, { cwd: PROJECT_ROOT, detached: true, stdio: 'ignore' });
      child.unref();
      const mediaDir = resolve(PROJECTS_DIR, projectId, 'media');
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            projectId,
            status: 'started',
            pid: child.pid,
            outputPath: resolve(mediaDir, 'out.mp4'),
            renderLog: resolve(mediaDir, 'render.log'),
            note: 'Detached render running; poll renderLog for progress and outputPath for the finished mp4.',
          }, null, 2),
        }],
      };
    },
  );
}
