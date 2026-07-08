# Agentic Animation Factory — SaaS / Deploy-Ready Design

**Date:** 2026-07-08
**Status:** Draft (awaiting review)
**Scope:** Convert the deterministic Animation Factory from a *human-operated* pipeline (a person driving the CLIs and applying judgment) into an *autonomous, agent-operated* pipeline, and make it deploy-ready. Portfolio-flagship first; open-source; extensible as code **and** live after deploy.

---

## 1. Context

Today the factory is a mature **deterministic compiler**: `script → Story IR → Scene IR → frames → MP4`, with a plugin engine, content-addressed caching, a Zod IR, a Remotion render adapter, and a clean CLI surface (`factory:footage/photo/newsshot/newsclip`, `narrate`, `sfx`, `render`, `publish`, `imagegen`).

The missing piece is **judgment**. Right now a human (the operator) *is* the orchestration layer: call a tool → read its output → judge it ("this footage is fireworks, not fire") → decide the next move → verify ("this riser peaks after its boom") → iterate. Every quality outcome depends on that human loop.

**This project externalizes that loop** into an autonomous team of specialist agents wired by a deterministic orchestrator, with the operator's craft rules encoded as **executable verification gates**. The render pipeline is unchanged — agents emit *data* (IR), never frames (golden rule 2).

### The crux, in one line
> Deploying this is not primarily a hosting problem. It is an **agent-design** problem: replace the operator's cognition with specialist agents + verify gates, expose the engine as tools, and only then wrap it in a service.

## 2. Goals / Non-goals

**Goals**
- G1. A **brief → finished video** pipeline that runs with **zero human intervention**.
- G2. **Determinism preserved**: the render stays byte-identical; the (stochastic) agent step is tamed by content-addressed caching (run-once, replay-fixed) — the existing M5 `LlmDirector` pattern, generalized.
- G3. **Extensible** at every layer: a new capability is an additive plugin / agent / tool / gate / data entry, **never a core edit**. Some extension is **live** (no redeploy); the rest is additive.
- G4. **Deploy-ready**: an async, worker-based topology that survives minutes-long, RAM-heavy renders.
- G5. **Value banks incrementally**: each milestone (P0…P5) is an independently demoable **portfolio artifact**.

