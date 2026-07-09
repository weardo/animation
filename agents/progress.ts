// Progress reporter for the orchestration subprocess. The subprocess's STDOUT carries the result JSON,
// so live progress is written to STDERR with a marker the parent (api/jobs.ts) parses into job stages.
// Harmless when no parent is listening (just stderr text).
export function progress(message: string): void {
  process.stderr.write(`@@P@@${message}\n`);
}
