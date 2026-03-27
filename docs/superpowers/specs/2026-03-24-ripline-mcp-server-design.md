# Ripline Embedded MCP Server — Design Spec

**Date:** 2026-03-24
**Status:** Approved

---

## Overview

Add a stdio MCP server to the Ripline repo that embeds the Ripline pipeline engine directly. Claude Code (or any MCP-capable client) adds a single entry to its MCP config and gains the ability to trigger, monitor, and resume Ripline pipelines as first-class tools — no separate HTTP server process required.

---

## Goals

- Claude Code can trigger Ripline pipelines and poll results via MCP tools
- Self-contained: one process, no external dependencies beyond what Ripline already uses
- Configurable via CLI args (override) and `~/.ripline/config.json` (fallback)
- Works out of the box even without LLM credentials (stub runner fallback)
- No changes to existing Ripline modules; new files only

---

## Non-Goals

- Pipeline authoring tools (create/edit YAML) — deferred to a future Claude Code skill
- SSE or HTTP MCP transport — stdio is sufficient for Claude Code
- Blocking `run_pipeline` that waits for completion — fire-and-return-runId only
- Web dashboard or visualisation

---

## Architecture

### Entry Point

`src/mcp-server.ts` is the new entry point. It must include a `#!/usr/bin/env node` shebang at the top (matching the pattern used by `bin/ripline.js`). On startup it:

1. Resolves config (see Configuration section)
2. Instantiates `PipelineRunStore` from `src/run-store.ts`, then calls `await store.init()` to ensure the runs directory exists before any writes
3. Creates a `RunQueue` via `createRunQueue(store)` from `src/run-queue.ts`
4. Instantiates `PipelineRegistry` from `src/registry.ts` (watches `pipelinesDir`, hot-reloads on change)
5. Selects agent runner via `resolveStandaloneAgentRunner()` (see Runner Selection)
6. Calls `createScheduler({ store, queue, registry, agentRunner, maxConcurrency })` from `src/scheduler.ts` — note: `createScheduler` returns a plain object, not a class instance
7. Starts the stdio MCP server and registers tools

### New Files

```
src/
  mcp-server.ts          ← entry point (shebang + wires everything together)
  mcp/
    server.ts            ← MCP server setup (stdio transport, tool registration)
    tools.ts             ← tool handler implementations
    config.ts            ← CLI arg parsing + config resolution
```

### Build Output

Compiles to `dist/mcp-server.js` via the existing `tsconfig.json` (CommonJS output). Run directly as `node dist/mcp-server.js`. The shebang in `src/mcp-server.ts` ensures it is also executable directly.

### Existing Modules Used (unchanged)

| Module | Role |
|--------|------|
| `src/registry.ts` | Loads and watches pipeline YAML/JSON files |
| `src/scheduler.ts` | `createScheduler()` — queues and executes runs with concurrency control |
| `src/run-queue.ts` | `createRunQueue()` — FIFO queue consumed by the scheduler |
| `src/run-store.ts` | `PipelineRunStore` — persists run state to `.ripline/runs/<runId>/` |
| `src/log.ts` | Log file path helpers; log file at `<runsDir>/<runId>/log.txt` |
| `src/claude-code-runner.ts` | Runner for `runner: claude-code` nodes |
| `src/llm-agent-runner.ts` | LLM agent runner (Anthropic/OpenAI/Ollama) |
| `src/agent-runner-config.ts` | `resolveStandaloneLlmAgentConfig()` — full env-var + config-file resolution |
| `src/config.ts` | `loadUserConfig()` / `resolvePipelineDir()` — reads `~/.ripline/config.json` |

---

## Configuration

CLI args take precedence over user config file (`~/.ripline/config.json` via `loadUserConfig()`).

Config key column refers to `RiplineUserConfig` fields read from `~/.ripline/config.json`:

| CLI Flag | `RiplineUserConfig` Key | Default |
|----------|------------------------|---------|
| `--pipelines-dir <path>` | `pipelineDir` | `./pipelines` |
| `--runs-dir <path>` | _(not in `RiplineUserConfig`)_ | `.ripline/runs` |
| `--max-concurrency <n>` | `maxConcurrency` | `4` |

