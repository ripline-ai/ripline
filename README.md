# Ripline

> Repeatable AI agent workflows with multi-agent review built in.

## What Ripline is

Ripline is a pipeline engine for building repeatable, auditable multi-agent workflows. You describe the flow as a YAML DAG, Ripline executes it reliably, and every run is traceable and resumable.

Key capabilities:

- **Declarative DAG pipelines in YAML** — Each step (inputs, agent calls, transforms, approvals) is explicit with typed contracts between phases.
- **Native multi-agent review phases** — Built-in `plan`, `review`, and `review_only` phase kinds fan out to multiple AI CLIs in parallel, evaluate quorum, and retry on disagreement. No custom orchestration code required.
- **Voice/lineage system** — Route phases to specific AI CLIs (Claude, Codex, Gemini, Kimi, OpenCode) by lineage rather than hardcoded runner names. The registry detects installed CLIs automatically.
- **Input/output contracts** — JSON Schema validation between steps catches mismatches before they propagate.
- **Resumable runs, loop nodes, sub-pipelines** — Long-running workflows survive interruptions; loops and fan-out are first-class constructs.
- **CLI + HTTP API** — Run locally, trigger from CI, or expose an HTTP surface for dashboards and external integrations.

## Quick-start example: architecture review pipeline

The following pipeline defines an architecture review workflow. Claude writes a draft design, then two reviewers (Gemini and Codex) critique it in parallel. If either reviewer requests changes, the doer gets the feedback and tries again, up to three rounds.

```yaml
id: arch_review
name: Architecture review
version: 1
description: Draft an architecture, then fan out to two reviewers for quorum approval.
entry: [plan_arch]

phases:
  - id: plan_arch
    kind: plan
    title: Draft architecture
    description: |
      You are a senior software architect. The user has requested:

      {{ inputs.request }}

      Write a concise architecture document covering: system components, data flow,
      key technology choices, and risks. Use markdown headings.
    doer:
      lineage: anthropic
    iterate:
      maxRounds: 3
      onDisagreement: continue

  - id: review_arch
    kind: review
    title: Architecture review
    description: |
      Review the architecture document produced by the previous phase.
      Focus on soundness, scalability, and risk coverage.
    doer:
      lineage: anthropic
    reviewer:
      require: 2
      crossLineage: true
      candidates:
        - lineage: google
        - lineage: openai
    iterate:
      maxRounds: 3
      onDisagreement: continue
    inputs:
      include: [plan_arch]
```

Run it:

```bash
ripline run --pipeline pipelines/arch-review.yaml \
  --input '{"request": "Design a URL shortening service that handles 10k req/s"}'
```

See [docs/review-pipelines.md](docs/review-pipelines.md) for the full guide, including the programmatic API (`parseChorusTemplate` / `loadChorusTemplate`) and `ship` config for auto-PR after approval.

---

## Why Ripline exists

Coordinating multiple agents, tools, and humans through ad-hoc scripts doesn't scale. Ripline gives you a typed pipeline engine so every step is explicit:

- Each node has a schema and output contract.
- Runs are traceable and resumable, so you can splice new work in midstream.
- Pipelines live as code/YAML, so you can version them, review them, and hand them to other teams.

### Principles

1. **Visible flow.** Every run has a traceable line — nodes, payloads, durations, and retries.
2. **Multi-agent by default.** Review phases distribute work to multiple AI CLIs in parallel and evaluate quorum before proceeding.
3. **Hot reload.** Pipelines are plain YAML/JSON. Edit, reroute, and relaunch without restarting the engine.
4. **Open surface.** CLI + HTTP API + optional dashboards. Use whichever view fits the work.

---

## Feature highlights

