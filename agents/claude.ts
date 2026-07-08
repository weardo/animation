// The LLM backend for every specialist agent: keyless `claude -p` (JSON mode, no tools/MCP), the same
// seam the M5 LlmDirector uses — generalized here from "director" to "any agent". Determinism is
// preserved one level up: callers content-address + cache the VALIDATED result (run-once, replay-fixed).
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude';

/**
 * Run `claude -p` with the prompt on stdin; resolve with the model's text reply (the `.result` field).
 * ASYNC (spawn, not execFileSync) so a ~40s call never blocks the server's event loop — a synchronous
 * call froze the studio and made it refuse connections mid-job.
 */
export function runClaudeText(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    // Keyless JSON mode, NO tools/MCP (reference_claude_p_as_llm_backend: cuts per-call tokens, and
    // --strict-mcp-config stops it from recursively loading OUR mcp-server).
    const p = spawn(
      CLAUDE_BIN,
      ['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', ''],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited ${code}: ${err.slice(0, 300)}`));
        return;
      }
      try {
        resolvePromise((JSON.parse(out) as { result?: string }).result ?? '');
      } catch (e) {
        reject(e as Error);
      }
    });
    p.stdin.write(prompt);
    p.stdin.end();
  });
}

/** Pull the first JSON object/array out of a model reply (tolerating ```json fences + prose around it). */
export function extractJson(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  const objStart = t.indexOf('{');
  const arrStart = t.indexOf('[');
  const start = objStart < 0 ? arrStart : arrStart < 0 ? objStart : Math.min(objStart, arrStart);
  const end = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  return JSON.parse(t) as unknown;
}
