// Orchestration worker — runs the (blocking) Story Architect + Asset Scout in its OWN process so the
// studio server's event loop never freezes. The footage proxy-transcode (ffmpeg, synchronous) and other
// heavy steps would otherwise block the server for a minute+ mid-job. Reads the brief JSON from stdin,
// writes the OrchestrateResult JSON to stdout. The server spawns this and reads the result.
// STDOUT carries ONLY the result JSON (the parent parses it). The factory's callable core logs progress
// ([footage] proxy lines, etc.) to stdout — redirect those to stderr so they don't corrupt the result.
console.log = (...a: unknown[]) => console.error(...a);
console.info = (...a: unknown[]) => console.error(...a);
console.debug = (...a: unknown[]) => console.error(...a);

import { loadDotenv } from './env.js';
import { orchestrateBrief } from '../agents/orchestrate.js';
import type { StoryBrief } from '../agents/story-architect.js';

loadDotenv();

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const brief = JSON.parse(input) as StoryBrief;
  orchestrateBrief(brief)
    .then((r) => {
      process.stdout.write(JSON.stringify(r));
      process.exit(0);
    })
    .catch((e: Error) => {
      process.stderr.write(e.message);
      process.exit(1);
    });
});