- Graph DSL with loops, inline fragments, and reusable sub-pipelines
- Built-in `plan`, `review`, and `review_only` phase kinds with quorum and retry logic
- Voice/lineage registry routing phases to Claude, Codex, Gemini, Kimi, or OpenCode
- Type-checked registry that watches `pipelines/` and validates on save
- In-memory run store with resumable IDs and JSON payload snapshots
- CLI runner for local testing
- HTTP surface (default `/pipelines`) for boards, metrics, and visualizations
- **Per-node agent runners:** optional `runner: claude-code` with **plan** (read-only) or **execute** mode and configurable `cwd`; see [Using Claude Code as a runner](docs/agent-integration.md#using-claude-code-as-a-runner)
- Declarative DAG pipelines in YAML or JSON
- Runtime input/output contracts at pipeline and node boundaries
- Default context isolation with optional shared-session continuity
- Built-in node types for `input`, `transform`, `agent`, `http`, `loop`, `output`, and sub-pipelines
- Resumable runs with persisted state in `.ripline/runs`
- CLI and HTTP API for triggering, inspecting, retrying, and streaming runs
- Built-in agent runners for LLM providers, Claude Code, and Codex
- Optional OpenClaw integration for teams already running Ripline inside OpenClaw

## Hello World

```yaml
id: hello_world
name: Hello World Pipeline
entry:
  - intake
nodes:
  - id: intake
    type: input
    description: Provide `person` and optional `goal` fields
  - id: enrich
    type: transform
    expression: "({ greeting: `Hello, ${inputs.person}!`, goal: inputs.goal ?? 'explore Ripline' })"
  - id: finalize
    type: output
    path: hello.result
    source: enrich
edges:
  - from: { node: intake }
    to:   { node: enrich }
  - from: { node: enrich }
    to:   { node: finalize }
```

**Run it:**

```bash
npm install
npm run build
ripline run --pipeline pipelines/examples/hello-world.yaml \
  --input '{"person":"World","goal":"get started"}'
```

Outputs are written to `.ripline/runs/<runId>/run.json`. Use `-o <path>` to also write final output to a separate file.

## Core concepts

### Contracts between steps

Ripline lets you validate both top-level run input/output and per-node input/output with JSON Schema. That gives you a real boundary between steps instead of hoping downstream prompts can tolerate whatever upstream emitted.

### Context isolation

`agent` nodes use a fresh session by default with `resetSession: true`. That prevents context bleed across nodes and across runs. If a workflow genuinely needs continuity, set `resetSession: false` on the nodes that should share a run-level session.

### Repeatable runs

Pipeline definitions are files. Run inputs are explicit. Run artifacts are persisted. That makes successful runs reproducible and failures easier to debug.

- **Stream messages** — Each Claude Agent SDK message is logged with `type` and `subtype` so you can see turns in real time.
- **Result dump** — On `type=result`, the full message is logged (truncated to 2000 chars).
- **Failure detail** — On non-success (e.g. `error_max_turns`), the runner logs `subtype`, `errors`, and a result snippet before throwing.
- **Config at startup** — Set **`RIPLINE_LOG_CONFIG=1`** to log `maxTurns`, `timeoutMs`, `mode`, and `cwd` once per invocation.

**Viewing logs:**

- **CLI:** `ripline logs <runId>` prints the run's log file; `ripline logs <runId> --follow` polls and streams new lines until the run completes. Use `--api-url http://localhost:4001` to fetch from the HTTP server instead of the local runs dir.
- **HTTP API:** `GET /runs/:runId/logs` returns log content (plain text or `?format=json`); `GET /runs/:runId/logs/stream` streams new lines via SSE. See [HTTP API](docs/http-api.md#get-run-logs).

Run-scoped logs are written to `<runsDir>/<runId>/log.txt` whenever a run is executed with a file-based run store (e.g. scheduler, server, or CLI with default runs dir).

---

## Quickstart

1. Clone and install:

   ```bash
   git clone https://github.com/craigjmidwinter/ripline
   cd ripline
   npm install
   ```

2. Build:

   ```bash
   npm run build
   ```

3. Run the example pipeline:

   ```bash
   node bin/ripline.js run \
     --pipeline pipelines/examples/hello-world.yaml \
     --input samples/hello-world-inputs.json
   ```

4. Start the HTTP API if needed:

   ```bash
   node bin/ripline.js serve
   ```

## Agent runners

Ripline supports several ways to run `agent` nodes:

- **LLM runner:** Ollama, OpenAI, or Anthropic for stateless prompt execution
- **Claude Code runner:** tool-using local execution with `plan` or `execute` mode
- **Codex runner:** tool-using local execution with `plan` or `execute` mode
- **OpenClaw runner:** optional integration when Ripline is hosted inside OpenClaw
- **Stub runner:** useful for testing pipeline structure without a real model

See [Agent integration](docs/agent-integration.md) for configuration and runner-selection rules.

## Logs and observability

- `ripline logs <runId>` reads the run log for a stored run
- `ripline logs <runId> --follow` streams until completion
- `GET /runs/:runId/logs` returns run logs over HTTP
- `GET /runs/:runId/logs/stream` streams log updates over SSE

When using Claude Code or Codex runners, Ripline stores run-scoped logs in `<runsDir>/<runId>/log.txt`.

   ```bash
   node dist/cli/run.js serve   # default port 4001
   ```

   See [docs/http-api.md](docs/http-api.md) for available endpoints.

---

## Automation (cron, CI, npx)

Run Ripline from cron, CI, or any automation without cloning the repo.

### npx

```bash
npx ripline run -p pipelines/examples/hello-world.yaml -i samples/hello-world-inputs.json
```

If the package is installed globally or as a dependency, the `ripline` bin is available:

```bash
ripline run -p <path> [-i <inputs>] [-o <out>]
```

### Advanced: area-owner and cron

For the optional area-owner workflow and backlog summary:

```bash
npx ripline run -p pipelines/templates/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json
```

Daily cron example (area-owner, email summary):

```bash
0 13 * * * cd /path/to/ripline && npm run build && node bin/ripline.js run -p pipelines/templates/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json -o dist/backlog-cron.json 2>&1 | mail -s "Ripline backlog" you@example.com
```

Or use the helper script:

```bash
npm run cron:area-owner
```

See [docs/automation-cron.md](docs/automation-cron.md) for env vars (`RIPLINE_INPUTS`, `RIPLINE_OUT`).

### GitHub Action

The repo includes [.github/workflows/ripline-demo.yml](.github/workflows/ripline-demo.yml): on push/PR it runs `npm run demo` and uploads `dist/demo-artifact.json` as an artifact.

### Failure handling

- **Exit codes:** CLI exits `0` on success, non-zero on failure. Use in cron or scripts for alerts or retries.
- **Resume:** `ripline run --resume <runId>` to continue a paused or failed run.
- **Logs:** Run state in `.ripline/runs/<runId>/run.json`; use `--verbose` for per-node logs.
- **runsDir:** Set plugin config `runsDir`, CLI `--runs-dir`, or env `RIPLINE_RUNS_DIR`. Plan for cleanup; runs are not auto-deleted.
- **Queue:** `ripline run --enqueue` adds a run to the queue for later processing (e.g. via worker or HTTP API).

---

## Anatomy of a pipeline

- **Node types:** `input`, `transform`, `agent`, `http`, `loop`, `fork`, `output`, and inline sub-pipelines.
- **Phase kinds:** `plan`, `review`, `review_only` for multi-agent review workflows (see [docs/review-pipelines.md](docs/review-pipelines.md)).
- **Edges:** Always explicit. Ripline refuses implicit fall-through so reroutes stay intentional.
- **Expressions:** JS/TS snippets in a sandbox with `inputs`, `context`, and `env`.

**Advanced example: product-engineering loop**

Ripline can coordinate a multi-stage product flow: area-owner signals → breakdown → design spec → engineering plan → implementation queue. Each agent sees only the slice relevant to its step. See the YAML in [pipelines/examples/ripline-area-owner.yaml](pipelines/examples/ripline-area-owner.yaml) and [docs/templates/ripline-area-owner.md](docs/templates/ripline-area-owner.md). For simpler copy-paste examples (Implement Story, Spec→Build→Queue, Write Tech Script), see [pipelines/examples/](pipelines/examples/README.md) and [docs/pipelines/example-pipelines.md](docs/pipelines/example-pipelines.md).

---

## Documentation

| Guide | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install Ripline and run your first pipeline |
| [Pipeline reference](docs/pipeline-reference.md) | All node types, fields, edges, contracts, and template syntax |
| [Review pipelines](docs/review-pipelines.md) | Multi-agent review phases: plan/review/review_only, quorum, retry loop |
| [CLI reference](docs/cli-reference.md) | All commands, flags, and environment variables |
| [Configuration reference](docs/configuration.md) | All config files, env vars, plugin config, and precedence rules |
| [HTTP API](docs/http-api.md) | REST endpoints for triggering and inspecting runs |
| [Pipelines and profiles](docs/pipelines-and-profiles.md) | Pipeline directory, profile system, and user config |
| [Agent integration](docs/agent-integration.md) | Runner configuration: Claude Code, Codex, Gemini, Kimi, OpenCode |
| [Automation and cron](docs/automation-cron.md) | Cron jobs, CI, and messaging integrations |
| [OpenClaw integration](docs/integrations/openclaw.md) | Supported OpenClaw integration details |

---

## Developing pipelines

| Workflow | What to do |
| --- | --- |
| Reusable nodes | Put fragments in `pipelines/lib/*.yaml`, reference with `type: pipeline` |
| Input validation | Use `inputs` schema blocks in the pipeline definition |
| Debug | Use `--verbose` for per-node logs |
| Resume | `ripline run --resume <runId>` restarts from the failed node |

---

## Observability

- **run-store:** Pluggable provider (memory, SQLite, Dynamo). Defaults to memory.
- **events:** JSON events (`pipeline.run.started`, `node.completed`, `node.errored`) for dashboards and 3rd-party sinks.
- **metrics:** Prometheus-style helpers under `/pipelines/metrics`.

---

## Multi-agent async orchestration

Ripline is designed for workflows where multiple specialized agents must coordinate without blocking each other. The core pattern: each agent node runs as a fully isolated subprocess, so slow or long-running agents never starve fast ones.

### How it works

```
Pipeline YAML  →  Ripline scheduler  →  AI CLI subprocess  →  JSON artifact
                   (4 concurrent          (isolated session,
                    workers)               fresh context)
```

1. **Declare the flow** as a graph of `agent` nodes (or review `phases`) in YAML. Edges express data dependencies, not timing.
2. **Ripline queues runs** and dispatches up to `maxConcurrency` nodes simultaneously.
3. **Artifacts propagate** through the graph: the JSON output of each node becomes available to downstream nodes as template variables (`{{nodeid.text}}` or `{{variableName}}`).

### Example: parallel breakdown + spec pipeline

```yaml
id: product_spec
name: Parallel product spec
entry: [intake]
nodes:
  - id: intake
    type: input
  - id: break-down
    type: agent
    agentId: vector
    prompt: "Break {{task}} into engineering features."
  - id: design-spec
    type: agent
    agentId: nova
    prompt: "Write a design spec for these features: {{break-down.text}}"
  - id: eng-plan
    type: agent
    agentId: vector
    prompt: "Estimate effort for: {{design-spec.text}}"
  - id: result
    type: output
    source: eng-plan
edges:
  - { from: { node: intake },      to: { node: break-down } }
  - { from: { node: break-down },  to: { node: design-spec } }
  - { from: { node: design-spec }, to: { node: eng-plan } }
  - { from: { node: eng-plan },    to: { node: result } }
```

Each agent sees only the slice of context relevant to its step.

### Fire-and-forget spawning

Trigger a pipeline run asynchronously via HTTP and poll for completion:

```bash
# Enqueue a run (returns immediately with a runId)
run_id=$(curl -s -X POST http://localhost:4001/pipelines/product_spec/runs \
  -H "Content-Type: application/json" \
  -d '{"task":"OAuth login flow"}' | jq -r '.runId')

# Poll until done
while true; do
  status=$(curl -s http://localhost:4001/runs/$run_id | jq -r '.status')
  [[ "$status" == "completed" || "$status" == "failed" || "$status" == "errored" ]] && break
  sleep 2
done

# Fetch artifacts
curl -s http://localhost:4001/runs/$run_id | jq '.artifacts'
```

### Session isolation

By default every agent node gets a fresh session (UUID). This means:
- No history bleeds between pipeline runs or between nodes in the same run.
- You can run the same pipeline concurrently without agents seeing each other's context.

To keep continuity across nodes (e.g. a multi-turn conversation flow), set `resetSession: false` on downstream nodes and pass a shared `sessionId` in the run context.

### Scaling

| Setting | Effect |
|---|---|
| `maxConcurrency: 4` (default) | Up to 4 agent nodes run in parallel across all active pipeline runs |
| `timeoutSeconds` per node | Per-node deadline; the scheduler kills the subprocess and marks the node `errored` |
| `runsDir` | Persist run state across restarts; resume with `ripline run --resume <runId>` |

---

## Roadmap

- [ ] Type-safe config schemas per node type
- [ ] Browser-side graph editor backed by the HTTP API
- [ ] Agent-to-agent triggers and human approval nodes
- [ ] Terraform-style plan/apply mode for destructive nodes

---

## OpenClaw integration

Ripline can be loaded as an OpenClaw plugin. When running inside an OpenClaw host, the host provides the agent runner and Ripline's pipeline graph executes within the platform's sandbox.

**Plugin config example:**

```jsonc
{
  "id": "ripline",
  "from": "./path/to/ripline/openclaw.plugin.json",
  "config": {
    "pipelinesDir": "./pipelines",
    "runsDir": ".ripline/runs",
    "maxConcurrency": 4,
    "httpPath": "/pipelines",
    "httpPort": 4001,
    "authToken": "optional-bearer-token"
  }
}
```

See [docs/agent-integration.md](docs/agent-integration.md) for runner selection rules when inside vs. outside an OpenClaw host.

---

## Contributing

1. Fork and clone the repo
2. `npm install && npm run build && npm test`
3. Open a PR with the scenario you changed and how you verified it

## License

MIT © Craig Midwinter
