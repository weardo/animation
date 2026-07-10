// caption-english — translate a beat's Hinglish/Hindi narration line into clean, punchy ENGLISH subtitle
// text, OFFLINE + content-addressed cached (skip-if-exists → deterministic replay), via keyless `claude -p`.
// This backs the `flow` caption mode: subtitles are ALWAYS English (a muted / non-Hindi viewer reads along)
// while the narration voice stays Hinglish. Golden rule 1/2: the stochastic LLM runs ONCE at BUILD into a
// FIXED cache; the render replays the cached English, so the output is byte-deterministic. Any failure
// (no `claude`, bad output) falls back to the original text — never breaks the build.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Bump when the prompt changes → invalidates the cache (like a pass PASS_VERSION). */
const PROMPT_VERSION = 'caption-en@1';
const CLAUDE_BIN = process.env['CLAUDE_BIN'] ?? 'claude';

const SYSTEM =
  'You are a subtitle translator for a news video. Translate the following Hinglish/Hindi narration line ' +
  'into natural, PUNCHY ENGLISH subtitles a viewer reads while listening. Keep it CONCISE and faithful — ' +
  'no padding, no explanation, keep numbers/names exactly. Output ONLY the English translation on one line, ' +
  'no quotes, no notes.';

/** Extract the model text from `claude -p --output-format json` (the reply is in `.result`). */
function extractResult(stdout: string): string {
  try {
    const j = JSON.parse(stdout) as { result?: unknown };
    if (typeof j.result === 'string') return j.result.trim();
  } catch {
    /* not JSON — fall through */
  }
  return stdout.trim();
}

/**
 * Translate one narration line to English subtitle text. Content-addressed cached under
 * `.cache/captions/en/<hash>.txt`. Returns the original `text` on any failure (graceful, build never fails).
 */
export function translateToEnglish(text: string, rootDir: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const key = createHash('sha256').update(PROMPT_VERSION + '\n' + trimmed).digest('hex').slice(0, 16);
  const cacheDir = resolve(rootDir, '.cache/captions/en');
  const cacheFile = resolve(cacheDir, `${key}.txt`);
  if (existsSync(cacheFile)) return readFileSync(cacheFile, 'utf8');

  let english = trimmed;
  try {
    const stdout = execFileSync(
      CLAUDE_BIN,
      ['-p', '--output-format', 'json', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--allowedTools', ''],
      { input: `${SYSTEM}\n\nLINE: ${trimmed}`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 20 },
    );
    const out = extractResult(stdout).replace(/^["'\s]+|["'\s]+$/g, '').replace(/\s+/g, ' ').trim();
    if (out) english = out;
  } catch {
    // no `claude` binary / bad output → keep the original (the caption still shows, just not translated).
    english = trimmed;
  }

  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cacheFile, english, 'utf8');
  return english;
}

/** True when the narration language is English (so no translation is needed — use the `say` verbatim). */
export function isEnglishLang(lang: string | undefined): boolean {
  return !!lang && /^en\b/i.test(lang);
}
