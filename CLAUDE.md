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

## Staging / Production

The `STAGE` env var selects the environment. Unset defaults to production.

| Stage | Port | Wintermute URL | Runs dir |
|-------|------|----------------|----------|
| production | 4001 | `http://localhost:3000` | `.ripline/runs/` |
| staging | 4002 | `http://localhost:3001` | `.ripline/runs-staging/` |

Both stages share the same pipeline definitions (`~/.ripline/pipelines`).

**PM2 process names:** `ripline-prod` (watch off), `ripline-staging` (watch on — auto-restarts on code changes).

See `~/ripline/ecosystem.config.js` for full PM2 config.

### Targeting a stage

```bash
STAGE=staging node dist/cli/run.js serve    # Start staging server on :4002
STAGE=production node dist/cli/run.js serve # Start production server on :4001 (default)
```

Pipelines automatically talk to the matching Wintermute instance based on stage.

## HTTP API

Default port: **4001** (production) / **4002** (staging).

```
POST /pipelines/:id/runs     ← start a run
GET  /runs/:runId            ← run status + artifacts
GET  /runs/:runId/logs       ← run logs
GET  /runs/:runId/logs/stream ← SSE log stream
GET  /pipelines/metrics      ← Prometheus-style metrics
```

## Env vars

| Variable | Purpose |
|----------|---------|
| `STAGE` | `production` (default) or `staging` — selects port and Wintermute URL |
| `RIPLINE_AGENT_PROVIDER` | LLM provider: ollama / openai / anthropic |
| `RIPLINE_AGENT_MODEL` | Model name for agent nodes |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `RIPLINE_RUNS_DIR` | Override runs directory |
| `RIPLINE_LOG_CONFIG` | Set to `1` to log runner config at startup |

## Run data

`.ripline/runs/<runId>/run.json` — run state
`.ripline/runs/<runId>/log.txt` — run logs

Resume with `--resume <runId>`. Exit code 0 = success, non-zero = failure.

## Background Queue & Auto-Execution

Sequential background pipeline execution with priority scoring and circuit-breaker retry logic.

### Key files

```
src/background-queue.ts   ← YAML-persisted queue with priority scoring + circuit breaker
src/auto-executor.ts      ← Sequential dispatcher, listens to EventBus for run completions
src/telegram.ts           ← Telegram Bot API notifications (run_started/completed/failed)
src/config.ts             ← loadUserConfig() reads backgroundQueue + telegram from ~/.ripline/config.json
src/types.ts              ← BackgroundQueueItem, BackgroundQueueConfig, TelegramConfig, RunSource
```

### Config (`~/.ripline/config.json`)

```json
{
  "backgroundQueue": { "enabled": false, "maxRetries": 3 },
  "telegram": { "botToken": "...", "chatId": "..." }
}
```

### REST endpoints

```
GET    /queue                      ← All items (with computedPriority), sorted desc
GET    /queue/approved             ← Pending items only, sorted by priority
POST   /queue                      ← Add item (pipeline required)
PATCH  /queue/:id                  ← Update priority/manualBoost/severityWeight/status
DELETE /queue/:id                  ← Remove item
PUT    /config/background-queue    ← Toggle { enabled: bool }, persists to config.json
GET    /config/background-queue    ← Current enabled state
```

### Priority formula

`score = severityWeight + ageInHours × 0.5 + manualBoost`

### Circuit breaker

On error: retries++ → if retries >= maxRetries, status = `failed`, needsReview = true. Otherwise status returns to `pending` for re-dispatch.

### Wintermute UI

- `BackgroundQueueToggle` — ON/OFF switch for auto-dispatch
- `ApprovalPanel` — Two-panel: needs-approval items + approved/pending items
- `QueueViewer` — Full queue table with status badges, priority, age, retry count

## Testing

```bash
npm test                        # Vitest — unit + integration tests
npm run check                   # tsc type-check
```

Key test files:
- `tests/config-stage.test.ts` — validates stage config resolution (ports, URLs)
- `tests/integration-staging.test.ts` — staging port 4002 and wintermuteBaseUrl

### Promote workflow

The promote script (`~/wintermute/bin/promote`) runs `npm test` in both `~/wintermute` and `~/ripline`. If all tests pass, it does a zero-downtime `pm2 reload` of `ripline-prod` and `wintermute-prod`.

```bash
~/wintermute/bin/promote            # Test then reload production
~/wintermute/bin/promote --dry-run  # Test only, no reload
```

**Gate checks:** promote exits non-zero if any test suite fails — production is never reloaded on failure.
