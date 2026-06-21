---
name: refine-standard
description: Use after completing a workflow, milestone, or significant build to fold learnings back into the factory standard. Keeps CLAUDE.md, the skills, and the decisions log a growing, self-refining standard. Run it as the closing step of every workflow.
---

# Refine the Standard (retrospective → standard)

The factory standard must **grow** (add skills + decisions) and **self-correct** (delete/fix rules the build disproved). This is the closing ritual after meaningful work.

## Steps

1. **Collect learnings** from what just happened: decisions made and why; gotchas/surprises; conventions that emerged; anything that broke determinism; reuse choices that worked or failed; new repeatable processes.
2. **Append to `docs/factory/DECISIONS.md`** — one dated entry per decision/learning: *Context → Decision → Rationale → (Supersedes?)*. Append-only; supersede rather than rewrite history.
3. **Update CLAUDE.md golden rules** — ONLY for durable, repeatable lessons. Not one-offs. Keep it tight (it loads every session).
4. **Create or update skills** for any new repeatable process. Keep skills **thin** (encode process, invoke the project CLI for actual work — don't embed fat logic) and **contract-level** (stable against implementation churn).
5. **Delete/correct** any rule or skill the build proved wrong. Stale standards are worse than none.
6. **Commit** the standard changes separately from code, with a clear message.

## Principle

A self-refining standard is not "write once." Each cycle: capture → distill durable rules → encode as skills → prune the disproven. The standard's quality compounds the same way the asset library does.
