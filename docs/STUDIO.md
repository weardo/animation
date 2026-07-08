# Animation Factory — Studio (self-hosted)

A single-user, self-hosted web app: type a brief, an AI **Story Architect** writes the script, and the
deterministic factory renders it into a video — all on your own machine. No cloud, no per-video API cost.

## Run it

```bash
npm install
npm run studio          # → http://localhost:5055
```

Open the URL, type what the video is about, pick aspect/style/length, and click **Generate video**.
Watch the live progress (story → render), then the video plays right in the page.

### Requirements

- **Node 20+** and **ffmpeg** (the render/muxing engine).
- **espeak-ng** — the default offline TTS (`apt install espeak-ng`). Fast, robotic; swap in a nicer
  engine later (see the render engines in `src/cli/narrate.ts`).
- **The `claude` CLI, authenticated** — the Story Architect calls `claude -p` keyless (your own
  Claude subscription). On localhost this is free + unconstrained. Set `CLAUDE_BIN` to override the
  binary, or point the provider at a paid API key if you prefer.

Everything the render itself needs (Remotion's Chromium, fonts) installs with `npm install`.

## How it works (the pipeline)

```
brief ─▶ Story Architect (claude -p) ─▶ story.yaml ─▶ render (deterministic) ─▶ out.mp4
         agents/story-architect.ts        projects/<id>/     src/cli/render.ts
```

- **`agents/`** — the agent layer. `claude.ts` is the LLM backend (keyless `claude -p`), `story-architect.ts`
  turns a brief into a Zod-validated Story IR (retries on validation error, content-addressed cache so a
  repeated brief replays exactly), `orchestrate.ts` writes `projects/<id>/story.yaml`.
- **`api/`** — the local server (`server.ts`) + job runner (`jobs.ts`). A brief becomes a JOB that runs
  the orchestrator then spawns the render; jobs persist to `.data/jobs.json`.
- **`web/`** — the UI (`index.html`): Create · live Progress · Preview · Recent.
- **`mcp-server/`** — the same factory capabilities exposed as MCP tools (`npm run mcp`), so an agent or
  any MCP client can drive footage/photo/narration/render directly.

Determinism holds where it matters: the **render** is byte-identical from a given Story IR; the
**agent** step is nondeterministic once, then cached and replayed (run-once, replay-fixed).

## Determinism & caches

- `.cache/agents/` — cached Story Architect outputs (per brief).
- `projects/<id>/` — the generated story + rendered media + content-addressed asset/audio caches.
- `.data/jobs.json` — the job history.

Delete any of these to force a rebuild.
