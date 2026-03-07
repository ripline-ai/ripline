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

## Plugin config

In `openclaw.plugin.json` (or the host config), you can set:

| Key         | Description |
|------------|-------------|
| `pipelinesDir` | Directory containing pipeline YAML/JSON (required). |
| `runsDir` | Directory for run artifacts (run state, one subdir per run). Relative paths resolve from the workspace. Default: `.ripline/runs`. Use this to point runs at persistent or faster storage. |
| `httpPath` | Base path for the API when mounted by the host (default: `/pipelines`). |
| `httpPort` | Port for the HTTP server when started by the plugin (default: `4001`). |
| `authToken` | Optional bearer token; if set, all requests must send `Authorization: Bearer <token>`. |

**Run artifacts and cleanup:** All run-store traffic (create, load, save, list) uses `runsDir`. Runs are not auto-deleted; for long-lived or high-volume use, run a cleanup/rotation job (e.g. prune by run age or status using the run JSON files).

To start the server programmatically, use the plugin’s `createApp(config)` or `startServer(config)` (see package exports).