Notes:
- `RiplineUserConfig` uses `pipelineDir` (singular). The OpenClaw plugin config uses `pipelinesDir` (plural) — existing inconsistency; the MCP server follows the user config convention.
- `runsDir` is **not** a field on `RiplineUserConfig` (it exists only on `PipelinePluginConfig`). The config resolver in `src/mcp/config.ts` must handle `--runs-dir` as a standalone CLI override only, defaulting to `.ripline/runs` when absent — it cannot be read from `loadUserConfig()`.

Claude Code MCP config entry (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "ripline": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/openclaw/ripline/dist/mcp-server.js"]
    }
  }
}
```

With explicit pipelines dir:

```json
"args": ["/home/openclaw/ripline/dist/mcp-server.js", "--pipelines-dir", "/home/openclaw/my-pipelines"]
```

---

## MCP Tools

### `list_pipelines`

Returns all successfully loaded pipelines.

**Input:** none

**Output:**
```json
[
  { "id": "hello_world", "name": "Hello World Pipeline", "tags": [], "nodeCount": 3, "edgeCount": 2 }
]
```

---

### `run_pipeline`

Triggers a pipeline run. Returns immediately with a `runId`.

**Input:**
```json
{
  "pipeline_id": "hello_world",
  "inputs": { "person": "World" },
  "env": {}
}
```

**Output:**
```json
{ "runId": "r_abc123", "status": "queued" }
```

Note: `runId` values are plain UUIDs from `randomUUID()` — the `r_` prefix in examples is illustrative only.

Errors: `{ "error": "pipeline not found: <id>" }`

---

### `get_run`

Returns the full run record for a given `runId`.

**Input:** `{ "run_id": "r_abc123" }`

**Output:**
```json
{
  "id": "r_abc123",
  "pipelineId": "hello_world",
  "status": "completed",
  "inputs": { "person": "World" },
  "outputs": { "greeting": "Hello, World!" },
  "steps": [
    { "nodeId": "intake",   "status": "completed", "startedAt": 1742817600000, "finishedAt": 1742817601000 },
    { "nodeId": "enrich",   "status": "completed", "output": { "greeting": "Hello, World!" }, "finishedAt": 1742817602000 },
    { "nodeId": "finalize", "status": "completed", "finishedAt": 1742817603000 }
  ],
  "startedAt": 1742817600000,
  "updatedAt": 1742817603000
}
```

Note: `startedAt`, `updatedAt`, and step `finishedAt` are Unix millisecond timestamps (numbers), matching `PipelineRunRecord` and `PipelineRunStep` in `src/types.ts`. Step completion uses the `finishedAt` field name (not `completedAt`).

Errors: `{ "error": "run not found: <id>" }`

---

### `get_run_logs`

Returns log text for a run. The log file lives at `<runsDir>/<runId>/log.txt`.

**Input:** `{ "run_id": "r_abc123" }`

**Output:** `{ "logs": "<plain text log content>" }`

Error cases:
- Run record not found: `{ "error": "run not found: <id>" }`
- Run exists but log file not yet written (e.g. run is still `pending`): `{ "logs": "" }`

---

### `list_runs`

Lists recent runs, optionally filtered. `pipeline_id` filtering is applied in-memory after calling `store.list({ status })` — it is not a store-layer filter. The store's sort order is preserved as-is: `pending`/`running` runs are sorted by `startedAt` ascending (FIFO); all other statuses (including no filter) are sorted by `updatedAt` descending. `limit` is applied as a final slice after in-memory filtering, without re-sorting.

**Input:**
```json
{
  "pipeline_id": "hello_world",
  "status": "completed",
  "limit": 20
}
```
All fields optional. Default `limit`: 20.

**Output:**
```json
[
  { "id": "r_abc123", "pipelineId": "hello_world", "status": "completed", "startedAt": 1742817600000 }
]
```

---

### `resume_run`

Re-queues an errored or paused run. The scheduler resumes from the `cursor` stored on the run record — it does not support re-entry at an arbitrary node. The tool does not accept a `from_node` argument; it always uses the existing cursor.

Prior completed steps' artifacts are replayed automatically by the scheduler's resume path (reads `record.cursor.nextNodeIndex` and the existing artifacts from the run record).

**Input:**
```json
{ "run_id": "r_abc123" }
```

**Output:** `{ "runId": "r_abc123", "status": "queued" }`

Errors: `{ "error": "run not found: <id>" }`, `{ "error": "run is not resumable (status: <status>)" }` for runs whose status is `completed`, `running`, or `pending` (already queued to start). Valid resumable statuses are `errored` and `paused`.

Note: the valid `PipelineRunStatus` values are `pending`, `running`, `paused`, `errored`, `completed` — there is no `queued` status.

---

## Runner Selection

A helper `resolveStandaloneAgentRunner()` in `src/mcp/config.ts` determines the agent runner for non-`claude-code` nodes:

1. Call `resolveStandaloneLlmAgentConfig()` from `src/agent-runner-config.ts`. This function already handles the full priority chain: CLI flags → env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RIPLINE_AGENT_PROVIDER`, `RIPLINE_AGENT_MODEL`) → `~/.ripline/config.json`.
2. If config resolves successfully → construct and return `LlmAgentRunner`
3. If config is absent or incomplete → return stub runner and log to stderr:
   `[ripline-mcp] no LLM runner configured, using stub for agent nodes`

