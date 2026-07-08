// The LLM backend for every specialist agent: keyless `claude -p` (JSON mode, no tools/MCP), the same
// seam the M5 LlmDirector uses — generalized here from "director" to "any agent". Determinism is
// preserved one level up: callers content-address + cache the VALIDATED result (run-once, replay-fixed).
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude';

/** Run `claude -p` with a prompt on stdin; return the model's text reply (the `.result` field). */
export function runClaudeText(prompt: string): string {
  const stdout = execFileSync(
    CLAUDE_BIN,
    // Keyless JSON mode, NO tools/MCP (reference_claude_p_as_llm_backend: cuts per-call tokens, and
    // --strict-mcp-config stops it from recursively loading OUR mcp-server).
    ['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', ''],
    { input: prompt, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 32 * 1024 * 1024 },
  );
  const parsed = JSON.parse(stdout) as { result?: string };
  return parsed.result ?? '';
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
