# Ripline HTTP API

Ripline exposes an HTTP surface so dashboards, Discord bots, cron jobs, or any HTTP client can trigger and inspect pipeline runs.

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

## Background Queue

Endpoints for managing the background work queue and auto-execution toggle. Items are priority-scored and executed sequentially by the AutoExecutor.

### List queue items

```http
GET /queue
```

Returns all queue items with their computed priority scores, sorted descending.

**Response (200):**
```json
{
  "items": [
    {
      "id": "uuid",
      "pipeline": "my_pipeline",
      "inputs": { "task": "..." },
      "priority": 2.5,
      "severityWeight": 1,
      "manualBoost": 0,
      "createdAt": 1711584000000,
      "status": "pending",
      "retries": 0,
      "maxRetries": 3,
      "needsReview": false,
      "computedPriority": 3.7
    }
  ]
}
```

### List approved (pending) items

```http
GET /queue/approved
```

Returns only items with status `pending`, sorted by computed priority descending.

### Add a queue item

```http
POST /queue
Content-Type: application/json
```

**Request body:**

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pipeline` | string | **yes** | — | Pipeline ID to execute |
| `inputs` | object | no | `{}` | Pipeline inputs |
| `severityWeight` | number | no | `1` | Base priority weight |
| `manualBoost` | number | no | `0` | Manual priority adjustment |
| `maxRetries` | number | no | config default (3) | Circuit-breaker retry limit |

**Example:**
```bash
curl -X POST http://localhost:4001/queue \
  -H "Content-Type: application/json" \
  -d '{"pipeline": "implement_story", "inputs": {"task": "add OAuth"}, "severityWeight": 2}'
```

**Response (201):** The created queue item.

### Update a queue item

```http
PATCH /queue/:id
Content-Type: application/json
```

**Updatable fields:** `priority` (number), `manualBoost` (number), `severityWeight` (number), `status` (one of: `pending`, `running`, `completed`, `errored`, `failed`).

**Response (200):** The updated queue item. **404** if not found.

### Delete a queue item

```http
DELETE /queue/:id
```

**Response:** `204 No Content`. **404** if not found.

### Toggle auto-execution

```http
PUT /config/background-queue
Content-Type: application/json
```

Enables or disables the AutoExecutor at runtime. The change is persisted to `~/.ripline/config.json` so it survives restarts.

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | **yes** | `true` to enable auto-dispatch, `false` to stop |

**Example — enable:**
```bash
curl -X PUT http://localhost:4001/config/background-queue \
  -H "Content-Type: application/json" \
  -d '{"enabled": true}'
```

**Response (200):**
```json
{
  "backgroundQueue": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

**Behavior:** When enabled, the AutoExecutor immediately checks the queue and dispatches the highest-priority pending item. When disabled, the current run finishes but no new items are dispatched. Re-enabling resumes dispatch.

### Read current config

```http
GET /config/background-queue
```

Returns the current background queue config state.

**Response (200):**
```json
{
  "enabled": true
}
```

---

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
