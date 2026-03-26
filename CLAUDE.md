# Ripline — Agent Context

> Graph-native pipeline engine for OpenClaw agents. Describe the flow, run it, and reroute in real time.

## What this is

Typed pipeline engine for coordinating agents, scripts, HTTP calls, and humans. Pipelines are YAML/JSON graphs — nodes with explicit edges, typed inputs/outputs, and traceable runs.

## Key commands

```bash
npm run build                    # Compile TypeScript
npm test                         # Jest tests
npm run check                    # Type check
npm run demo                     # Run Hello World with stub agent
npm run demo:area-owner          # Area-owner pipeline demo
node dist/cli/run.js -p <pipeline.yaml> -i <inputs.json>   # Run a pipeline
node dist/cli/run.js serve       # HTTP server (port 4001)
```

## Architecture

```
src/
  pipeline/         ← Graph execution engine
  cli/              ← CLI commands (run, serve, logs)
  lib/              ← Shared utilities
  schema.ts         ← Pipeline/node type schemas
  registry.ts       ← Pipeline watcher + validator
  run-store.ts      ← Run state persistence
  scheduler.ts      ← Concurrent run queue (maxConcurrency: 4)
  agent-runner-config.ts
  claude-code-runner.ts   ← Claude Code runner integration
  openclaw-agent-runner.ts
  llm-agent-runner.ts
pipelines/          ← Pipeline definitions (YAML/JSON)
  examples/
  templates/
  lib/              ← Reusable fragments
samples/            ← Sample input files
```

## Node types

`input`, `transform`, `agent`, `http`, `loop`, `fork`, `output`, inline sub-pipelines.

Edges are always explicit. No implicit fall-through.

## Claude Code runner

Nodes can use `runner: claude-code` with `mode: plan` (read-only) or `mode: execute`. Configure `cwd` per node. Set `RIPLINE_LOG_CONFIG=1` to log runner config at startup.

## HTTP API (port 4001)

```
POST /pipelines/:id/runs     ← start a run
GET  /runs/:runId            ← run status + artifacts
GET  /runs/:runId/logs       ← run logs
GET  /runs/:runId/logs/stream ← SSE log stream
GET  /pipelines/metrics      ← Prometheus-style metrics
```

## Env vars

`RIPLINE_AGENT_PROVIDER` (ollama/openai/anthropic), `RIPLINE_AGENT_MODEL`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RIPLINE_RUNS_DIR`, `RIPLINE_LOG_CONFIG`

## Run data

`.ripline/runs/<runId>/run.json` — run state
`.ripline/runs/<runId>/log.txt` — run logs

Resume with `--resume <runId>`. Exit code 0 = success, non-zero = failure.

## Testing

```bash
npm test          # Jest
npm run check     # tsc
```
