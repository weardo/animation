// Narrate tools — a thin wrapper around src/cli/narrate.ts's `synthNarration`, the OFFLINE TTS
// synth-or-cache used by the render pipeline (golden rule 1: the cached wav is the deterministic
// record, not the engine). `narrate_probe` lets an agent audition a line of narration — same
// content-addressed cache, same engine fallback chain — without wiring up a whole project first.
import { resolve } from 'node:path';

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  synthNarration,
  DEFAULT_ENGINE,
  DEFAULT_VOICE,
  DEFAULT_WPM,
  type NarrateEngine,
  type NarrateRequest,
} from '../../src/cli/narrate.js';
import { PROJECT_ROOT, DEFAULT_FPS } from '../context.js';

const NARRATE_ENGINES = [
  'espeak-ng',
  'coqui',
  'kokoro',
  'chatterbox',
  'parler',
  'indic-parler',
  'indicf5',
  'sarvam',
] as const;

/** Scratch cache for probing narration outside any project — content-addressed, safe to share/reuse. */
const PROBE_AUDIO_DIR = resolve(PROJECT_ROOT, '.cache', 'narrate-probe');

export function registerNarrateTools(server: McpServer): void {
  server.registerTool(
    'narrate_probe',
    {
      title: 'Probe a narration line',
      description:
        'Synthesize (or reuse the cached) narration wav for a line of text via the offline TTS pipeline — the same content-addressed cache the render uses (skip-if-exists). A missing/broken optional engine falls back to espeak-ng, never fails. Returns the wav path, engine actually used, and duration in both seconds and frames.',
      inputSchema: {
        text: z.string().min(1).describe('The line of narration to synthesize.'),
        engine: z
          .enum(NARRATE_ENGINES)
          .default(DEFAULT_ENGINE)
          .describe('TTS engine to use; falls back to espeak-ng if its venv/binary is unavailable.'),
        voice: z
          .string()
          .optional()
          .describe('Engine voice id (defaults per-engine, e.g. "shubh" for sarvam, "en" for espeak-ng).'),
        wpm: z.number().int().positive().default(DEFAULT_WPM).describe('Words-per-minute pacing (espeak-ng).'),
        tone: z
          .string()
          .optional()
          .describe('Tone/conditioning description prompt (parler / indic-parler).'),
        style: z
          .record(z.number())
          .optional()
          .describe(
            'Optional numeric engine params, folded into the cache key (e.g. {exaggeration, cfg} for chatterbox; {pace, temperature, sample_rate} for sarvam).',
          ),
        fps: z
          .number()
          .int()
          .positive()
          .default(DEFAULT_FPS)
          .describe('Frames per second used to compute the duration in frames.'),
      },
    },
    async ({ text, engine, voice, wpm, tone, style, fps }) => {
      const req: NarrateRequest = {
        text,
        engine: engine as NarrateEngine,
        voice: voice ?? DEFAULT_VOICE[engine as NarrateEngine],
        wpm,
        ...(tone !== undefined ? { tone } : {}),
        ...(style !== undefined ? { style } : {}),
      };
      const result = synthNarration(req, PROBE_AUDIO_DIR, PROJECT_ROOT);
      const durationFrames = Math.round(result.durationSeconds * fps);
      return {
        content: [{ type: 'text', text: JSON.stringify({ ...result, durationFrames, fps }, null, 2) }],
      };
    },
  );
}
