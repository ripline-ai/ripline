# Ripline

Ripline is the pipeline engine for delegating work to agents. Use it when:

- You want to run a task in the background and track progress
- You're delegating implementation work to Vector or Nova
- You need artifacts from an agent run (code, analysis, output)
- You want a run to be resumable if something fails
- You're orchestrating multiple agents in sequence

## When to use Ripline

| Intent | Use Ripline? |
|---|---|
| "Delegate the Wintermute build to Vector" | Yes — background implementation work |
| "Ask Vector what he thinks of this design" | No — use `sessions_send` (blocking Q&A) |
| "Have Nova spec out the onboarding flow" | Yes — multi-step design task |
| "What time is it?" | No — direct answer, no delegation needed |
| "Build this feature and report back" | Yes — tracked work with artifacts |
| "Quick question for Vector" | No — `sessions_send` with 60s timeout |

## Starting a pipeline run

```
POST http://localhost:4001/pipelines/<pipelineId>/runs
Content-Type: application/json

{ "task": "your task description here" }
```

Returns immediately:
```json
{ "runId": "abc-123", "status": "pending" }
```

## Polling for completion

```
GET http://localhost:4001/runs/<runId>
```

```json
{
  "runId": "abc-123",
  "status": "completed",
  "artifacts": {
    "vector-run": {
      "text": "Here's what Vector produced...",
      "tokenUsage": { "input": 1200, "output": 800 }
    }
  }
}
```

Status values: `pending` → `running` → `completed` | `failed` | `errored`

Poll every 2–5 seconds. Break when status is `completed`, `failed`, or `errored`.

## Available pipelines

Check what's installed first:
```
GET http://localhost:4001/pipelines
```

Pipelines also live as YAML in `/home/openclaw/.openclaw/workspace/pipelines/`.

### delegate_to_vector
Delegates a task to Vector and returns his output as an artifact.

```json
POST /pipelines/delegate_to_vector/runs
{ "task": "Build the Wintermute Kanban MVP. Initialize Next.js with App Router and Tailwind, bind to 0.0.0.0:3000, implement /kanban with on-disk task persistence, REST API at /api/tasks, and keep it running in the background." }
```

## Creating a new pipeline

Drop a YAML file in `/home/openclaw/.openclaw/workspace/pipelines/`. Ripline hot-reloads.

Minimal single-agent pipeline:
```yaml
id: my_pipeline
name: My Pipeline
entry: [intake]
nodes:
  - id: intake
    type: input
  - id: do-work
    type: agent
    agentId: vector          # or: nova
    prompt: "{{task}}"       # {{variable}} pulls from inputs or prior node artifacts
  - id: result
    type: output
    source: do-work
edges:
  - { from: { node: intake },   to: { node: do-work } }
  - { from: { node: do-work },  to: { node: result } }
```

Multi-agent sequential pipeline:
```yaml
id: spec_then_build
nodes:
  - id: intake
    type: input
  - id: spec
    type: agent
    agentId: nova
    prompt: "Write a design spec for: {{task}}"
  - id: build
    type: agent
    agentId: vector
    prompt: "Implement this spec:\n\n{{spec.text}}"
  - id: result
    type: output
    source: build
edges:
  - { from: { node: intake }, to: { node: spec } }
  - { from: { node: spec },   to: { node: build } }
  - { from: { node: build },  to: { node: result } }
```

## Template variables in prompts

- `{{fieldName}}` — input fields passed at run time
- `{{nodeId.text}}` — text output from a prior agent node
- `{{inputs.fieldName}}` — same as `{{fieldName}}`, explicit form

## Key behaviors

- **Non-blocking**: POST returns a runId immediately; agent work happens async
- **Tracked**: every run persists to `.ripline/runs/<runId>/run.json`
- **Resumable**: `ripline run --resume <runId>` restarts from the failed node
- **Session-isolated**: each agent node gets a fresh session UUID by default — no history bleed between runs
- **Hot-reload**: edit pipeline YAML and the next run picks it up automatically

## Don't use Ripline for

- Quick blocking questions (use `sessions_send`)
- Tasks where you need a reply in the same turn
- Single tool calls that need no tracking
