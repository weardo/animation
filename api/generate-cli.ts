// factory:generate — the ONE blessed way to make a project from the terminal. It runs the EXACT SAME
// pipeline the dashboard uses (createJob → orchestrate + render), so a CLI-generated project is byte-for-byte
// the same as a dashboard one AND shows up in the dashboard (which lists the projects dir). No more ad-hoc
// scripts that call orchestrateBrief directly and diverge. Usage:
//   npm run generate -- "<brief>" [--language Hinglish] [--aspect 9:16] [--style plain] [--mode story] [--no-humour]
import { loadDotenv } from './env.js';
import { createJob, getJob } from './jobs.js';
import type { StoryBrief } from '../agents/story-architect.js';

loadDotenv();

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const brief = argv.find((a) => !a.startsWith('--'));
  if (!brief) {
    process.stderr.write('usage: npm run generate -- "<brief>" [--language Hinglish] [--aspect 9:16] [--style plain] [--mode story] [--no-humour]\n');
    process.exit(1);
  }
  const req: StoryBrief = {
    brief,
    language: flag(argv, '--language') ?? 'Hinglish',
    aspect: (flag(argv, '--aspect') as StoryBrief['aspect']) ?? '9:16',
    style: (flag(argv, '--style') as StoryBrief['style']) ?? 'plain',
    mode: (flag(argv, '--mode') as StoryBrief['mode']) ?? 'story',
    ...(argv.includes('--no-humour') ? { humour: false } : {}),
  };

  // The IDENTICAL dashboard pipeline: createJob kicks off orchestrate + render in the background; we just
  // poll the same job store until it finishes, echoing the same stage progress the dashboard shows.
  const job = createJob(req);
  process.stdout.write(`[generate] job ${job.id} — "${brief}"\n`);
  let lastStage = -1;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    const j = getJob(job.id);
    if (!j) continue;
    for (let i = lastStage + 1; i < j.stages.length; i++) {
      process.stdout.write(`  · ${j.stages[i]!.name}\n`);
      lastStage = i;
    }
    if (j.status === 'done') {
      process.stdout.write(`[generate] ✓ done → projects/${j.projectId}/media/out.mp4  (shows in the dashboard)\n`);
      process.exit(0);
    }
    if (j.status === 'error') {
      process.stderr.write(`[generate] ✗ ${j.error ?? 'failed'}\n`);
      process.exit(1);
    }
  }
}

main().catch((e: Error) => {
  process.stderr.write(`[generate] ${e.message}\n`);
  process.exit(1);
});
