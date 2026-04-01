# Ripline

> Repeatable AI agent workflows with explicit step boundaries, context isolation, and runtime contracts.

## Why Ripline exists

Most agent automation breaks down for boring reasons:

- prompts silently depend on hidden context from an earlier step
- one step changes shape and downstream steps fail in unclear ways
- successful runs are hard to repeat because the workflow only exists in ad-hoc shell scripts

Ripline is a pipeline engine for turning that into something explicit and repeatable.

- **Each step is declared.** Inputs, outputs, edges, retries, and prompts live in YAML or JSON.
- **Each step is isolated by default.** Agent nodes start with a fresh session unless you opt into continuity.
- **Each boundary can be validated.** Pipeline and node contracts use JSON Schema so data mismatches fail early.
- **Each run is inspectable.** Runs are persisted, resumable, and easy to replay.

Ripline is a workflow engine for repeatable agent-driven work.

## Feature highlights

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

Run it:

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

## Documentation

| Guide | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install Ripline and run your first pipeline |
| [Pipeline reference](docs/pipeline-reference.md) | Pipeline schema, node types, edges, templates, and contracts |
| [CLI reference](docs/cli-reference.md) | Commands, flags, and environment variables |
| [HTTP API](docs/http-api.md) | Trigger, inspect, retry, and stream runs over HTTP |
| [Configuration reference](docs/configuration.md) | User config, project config, runner config, and precedence rules |
| [Pipelines and profiles](docs/pipelines-and-profiles.md) | Pipeline directories, reusable profiles, and input defaults |
| [Agent integration](docs/agent-integration.md) | LLM, Claude Code, Codex, and OpenClaw runners |
| [Automation and cron](docs/automation-cron.md) | Generic scheduling and non-interactive execution patterns |
| [OpenClaw integration](docs/integrations/openclaw.md) | Supported OpenClaw integration details |

## Contributing

1. Fork and clone the repo
2. `npm install && npm run build && npm test`
3. Open a PR with the scenario you changed and how you verified it

## License

MIT © Craig Midwinter
