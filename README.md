# Ripline

> Graph-native pipeline engine for OpenClaw agents. Describe the flow, run it, and reroute in real time.

## Why Ripline exists

Coordinating multiple agents, tools, and humans through email threads or ad-hoc scripts doesn't scale. Ripline gives you a typed pipeline engine so every step (inputs, contracts, owners, artifacts) is explicit:

- Each node (agent prompt, script, API call, approval) has a schema and output contract.
- Runs are traceable and resumable, so you can splice new work in midstream.
- Pipelines live as code/YAML, so you can version them, review them, and hand them to other teams.

In short: turn messy cross-team workflows into a graph you can see, change, and rerun safely.

### Principles

1. **Visible flow.** Every run has a traceable line — nodes, payloads, durations, and retries.
2. **Agent-first.** Anything an OpenClaw agent can call (prompt, tool, HTTP, human) becomes a node type.
3. **Hot reload.** Pipelines are plain YAML/JSON. Edit, reroute, and relaunch without restarting the engine.
4. **Open surface.** CLI + HTTP API + optional dashboards. Use whichever view fits the work.

## Feature highlights

- Graph DSL with loops, inline fragments, and reusable sub-pipelines
- Type-checked registry that watches `pipelines/` and validates on save
- In-memory run store with resumable IDs and JSON payload snapshots
- CLI runner for local testing plus plugin hook for OpenClaw
- HTTP surface (default `/pipelines`) for boards, metrics, and visualizations
- **Per-node agent runners:** optional `runner: claude-code` with **plan** (read-only) or **execute** mode and configurable `cwd`; see [Using Claude Code as a runner](docs/agent-integration.md#using-claude-code-as-a-runner)

---

## Hello World example

A minimal pipeline has three steps: **input** (consume JSON), **transform** (compute with a small expression), **output** (write an artifact).

**Pipeline** (`pipelines/examples/hello-world.yaml`):

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

**Sample inputs** (e.g. `samples/hello-world-inputs.json`):

```json
{
  "person": "World",
  "goal": "get started"
}
```

**Run it:**

```bash
npm run build
ripline run --pipeline pipelines/examples/hello-world.yaml --input samples/hello-world-inputs.json
```

Or run by **pipeline ID** from your pipeline directory with a **profile** for default inputs (see [Pipelines and profiles](docs/pipelines-and-profiles.md)):

```bash
ripline run hello_world --profile myapp --input '{"task": "add login"}'
```

Outputs are written to `.ripline/runs/<runId>/run.json` and, if you pass `-o <path>`, to that file.

---

## Logging

When using the **Claude Code runner** (`runner: claude-code`), the runner logs to stderr (and to `<runsDir>/<runId>/log.txt` when running a stored run):

- **Stream messages** — Each Claude Agent SDK message is logged with `type` and `subtype` so you can see turns (system/init → assistant → user → …) in real time.
- **Result dump** — On `type=result`, the full message is logged (truncated to 2000 chars).
- **Failure detail** — On non-success (e.g. `error_max_turns`), the runner logs `subtype`, `errors`, and a result snippet before throwing.
- **Config at startup** — Set **`RIPLINE_LOG_CONFIG=1`** to log `maxTurns`, `timeoutMs`, `mode`, and `cwd` once per invocation.

**Viewing logs:**

- **CLI:** `ripline logs <runId>` prints the run’s log file; `ripline logs <runId> --follow` polls and streams new lines until the run completes. Use `--api-url http://localhost:4001` to fetch from the HTTP server instead of the local runs dir.
- **HTTP API:** `GET /runs/:runId/logs` returns log content (plain text or `?format=json`); `GET /runs/:runId/logs/stream` streams new lines via SSE. See [HTTP API](docs/http-api.md#get-run-logs).

Run-scoped logs are written to `<runsDir>/<runId>/log.txt` whenever a run is executed with a file-based run store (e.g. scheduler, server, or CLI with default runs dir).

---

## Quickstart

1. **Clone and install**

   ```bash
   git clone https://github.com/craigjmidwinter/ripline
   cd ripline
   npm install
   ```

2. **Build**

   ```bash
   npm run build
   ```

3. **Run the Hello World pipeline**

   ```bash
   node dist/cli/run.js -p pipelines/examples/hello-world.yaml -i samples/hello-world-inputs.json
   ```

   Or run the built-in demo (same pipeline with stub agent, writes to `dist/demo-artifact.json`):

   ```bash
   npm run demo
   ```

4. **Optional: HTTP server**

   - Standalone: `node dist/cli/run.js serve` (default port 4001). See [docs/http-api.md](docs/http-api.md).
   - As a plugin: add the plugin to your OpenClaw host and set `pipelinesDir` (and optionally `runsDir`, `httpPath`, `httpPort`, `authToken`). Example host config:

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

---

## Configuring OpenClaw or Claude Code

Use the following prompt so an assistant (OpenClaw or Claude Code) can install and run Ripline with the Hello World example.

**Copyable prompt:**

```
Install and configure the Ripline pipeline plugin for OpenClaw.

1. Install: npm install ripline (or add the plugin from the repo path if not published).

2. Config: Ensure the plugin is loaded with at least:
   - pipelinesDir: path to a directory containing pipeline YAML/JSON (e.g. "./pipelines")
   Optional: runsDir (default ".ripline/runs"), httpPath ("/pipelines"), httpPort (4001), authToken, maxConcurrency (4).

3. First run: Use the Hello World example.
   - Pipeline: pipelines/examples/hello-world.yaml
   - Inputs: samples/hello-world-inputs.json or inline {"person":"World","goal":"get started"}
   - Command: ripline run -p pipelines/examples/hello-world.yaml -i samples/hello-world-inputs.json
   If -p is omitted and the working directory has pipelines/examples/hello-world.yaml, that pipeline is used by default.

4. Demo (no real agent): ripline run --demo — runs Hello World with a stub agent and writes to dist/demo-artifact.json.
```

### Running agent nodes without OpenClaw

You can run pipelines with real agent nodes locally using Ollama, OpenAI, or Anthropic—no OpenClaw required. Set `RIPLINE_AGENT_PROVIDER` and `RIPLINE_AGENT_MODEL` (and `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` for those providers), or use a config file (`.ripline/agent.json` or `ripline.config.json` with an `agent` section). CLI flags work too: `ripline run --agent-provider ollama --agent-model llama3.2`. See [Agent integration](docs/agent-integration.md) for details.

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

See [docs/automation-cron.md](docs/automation-cron.md) for env vars (`RIPLINE_INPUTS`, `RIPLINE_OUT`) and wiring into AgentMail/Telegram.

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
- **Edges:** Always explicit. Ripline refuses implicit fall-through so reroutes stay intentional.
- **Expressions:** JS/TS snippets in a sandbox with `inputs`, `context`, and `env`.

**Advanced example: product-engineering loop**

Ripline can coordinate a multi-stage product flow: area-owner signals → breakdown → design spec → engineering plan → implementation queue. Each agent sees only the slice relevant to its step. See the YAML in [pipelines/examples/ripline-area-owner.yaml](pipelines/examples/ripline-area-owner.yaml) and [docs/templates/ripline-area-owner.md](docs/templates/ripline-area-owner.md). For simpler copy-paste examples (Implement Story, Spec→Build→Queue, Write Tech Script) in both OpenClaw and Claude Code variants, see [pipelines/examples/](pipelines/examples/README.md) and [docs/pipelines/example-pipelines.md](docs/pipelines/example-pipelines.md).

---

## Documentation

| Guide | Contents |
| --- | --- |
| [Pipeline reference](docs/pipeline-reference.md) | All node types, fields, edges, contracts, and template syntax |
| [CLI reference](docs/cli-reference.md) | All commands, flags, and environment variables |
| [Configuration reference](docs/configuration.md) | All config files, env vars, plugin config, and precedence rules |
| [HTTP API](docs/http-api.md) | REST endpoints for triggering and inspecting runs |
| [Pipelines and profiles](docs/pipelines-and-profiles.md) | Pipeline directory, profile system, and user config |
| [Agent integration](docs/agent-integration.md) | OpenClaw, LLM, and Claude Code runner configuration |
| [Automation and cron](docs/automation-cron.md) | Cron jobs, CI, and messaging integrations |
| [Migrating from OpenClaw](docs/migrating-from-openclaw.md) | Parameterising hardcoded paths and profiles |

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

Ripline is designed for workflows where multiple specialized agents must coordinate without blocking each other. The core pattern: each agent node runs as a fully isolated subprocess via `openclaw agent --json`, so slow or long-running agents never starve fast ones.

### How it works

```
Pipeline YAML  →  Ripline scheduler  →  openclaw agent --json  →  JSON artifact
                   (4 concurrent          (isolated session,
                    workers)               fresh context)
```

1. **Declare the flow** as a graph of `agent` nodes in YAML. Edges express data dependencies, not timing.
2. **Ripline queues runs** and dispatches up to `maxConcurrency` nodes simultaneously.
3. **Each agent call** spawns `openclaw agent --json --agent <id> --session-id <uuid> --message <prompt>`. The UUID keeps sessions isolated so accumulated history from one run can't contaminate another.
4. **Artifacts propagate** through the graph: the JSON output of each node becomes available to downstream nodes as template variables (`{{nodeid.text}}` or `{{variableName}}`).

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

Each agent sees only the slice of context relevant to its step. `vector` and `nova` can be different models, tools, or personas — Ripline doesn't care.

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

By default every agent node gets a fresh `--session-id` (UUID). This means:
- No history bleeds between pipeline runs or between nodes in the same run.
- You can run the same pipeline concurrently without agents seeing each other's context.

To keep continuity across nodes (e.g. a multi-turn conversation flow), set `resetSession: false` on downstream nodes and pass a shared `sessionId` in the run context. The scheduler threads the session ID through automatically.

### Scaling

| Setting | Effect |
|---|---|
| `maxConcurrency: 4` (default) | Up to 4 agent nodes run in parallel across all active pipeline runs |
| `timeoutSeconds` per node | Per-node deadline; the scheduler kills the subprocess and marks the node `errored` |
| `runsDir` | Persist run state across restarts; resume with `ripline run --resume <runId>` |

---

## Background Queue & Auto-Execution

Ripline includes a priority-based background queue that automatically executes pipeline runs sequentially. Items are persisted to a YAML file and scored with a time-decaying priority formula. When auto-dispatch is enabled, the **AutoExecutor** pops the highest-priority pending item, runs it via `source: 'background'`, and dispatches the next item only after the current one completes or fails.

### How it works

1. **Enqueue** items via `POST /queue` with a pipeline ID, optional inputs, and priority weights.
2. **Enable auto-dispatch** via `PUT /config/background-queue` with `{ "enabled": true }`.
3. The AutoExecutor dispatches items one at a time (sequential execution). The next item is dispatched only after the current run completes or errors.
4. **Circuit breaker:** If a run errors, the item is retried (status returns to `pending`). After `maxRetries` failures the item is marked `failed` with `needsReview: true` and no further retries occur.
5. **Telegram notifications** are sent for `run_started`, `run_completed`, and `run_failed` events (when configured).

### Priority scoring

```
score = severityWeight + (ageInHours × 0.5) + manualBoost
```

- `severityWeight` (default: 1) — base weight for the item
- `manualBoost` (default: 0) — user-adjustable priority bump
- Age-based decay: older items naturally rise in priority at 0.5 points per hour

### Configuration

All background-queue settings live in `~/.ripline/config.json`:

```jsonc
{
  "backgroundQueue": {
    "enabled": false,   // Whether auto-dispatch starts on boot (default: false)
    "maxRetries": 3     // Circuit-breaker retry limit (default: 3 in config loader, 5 in constructor fallback)
  },
  "telegram": {
    "botToken": "123456:ABC-DEF...",  // Telegram Bot API token (optional)
    "chatId": "-1001234567890"        // Telegram chat ID for notifications (optional)
  }
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `backgroundQueue.enabled` | boolean | `false` | Auto-dispatch on server boot. Can be toggled at runtime via `PUT /config/background-queue`. |
| `backgroundQueue.maxRetries` | number | `3` | Max retry attempts before circuit-breaker marks item `failed`. |
| `telegram.botToken` | string | — | Telegram Bot API token. Notifications are skipped if not set. |
| `telegram.chatId` | string | — | Telegram chat/group ID. Notifications are skipped if not set. |

### Queue item lifecycle

```
pending → running → completed
                  → errored → pending (retry)
                             → failed (circuit-breaker, needsReview: true)
```

### Queue data storage

The queue is persisted as a YAML array at `~/obsidian/Ops/queue.yaml` by default. Each item contains:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique identifier |
| `pipeline` | string | Pipeline ID to execute |
| `inputs` | object | Pipeline inputs |
| `priority` | number | Last computed priority score |
| `severityWeight` | number | Base priority weight (default: 1) |
| `manualBoost` | number | Manual priority adjustment (default: 0) |
| `createdAt` | number | Timestamp (ms) |
| `status` | string | `pending` / `running` / `completed` / `errored` / `failed` |
| `retries` | number | Current retry count |
| `maxRetries` | number | Max retries before circuit-breaker |
| `needsReview` | boolean | Set `true` when circuit-breaker trips |

### REST API

See [HTTP API — Background Queue](docs/http-api.md#background-queue) for full endpoint documentation.

```bash
# Add an item to the queue
curl -X POST http://localhost:4001/queue \
  -H "Content-Type: application/json" \
  -d '{"pipeline": "my_pipeline", "inputs": {"task": "implement feature X"}, "severityWeight": 2}'

# Enable auto-dispatch
curl -X PUT http://localhost:4001/config/background-queue \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'

# List queue items (sorted by priority)
curl http://localhost:4001/queue

# Disable auto-dispatch (current run finishes, no new dispatch)
curl -X PUT http://localhost:4001/config/background-queue \
  -H "Content-Type: application/json" \
  -d '{"enabled": false}'
```

### Wintermute UI components

The background queue is managed through three React components in the Wintermute dashboard:

- **`BackgroundQueueToggle`** — A toggle switch to enable/disable auto-dispatch at runtime. Calls `PUT /api/config/background-queue` with optimistic UI updates. Shows ON (green) / OFF (grey) state.

- **`ApprovalPanel`** — Two-section panel for queue triage:
  - *Needs Approval* — Items with status `needsReview`, `needs_approval`, or `pending_approval`. Each item has **Approve & Queue** and **Reject** buttons.
  - *Approved & Pending* — Approved items sorted by priority descending with a remove button. Polls every 10 seconds.

- **`QueueViewer`** — Full queue table showing all items with columns: Pipeline name, Priority (tabular), Status (color-coded badge), Age (human-readable), and Retry count. Polls every 10 seconds. Status badges are color-coded: pending (amber), running (blue), completed (emerald), failed/needsReview (rose), approved (cyan).

### PM2 restart behavior

When Ripline is restarted via `pm2 restart ripline` with `backgroundQueue.enabled: true` in the config, the AutoExecutor is enabled on boot and immediately checks the queue for pending items to dispatch.

---

## Roadmap

- [ ] Type-safe config schemas per node type
- [ ] Browser-side graph editor backed by the HTTP API
- [ ] Agent-to-agent triggers and human approval nodes
- [ ] Terraform-style plan/apply mode for destructive nodes

---

## Contributing

1. Fork and clone the repo
2. `npm install` then `npm run check && npm test`
3. Open a PR with scenario, steps, and screenshots/logs where relevant

## License

MIT © Craig Midwinter