**Non-goals (explicitly out of scope for the flagship)**
- Billing, metering, subscription plans, multi-tenant auth hardening (scaffold the *shape*, don't build the store).
- Serving *other paying users'* LLM inference (the `claude -p` constraint — see §11).
- Model training / fine-tuning / a model registry.
- Chasing the funded text-to-video market head-on.

## 3. Design principles (carried up from the engine)

1. **Determinism is the moat.** Same IR → byte-identical MP4. The nondeterministic LLM step is **run once, validated, content-addressed cached, and replayed** — so a warm brief reproduces exactly (as TTS/imagegen/`LlmDirector` already do).
2. **Every layer: thin generic core + extension registry.** The core specializes in *nothing*; capability = a plugin/agent (code), content = the library (data). Enforced by the delete-the-plugin test, extended to agents/tools/gates.
3. **Standards at the boundary, own the compiler.** Adopt **MCP** (tool protocol), **Zod** (I/O contracts), **Langfuse** (tracing), `claude -p` (LLM). *Do not* adopt LangChain/LangGraph/DSPy/MLflow — they own the loop and would bury the cache-and-replay seam that *is* our determinism. Borrow their concepts (state-graph, prompt-as-artifact, tracing, evals), implement them thin in TS.
4. **Thin executors, not fat orchestrators.** The orchestrator is a small deterministic DAG runner; the intelligence lives in scoped specialist agents.
5. **Incremental & functional.** Each increment ships something that works and demos on its own.

## 4. Architecture — four layers

```
┌─ Service layer ──────────────────────────────────────────────┐
│ API (stateless) · queue · workers (agent pool + render pool) │
│ Postgres · object storage · Langfuse                         │
├─ Agent layer (NEW — the portfolio centerpiece) ──────────────┤
│ Orchestrator (deterministic DAG) → specialist agents         │
│ verify gates · agent-output cache · claude -p · Langfuse      │
├─ Tool boundary (NEW) ────────────────────────────────────────┤
│ MCP server — engine + library + asset CLIs exposed as tools  │
├─ Engine + Content (EXISTS) ──────────────────────────────────┤
│ deterministic compiler · plugin registries · IR (Zod)        │
│ content library · asset library (content-addressed, license) │
└──────────────────────────────────────────────────────────────┘
```

## 5. Monorepo structure (open-source shape)

pnpm/Nx workspace. Existing code becomes `engine` + `plugins` largely untouched; the rest is additive packages.

```
packages/
  engine/      # EXISTS: ir, pipeline, render, engine registries  (src/* today)
  plugins/     # EXISTS: capability plugins (generators/rigs/effects/transitions/dataviz…)
  library/     # EXISTS: content + asset resolver (content-addressed, provenance/license)
  mcp-server/  # NEW: wraps engine+library+asset capabilities as MCP tools  ← tool boundary
  agents/      # NEW: specialist agents + orchestrator + quality gates + versioned prompts
  eval/        # NEW: eval harness over golden briefs
  api/         # NEW: stateless HTTP (submit brief, poll job, fetch artifacts)
  worker/      # NEW: queue consumers — agent-orchestration pool + render pool
  web/         # NEW: thin UI (brief in, progress, preview, publish)
infra/         # compose/deploy manifests + Langfuse + MinIO + Postgres
```

Migration is mechanical: wrap today's `src/` as `packages/engine`, `plugins/` as `packages/plugins`; no behavior change (a workspace move, guarded by typecheck + a golden render).

## 6. Tool boundary — the MCP server

The CLIs are refactored into a **callable core** (typed TS functions) with the existing CLI as a thin wrapper; the MCP server exposes those functions as tools. This gives one contract used by *both* built-in agents and any external MCP client.

**Tool families (initial):**
- `library.*` — resolve/list content + asset catalog entries, pin/verify (wraps `LibraryResolver`/`AssetRefResolver`).
- `footage.search|browse|pick|verify` — the browse-and-verify workflow (contact-sheet frames returned as the on-subject signal).
- `photo.search|pick`, `newsshot.capture`, `newsclip.fetch` — evidence sources (provenance/license packed in).
- `narrate.probe` — synth-or-cache a line, return duration + (optional) word timings (for fitting beats + SFX placement).
- `sfx.synth`, `music.list` — audio palette.
- `map.preview` — render a **still** of a map config (fast verify of projection/framing).
- `compile.probe` — lower a Story IR → Scene IR and render `--frames auto` stills (fast layout verify before the slow full render).
- `render.submit` — enqueue a full render (async; returns a job handle).
- `publish.submit` — dispatch to a Publisher (registry; YouTube today).

**Live extensibility:** the MCP server loads tool plugins dynamically (a tool manifest), so a new tool = a new capability agents can use **without redeploying the agents**.

## 7. Agent layer

### 7.1 Specialist roster
Each specialist has a **Zod input contract**, a **Zod output contract** (an IR fragment), a **scoped tool-belt**, and a **verify gate**. Adding a role = a new agent manifest + a DAG entry (additive).

| Specialist | In → Out | Tools | Verify gate (fail → retry) |
|---|---|---|---|
| **Story Architect** | brief, style, len, aspect → Story-IR beats (say/show intents, structure tags) | (research later) | reads-as-one-story; hook/turn/payoff present; आप-respectful direct address; pronunciation locks; duration budget |
| **Asset Scout** | beat asset intents → resolved asset refs | footage.*, photo.*, newsshot, newsclip | **on-subject** (verifier judges contact sheet); license + provenance present; context-specific (right country/entity) |
| **Map Designer** | geographic beats → map generator configs | map.preview | projection valid; region framed tight; labels present; **choropleth-safe** (no `draw_on` on choropleth); official `world-in` where legally required |
| **Audio Designer** | beats + narration timings → sfx cues, music bed, ducking | narrate.probe, sfx.synth, music.list | **riser peak = start + round(1.2·fps)**; riser ≤ once, only on the biggest reveal; SFX ducked under VO (`mix`); loudness floor |
| **Assembler** | all fragments → complete Story IR (`show[]`, camera, transitions, Ken Burns, durations) | compile.probe | **zero VO overlaps**; durations fit narration (+~0.9s); safe-area/layout; stills render clean |
| **Verifier** | any stage output → verdict | (reads tool outputs) | adversarial, perspective-diverse checks; majority-refute kills the fragment |

> The craft rules that cost the operator repeated vigilance this session (fireworks-not-fire, stitched-headlines, riser out-of-nowhere) become **gate code** here — deterministic where possible (riser math, loudness, overlap), agent-judged where not (on-subject, one-story).

### 7.2 Orchestrator
A small deterministic **DAG runner** (TS). Per node:
1. **Cache lookup** — key = `hash(node inputs + PROMPT_VERSION + tool-results hash)`. Hit → replay the fixed fragment (no LLM call). Miss → run.
2. **Run** the specialist (`claude -p`, schema-validated output; retry on schema-mismatch — the M5 pattern).
3. **Verify** — run the gate. Pass → advance + persist to cache. Fail → **bounded retry** feeding the verifier's critique back into the prompt.
4. **Fallback** — repeated fail → a deterministic default (heuristic pick / neutral choice) or escalate to a human-review queue; never hard-fail the run.

State = an accumulating Story IR + a provenance ledger. Given warm caches the whole run is deterministic; the render is byte-deterministic from the resulting IR.

### 7.3 Determinism boundary (state this honestly)
- **Render:** byte-identical given the IR (unchanged).
- **Agent step:** *cached-deterministic* — the first run of a brief calls the LLM (nondeterministic) once; the validated result is content-addressed and **replayed** thereafter. So **same brief → same video after the first run**; two *cold* runs of the same brief may differ (like re-rolling a stochastic generator). This is exactly how TTS/imagegen/`LlmDirector` already behave, and it is acceptable and documented.

### 7.4 LLM backend
`claude -p --output-format json`, keyless — the existing `src/pipeline/director.ts` seam generalized from "director" to "every specialist." Behind a **provider registry** so a paid API key (or a local model) is a drop-in if multi-tenant is ever pursued. Prompts are **versioned data** (`PROMPT_VERSION`, like `PASS_VERSION`) so a prompt change invalidates the agent cache.

### 7.5 Observability — Langfuse
Self-hosted (OSS, TS SDK). One **trace per run**; spans per **agent**, per **tool call**, per **verify gate**, per **retry**, with token cost + latency + the verify verdict. This makes the verify-retry loop (e.g. "footage rejected off-subject → re-picked") *visible* — the single best recruiter-facing artifact.

## 8. Quality gates / verification model

Two kinds, composed per stage:
- **Deterministic checks** (pure functions, cheap, exact): riser peak timing, SFX mix ≤ threshold, zero VO overlap, duration-fits-narration, projection-valid, choropleth-safety, license-present, loudness floor.
- **Adversarial agent checks** (judgment): on-subject, reads-as-one-story, context-specific, register (आप vs तू/तुम). Use **perspective-diverse verifiers** (2–3 lenses, majority-refute kills). Default to *refuted* under uncertainty so a bad fragment doesn't slip through.

Gates are a **registry** — a new gate is additive and can be attached to any stage.

## 9. Eval harness (`packages/eval`)

The gates *are* the metrics. A set of **golden briefs** (varied: reel/doc, map-heavy/footage-heavy, different topics) runs the whole pipeline offline and reports **quality-gate pass-rates** (on-subject %, riser-timing correctness, loudness-in-range, zero-overlap rate, retries-per-run, token cost/video). Regressions surface as pass-rate drops. This is the reliability engine **and** a strong portfolio artifact ("I measure my agents, not just build them").

## 10. Data structures & multi-tenancy shape

Shaped for multi-tenant even while single-tenant:
- `Tenant → Project → Job → Artifact`.
- **Project** = manifest + story + scene.json + lock + assets, namespaced per tenant in object storage (today's `projects/<id>/` layout, hosted).
- **Library** = shared public (content-addressed) + optional per-tenant private namespace.
- **Provenance ledger** (Postgres + JSONL) — every asset's source/license (fair-use compliance is a first-class record, not a comment).

## 11. Deployment topology + the honest constraint

```
Web ─▶ API (stateless) ─▶ queue (Redis/BullMQ)
                              ├─▶ agent-orchestration workers  (claude -p; light CPU)
                              └─▶ render workers               (RAM-heavy; isolated pool)
Object storage (MinIO/S3): assets, outputs, caches
Postgres: tenants, projects, jobs, provenance
Langfuse (self-hosted): traces
```
Render **must** be off-request (minutes-long, RAM-heavy) — hence the queue + a **separate** render pool.

⚠️ **The one real constraint:** agent workers need LLM inference, and the zero-budget path is `claude -p` **keyless = an authenticated Claude CLI**. Perfect for a **single-tenant flagship** (the agent worker runs on the operator's box or a VPS with the CLI logged in). It does **not** cleanly serve *other* paying users (one account, rate limits, ToS). Accepted, because monetization is a non-goal; the provider registry preserves a paid-key drop-in for a hypothetical multi-tenant future.

## 12. Extension surface (the open-source contribution points)

| Extend | Mechanism | Live (no redeploy)? |
|---|---|---|
| Engine capability | `plugins/<id>/` (plugin.json + register) | redeploy |
| MCP tool | tool manifest in `mcp-server` | **yes** (dynamic load) |
| Specialist agent / stage | agent manifest + DAG entry | redeploy (additive) |
| Quality gate | gate registry entry | redeploy (additive) |
| Stylekit / library content | data (JSON / catalog) | **yes** (runtime data) |
| Publisher (TikTok/IG…) | publish registry (YouTube exists) | redeploy (additive) |
| LLM provider | provider registry (`claude -p` default) | config |

## 13. Build sequence — each increment is a standalone portfolio artifact

> **Value-banking rule:** you never need to reach the end to have won. Each Pn ships something demoable.

### P0 — Factory-over-MCP
- **Scope:** refactor CLIs → callable core; stand up `mcp-server` exposing the tool families (§6).
- **Verify:** an MCP client (or the operator) drives the *entire* factory through MCP tools end-to-end.
- 🎞 **Portfolio artifact:** "A whole deterministic video factory, exposed as an MCP server." **Show it:** connect Claude Desktop / any MCP client, ask it to build a reel, screen-record it calling `footage.pick` → `narrate.probe` → `render.submit`.

### P1 — Orchestrator skeleton + first specialist + tracing
- **Scope:** the DAG runner, the agent-output cache, Langfuse wiring, and the **Story Architect** (rest of the pipeline still manual/CLI).
- **Verify:** a brief → a valid structured Story IR, autonomously, with a Langfuse trace.
- 🎞 **Portfolio artifact:** "An autonomous agent writes a structured, verified story from a one-line brief — here's the trace." **Show it:** the brief, the Story IR, the Langfuse span tree.

### P2 — Full specialist team + verify gates  ← **the flagship demo**
- **Scope:** Asset Scout, Map Designer, Audio Designer, Assembler, Verifier; all gates; retry/fallback.
- **Verify:** **brief → finished, publish-quality reel with zero human touch**; the trace shows verify-retry loops in action.
- 🎞 **Portfolio artifact:** THE headline piece — "One brief in, a finished video out, no human — and you can watch the agents *correct themselves*." **Show it:** the video + a Langfuse trace with a visible "off-subject footage rejected → re-picked" or "riser mistimed → fixed" loop.

### P3 — Eval-driven reliability
- **Scope:** `packages/eval`, golden briefs, pass-rate report.
- **Verify:** a metrics report; a seeded regression is caught by a pass-rate drop.
- 🎞 **Portfolio artifact:** "I don't just build agents, I measure them." **Show it:** the eval report (pass-rates, retries/run, cost/video) + a caught regression.

### P4 — Deployed self-serve
- **Scope:** `api` + `worker` (both pools) + queue + object storage + Postgres + thin `web` UI.
- **Verify:** submit a brief in the browser → watch progress → download the video.
- 🎞 **Portfolio artifact:** "It's live." **Show it:** a URL + a 60–90s screen recording, brief-to-video, plus the architecture diagram.

### P5 — Production-shaped & provably general
- **Scope:** multi-tenancy scaffolding, more publishers, contribution docs (how to add a tool/agent/gate/publisher), and — to prove the pattern is domain-agnostic — a *second* small domain wired through the same orchestrator.
- **Verify:** an external contributor can add a specialist/tool by following the docs; the second domain runs end-to-end.
- 🎞 **Portfolio artifact:** "A reusable agentic-pipeline framework, open-source, proven on two domains." **Show it:** the OSS repo + "extend it" guide + the second-domain demo.

## 14. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Cold-run agent nondeterminism confuses "determinism" claim | Document the boundary (§7.3): render is byte-exact; agent step is cached-deterministic (run-once, replay). |
| `claude -p` can't serve other users | Accepted (§11); single-tenant flagship; provider registry keeps a paid-key drop-in. |
| Agent quality regressions | The eval harness (P3) + versioned prompts (`PROMPT_VERSION`) + verify gates. |
| Render RAM/latency on a shared box | Separate render worker pool; async queue; CPU-raster default (byte-safe, disk-safe). |
| Monorepo migration breaks the engine | Mechanical move guarded by typecheck + a golden render diff; behavior unchanged. |
| Scope creep into billing/multi-tenant | Explicit non-goals (§2); scaffold shape only. |

## 15. Open questions (for the plan phase)

- Queue: BullMQ (Redis) vs a Postgres-backed queue (one less service for local-first)?
- Web UI: minimal server-rendered vs a small SPA — how much is needed for the demo?
- How many golden briefs constitute a meaningful eval set for P3?
- Do we vendor Langfuse via docker-compose in `infra/`, or point at Langfuse Cloud's free tier for the demo?

---

*Next: on approval, an implementation plan (writing-plans) that sequences P0→P5 into concrete, verifiable steps.*
