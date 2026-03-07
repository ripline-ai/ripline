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
node dist/cli/run.js -p pipelines/examples/hello-world.yaml -i samples/hello-world-inputs.json
```

With the package installed, you can omit `-p` when using the default examples directory; the CLI defaults to `pipelines/examples/hello-world.yaml`:

```bash
ripline run -i samples/hello-world-inputs.json
```

Outputs are written to `.ripline/runs/<runId>/run.json` and, if you pass `-o <path>`, to that file.

---

## Quickstart

1. **Clone and install**

   ```bash
   git clone https://github.com/craigjmidwinter/openclaw-pipeline-plugin ripline
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
     "id": "pipeline-orchestrator",
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

1. Install: npm install @vector/openclaw-pipeline-plugin (or add the plugin from the repo path if not published).

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

---

## Automation (cron, CI, npx)

Run Ripline from cron, CI, or any automation without cloning the repo.

### npx

```bash
npx @vector/openclaw-pipeline-plugin run -p pipelines/examples/hello-world.yaml -i samples/hello-world-inputs.json
```

If the package is installed globally or as a dependency, the `ripline` bin is available:

```bash
ripline run -p <path> [-i <inputs>] [-o <out>]
```

### Advanced: area-owner and cron

For the optional area-owner workflow and backlog summary:

```bash
npx @vector/openclaw-pipeline-plugin run -p pipelines/templates/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json
```

Daily cron example (area-owner, email summary):

```bash
0 13 * * * cd /path/to/openclaw-pipeline-plugin && npm run build && node bin/ripline.js run -p pipelines/templates/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json -o dist/backlog-cron.json 2>&1 | mail -s "Ripline backlog" you@example.com
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

Ripline can coordinate a multi-stage product flow: area-owner signals → breakdown → design spec → engineering plan → implementation queue. Each agent sees only the slice relevant to its step. See the YAML in [pipelines/examples/ripline-area-owner.yaml](pipelines/examples/ripline-area-owner.yaml) and [docs/templates/ripline-area-owner.md](docs/templates/ripline-area-owner.md).

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