`runner: claude-code` nodes always use `ClaudeCodeRunner` regardless of the above (handled by the existing agent executor logic).

---

## Error Handling

| Scenario | Behaviour |
|----------|-----------|
| Unknown pipeline ID in `run_pipeline` | Return `{ "error": "pipeline not found: <id>" }` |
| Unknown run ID | Return `{ "error": "run not found: <id>" }` |
| `resume_run` on non-resumable run | Return `{ "error": "run is not resumable (status: <status>)" }` |
| Pipeline YAML invalid at load time | Log error to stderr at startup, exclude from `list_pipelines` |
| Agent node failure during run | Run status → `errored`; detail in logs; `resume_run` can retry |
| MCP server startup failure (bad config, missing dir) | Log to stderr, exit non-zero |
| `get_run_logs` — run exists but no log file yet | Return `{ "logs": "" }` |

---

## Testing

### Unit tests (`tests/unit/mcp/`)

- `config.test.ts` — CLI arg parsing, precedence over config file, defaults
- `tools.test.ts` — each tool handler with mock registry/scheduler/run-store:
  - `list_pipelines` returns loaded pipelines
  - `run_pipeline` calls scheduler, returns runId
  - `run_pipeline` with unknown ID returns error object
  - `get_run` returns run record with correct field names (`finishedAt`, numeric timestamps)
  - `get_run` with unknown ID returns error object
  - `get_run_logs` returns log content
  - `get_run_logs` returns `{ logs: "" }` when log file absent
  - `list_runs` filters by `pipeline_id` in-memory, applies `limit` after sort
  - `list_runs` filters by `status` via store
  - `resume_run` re-queues and returns updated status
  - `resume_run` returns error for completed/running runs

### Integration test (`tests/integration/mcp/`)

- Start MCP server with `pipelines/examples/hello-world.yaml`
- Call `list_pipelines` → verify hello_world present
- Call `run_pipeline` with `{ person: "World" }` → get runId
- Poll `get_run` until status is `completed`
- Verify output contains greeting

---

## New Dependency

Add `@modelcontextprotocol/sdk` to `package.json` as a production dependency.

---

## Out of Scope (Future Work)

- **Pipeline authoring skill** — a Claude Code skill that knows Ripline's YAML schema and can write/edit pipeline files
- **SSE transport** — for non-stdio MCP clients
- **`watch_run` streaming tool** — SSE-based run progress stream
- **Auth** — bearer token support for multi-user environments
- **Arbitrary re-entry in `resume_run`** — `from_node` parameter requires scheduler-level cursor manipulation not currently supported
