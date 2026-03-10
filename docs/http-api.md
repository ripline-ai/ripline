# Ripline HTTP API

The plugin exposes an HTTP surface so Mission Control, Discord, cron jobs, or any client can trigger and inspect pipeline runs.

## Base URL and port

- **Default port:** `4001`
- **Base path:** By default routes are at the root. When mounted by OpenClaw, the host uses `config.httpPath` (e.g. `/pipelines`) as the prefix.

## Authentication

If the plugin is configured with `authToken`, every request must include:

```http
Authorization: Bearer <your-auth-token>
```

If the token is missing or wrong, the server responds with `401 Unauthorized`.

## Endpoints

### List pipelines

```http
GET /pipelines
```

Returns all available pipeline definitions (id, name, tags).

**Example (no auth):**
```bash
curl http://localhost:4001/pipelines
```

**Example (with auth):**
```bash
curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:4001/pipelines
```

**Response:**
```json
{
  "pipelines": [
    {
      "id": "ripline-area-owner",
      "name": "Ripline Area Owner Loop",
      "tags": []
    }
  ]
}
```

### Trigger a run

```http
POST /pipelines/:id/run
Content-Type: application/json
```

Starts a new run for the given pipeline. Optional body: `inputs` (object) and `env` (key-value map).

**Example (no auth):**
```bash
curl -X POST http://localhost:4001/pipelines/ripline-area-owner/run \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Example (with inputs and env):**
```bash
curl -X POST http://localhost:4001/pipelines/ripline-area-owner/run \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{"inputs":{"area":"eng"},"env":{"ENV":"staging"}}'
```

**Response (202 Accepted):**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000"
}
```

### Get run record and status

```http
GET /runs/:runId
```

Returns the full run record and node-by-node status.

**Example:**
```bash
curl http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000
```

**Response (200):**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "pipelineId": "ripline-area-owner",
  "status": "completed",
  "startedAt": 1234567890000,
  "updatedAt": 1234567895000,
  "inputs": {},
  "outputs": { ... },
  "steps": [
    { "nodeId": "area-owner-intake", "status": "completed", "startedAt": ..., "finishedAt": ... },
    ...
  ]
}
```

### Stream run updates (SSE)

```http
GET /runs/:runId/stream
Accept: text/event-stream
```

Server-Sent Events stream: each event is a `data:` line with the current run record JSON. The server polls the run store and sends an event whenever the run is updated, until the run is `completed` or `errored`.

**Example:**
```bash
curl -N http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000/stream
```

### Retry a run from a node

```http
POST /runs/:runId/retry
Content-Type: application/json
```

Re-queues an `errored` or `paused` run for execution, optionally from a specific node. Completed steps before the target node are preserved and their artifacts replayed into context — only the target node and everything after it re-execute.

If `fromNode` is omitted, execution resumes from the first errored node. If the run has no errored steps, it retries from the beginning.

**Request body:**

| Field | Type | Description |
|-------|------|-------------|
| `fromNode` | string (optional) | Node ID to retry from. Must exist in the pipeline. Defaults to first errored node. |

**Example — retry from first error:**
```bash
curl -X POST http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000/retry \
  -H "Content-Type: application/json" \
  -d '{}'
```

**Example — retry from a specific node:**
```bash
curl -X POST http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000/retry \
  -H "Content-Type: application/json" \
  -d '{"fromNode": "queue"}'
```

**Response (202 Accepted):**
```json
{
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "fromNode": "queue"
}
```

**Error responses:**
- `404` — run or pipeline not found
- `409` — run is not in `errored` or `paused` state
- `400` — `fromNode` does not exist in the pipeline

### Get run logs

```http
GET /runs/:runId/logs
```

Returns the log output for a run. Logs are written to `<runsDir>/<runId>/log.txt` during execution (Claude Code runner messages, node progress, etc.). By default the response is plain text. Use `?format=json` to get `{ "lines": string[] }`.

**Example (plain text):**
```bash
curl http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000/logs
```

**Example (JSON lines):**
```bash
curl "http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000/logs?format=json"
```

**Responses:**
- `200` — Log content (plain or JSON)
- `404` — Run not found or no logs yet for this run

### Stream run logs (SSE)

```http
GET /runs/:runId/logs/stream
Accept: text/event-stream
```

Server-Sent Events stream of new log lines. The server polls the run log file and sends new content as it is written, until the run is `completed` or `errored`. Each event is `data: {"lines":"<new chunk>"}\n\n`.

**Example:**
```bash
curl -N http://localhost:4001/runs/550e8400-e29b-41d4-a716-446655440000/logs/stream
```

## Plugin config

In `openclaw.plugin.json` (or the host config), you can set:

| Key         | Description |
|------------|-------------|
| `pipelinesDir` | Directory containing pipeline YAML/JSON (required). |
| `runsDir` | Directory for run artifacts (run state, one subdir per run). Relative paths resolve from the workspace. Default: `.ripline/runs`. Use this to point runs at persistent or faster storage. |
| `httpPath` | Base path for the API when mounted by the host (default: `/pipelines`). |
| `httpPort` | Port for the HTTP server when started by the plugin (default: `4001`). |
| `authToken` | Optional bearer token; if set, all requests must send `Authorization: Bearer <token>`. |

**Run artifacts and cleanup:** All run-store traffic (create, load, save, list) uses `runsDir`. Each run directory contains `run.json` (state) and optionally `log.txt` (run-scoped logs). Runs are not auto-deleted; for long-lived or high-volume use, run a cleanup/rotation job (e.g. prune by run age or status using the run JSON files).

To start the server programmatically, use the plugin’s `createApp(config)` or `startServer(config)` (see package exports).
