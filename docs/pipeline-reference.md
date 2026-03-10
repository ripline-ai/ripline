# Pipeline Reference

This document is the complete reference for Ripline's pipeline YAML/JSON format. It covers all node types, fields, edges, contracts, and template syntax.

---

## Pipeline definition

A pipeline is a directed acyclic graph (DAG) declared in a YAML or JSON file. Each pipeline has metadata, a list of nodes, and a list of edges that connect them.

```yaml
id: my_pipeline          # required — unique identifier (filename stem by convention)
version: 1               # optional — semver or integer for tracking schema changes
name: My Pipeline        # optional — human-readable name shown in listings
description: |           # optional — longer description
  Describe what this pipeline does.
entry:                   # required — one or more node IDs where execution starts
  - intake
tags:                    # optional — arbitrary labels for filtering
  - daily
  - agent
metadata: {}             # optional — arbitrary key/value bag (not used by the engine)

nodes:                   # required — list of nodes (at least one)
  - ...

edges:                   # required — list of directed edges connecting nodes
  - ...

contracts:               # optional — top-level input/output JSON Schema contracts
  input:
    type: object
    properties:
      task: { type: string }
    required: [task]
  output:
    type: object
```

### Top-level fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique pipeline identifier. Must be non-empty. Used to trigger runs by ID. |
| `version` | string \| number | — | Optional version tag; not enforced by the engine. |
| `name` | string | — | Human-readable display name. |
| `description` | string | — | Longer description. |
| `entry` | string[] | ✅ | One or more node IDs that start execution. Each must exist in `nodes`. |
| `nodes` | Node[] | ✅ | At least one node. Node IDs must be unique within the pipeline. |
| `edges` | Edge[] | ✅ | At least one edge. Both `from.node` and `to.node` must refer to existing node IDs. |
| `contracts` | object | — | Top-level input/output JSON Schema (applied to run inputs and final outputs). |
| `tags` | string[] | — | Labels used for filtering in the registry. |
| `metadata` | object | — | Arbitrary key-value pairs; ignored by the engine. |

---

## Edges

Edges declare the data-flow direction between nodes. All edges are explicit — Ripline has no implicit fall-through.

```yaml
edges:
  - from: { node: intake }          # required — source node ID
    to:   { node: enrich }          # required — target node ID
    id: e1                           # optional — label for the edge
    when: "inputs.debug === true"    # optional — conditional expression (JS); edge is skipped when falsy
```

### Edge fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from.node` | string | ✅ | Source node ID. |
| `from.port` | string | — | Reserved for future multi-port support. |
| `to.node` | string | ✅ | Target node ID. |
| `to.port` | string | — | Reserved for future multi-port support. |
| `id` | string | — | Optional edge label. |
| `when` | string | — | JS expression evaluated with the run context. The edge is followed only when the expression is truthy. |

---

## Common node fields

Every node type shares these base fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✅ | Unique node identifier within the pipeline (non-empty). Used in edges and template variables. |
| `name` | string | — | Optional human-readable label shown in verbose output. |
| `description` | string | — | Optional description of what this node does. |
| `contracts` | object | — | Per-node input/output JSON Schema; validated at runtime. |
| `retry` | object | — | Retry config: `{ maxAttempts: number, delayMs?: number }`. |
| `metadata` | object | — | Arbitrary key-value pairs; ignored by the engine. |

### Node contracts

```yaml
nodes:
  - id: do-work
    type: agent
    contracts:
      input:                      # JSON Schema validated against inputs fed to this node
        type: object
        properties:
          task: { type: string }
        required: [task]
      output:                     # JSON Schema validated against this node's output artifact
        type: object
        properties:
          text: { type: string }
```

### Retry

```yaml
nodes:
  - id: flaky-step
    type: agent
    retry:
      maxAttempts: 3     # max total attempts (including the first)
      delayMs: 1000      # optional delay between attempts in milliseconds
    prompt: "..."
```

---

## Node types

### `input`

Loads the run's initial inputs into the execution context. Every pipeline should have at least one `input` node as an entry point.

```yaml
- id: intake
  type: input
  path: task          # optional — dot-path selector to extract a sub-key
  description: "Provide `task` and optional `context` fields"
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `path` | string | — | Dot-path selector. If set, only `inputs.path` is loaded into the artifact (e.g. `path: "task"` extracts `inputs.task`). |

**Output:** The run's input object (or the selected sub-value when `path` is set) becomes this node's artifact.

---

### `transform`

Evaluates a JavaScript expression in a sandboxed VM with a 5-second timeout. Use this for data shaping, enrichment, or filtering between nodes.

```yaml
- id: enrich
  type: transform
  expression: "({ greeting: `Hello, ${inputs.person}!`, goal: inputs.goal ?? 'explore Ripline' })"
  assigns: greeting_data    # optional — artifact key name (defaults to node id)
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `expression` | string | ✅ | A JS expression (must be evaluatable; wrap multi-line logic in an IIFE). |
| `assigns` | string | — | Artifact key to store the result under (default: the node's `id`). |

#### Sandbox context

The expression runs with `with (context) { return (expression); }`, so the following variables are available directly:

| Variable | Description |
|----------|-------------|
| `inputs` | The run's initial inputs object. |
| `artifacts` | All artifacts produced so far, keyed by node ID. |
| `env` | Environment key-value pairs passed at run start. |
| `[nodeId]` | Shorthand: each prior node's artifact is available by node ID. |

**Security:** `require`, `process`, and `global` are not available in the sandbox. Expressions that exceed 5 seconds are aborted.

---

### `agent`

Calls an agent runner (OpenClaw, LLM, or Claude Code) with a prompt and returns a text artifact. This is the primary node type for AI-powered work.

```yaml
- id: summarize
  type: agent
  agentId: main                   # optional — agent persona (OpenClaw only)
  prompt: |
    Summarize the following content:
    {{ enrich.text }}
  thinking: medium                # optional — thinking level
  timeoutSeconds: 120             # optional — per-node timeout
  resetSession: true              # optional — isolate session context (default: true)
  runner: claude-code             # optional — use Claude Code runner for this node
  mode: plan                      # optional — plan | execute (Claude Code only)
  cwd: "{{ run.inputs.repoPath }}" # optional — working directory (Claude Code only)
  dangerouslySkipPermissions: false # optional — bypass permissions (Claude Code only)
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | ✅ | The prompt sent to the agent. Supports `{{ }}` template interpolation. |
| `agentId` | string | — | Agent ID passed to the OpenClaw runner (e.g. `vector`, `nova`). Ignored by LLM and Claude Code runners. |
| `thinking` | string | — | Thinking level: `off`, `minimal`, `low`, `medium`, `high`. Passed to OpenClaw runner only. |
| `timeoutSeconds` | number | — | Per-node deadline in seconds. The node is marked `errored` if exceeded. |
| `resetSession` | boolean | — | When `true` (default), use a fresh session UUID per node for context isolation. When `false`, share the run-level session ID for multi-turn continuity. |
| `sessionId` | string | — | Reserved for future explicit session override. |
| `channel` | string | — | Reserved for future delivery channel configuration. |
| `deliver` | boolean | — | Reserved for future delivery configuration. |
| `runner` | `"claude-code"` | — | Route this node to the Claude Code runner. If `claudeCodeRunner` is not configured, the run fails with a clear error. |
| `mode` | `"plan"` \| `"execute"` | — | Claude Code runner only. `"plan"` = read-only (PreToolUse hook denies writes). `"execute"` = full access (default). |
| `cwd` | string | — | Claude Code runner only. Working directory; supports `{{ }}` interpolation. Must resolve to an existing directory. Must not contain `..`. |
| `dangerouslySkipPermissions` | boolean | — | Claude Code runner only. When `true` and global bypass is enabled, the node runs with `--dangerously-skip-permissions`. Omit or `false` = use `dontAsk` mode. See [Agent integration](agent-integration.md#bypass-permissions-mode-advanced). |

**Output:** `{ text: string, tokenUsage?: { input: number, output: number } }` stored as the node's artifact.

See [Agent integration](agent-integration.md) for full runner selection rules and configuration.

---

### `output`

Writes an artifact to the run's final outputs. Output nodes are typically the last nodes in a pipeline.

```yaml
- id: finalize
  type: output
  source: enrich        # optional — artifact key to write (default: this node's id)
  path: hello.result    # optional — output key in run.outputs (default: source or node id)
  merge: false          # optional — merge artifact into existing outputs instead of replacing
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `source` | string | — | ID of the node whose artifact to write. Defaults to this node's own ID. |
| `path` | string | — | Key under `run.outputs` where the artifact is stored. Defaults to `source` (or node `id`). |
| `merge` | boolean | — | When `true`, deep-merge the artifact into `run.outputs` instead of replacing. |

---

### `data`

Injects a static literal value as an artifact. Useful for providing constants or default values.

```yaml
- id: defaults
  type: data
  value:
    version: "1.0"
    environment: production
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `value` | any | ✅ | The literal value to inject as this node's artifact. |

---

### `loop`

Iterates over a collection, running a sub-pipeline (inline or by reference) for each item or for a fixed number of iterations.

```yaml
- id: process-items
  type: loop
  collection: "artifacts.breakdown.tasks"  # JS expression resolving to an array
  itemVar: item                             # optional — variable name for the current item (default: "item")
  indexVar: idx                             # optional — variable name for the current index (default: "index")
  maxIterations: 10                         # optional — safety ceiling
  exitCondition: "item.done === true"       # optional — JS expression; stop when truthy
  body:
    pipelineId: handle_task                 # use a separate pipeline by ID
    # — OR — inline body:
    entry: [step1]
    nodes:
      - id: step1
        type: agent
        prompt: "Process item: {{ item.title }}"
    edges:
      - from: { node: step1 }
        to:   { node: step1 }
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `collection` | string | ✅ | JS expression that resolves to an array. Evaluated against the run context. |
| `itemVar` | string | — | Name for the loop variable holding the current element (default: `"item"`). |
| `indexVar` | string | — | Name for the loop variable holding the current index (default: `"index"`). |
| `maxIterations` | number | — | Safety ceiling on iterations. |
| `exitCondition` | string | — | JS expression evaluated each iteration; the loop stops when truthy. |
| `body.pipelineId` | string | — | ID of a pipeline to run as the loop body (mutually exclusive with inline `body.nodes`). |
| `body.entry` | string[] | — | Entry node IDs for the inline body. |
| `body.nodes` | Node[] | — | Inline node definitions for the loop body. |
| `body.edges` | Edge[] | — | Inline edges for the loop body. |

Either `body.pipelineId` or `body.nodes` must be set.

---

### `run_pipeline`

Invokes another registered pipeline as a child or inline sub-flow.

```yaml
- id: delegate
  type: run_pipeline
  pipelineId: handle_task     # required — ID of pipeline to invoke
  inputMapping:               # optional — map parent context keys to child input keys
    task: "artifacts.breakdown.tasks[0]"
  mode: child                 # optional — "child" (separate run, async) or "inline" (same run context)
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipelineId` | string | ✅ | ID of the pipeline to invoke. Must be registered in the pipeline directory. |
| `inputMapping` | object | — | Map of `{ childInputKey: jsExpression }` used to build the child run's inputs from the current context. |
| `mode` | `"child"` \| `"inline"` | — | `"child"` creates a new run record tracked via `childRunIds`. `"inline"` runs the sub-pipeline in the current run's context (no separate run record). |

---

### `enqueue`

Queues one or more child pipeline runs for asynchronous processing. Used for fan-out patterns where a breakdown node produces a list of tasks.

```yaml
- id: dispatch
  type: enqueue
  pipelineId: handle_task     # required — child pipeline to run for each task
  tasksSource: tasks          # optional — artifact key containing the tasks array (default: "tasks")
  mode: per-item              # optional — "per-item" (one run per task) or "batch" (one run with full list)
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipelineId` | string | ✅ | ID of the child pipeline to enqueue for each task. |
| `tasksSource` | string | — | Artifact key containing the tasks array (default: `"tasks"`). The artifact must be an array. |
| `mode` | `"batch"` \| `"per-item"` | — | `"per-item"` (default): one child run per task item; each child receives `inputs.task = item`. `"batch"`: one child run with `inputs.tasks = [ ...all items ]`. |

**Task item convention:** Each task item is expected to be an object with at least `id` and `title`. The full shape:

```typescript
{
  id: string;
  title: string;
  detail?: string;
  priority?: number | string;
}
```

---

### `checkpoint`

Pauses the run for manual inspection or external approval. The run status becomes `paused`; execution resumes via `ripline run --resume <runId>` or the HTTP retry endpoint.

```yaml
- id: await-approval
  type: checkpoint
  reason: "Waiting for manager sign-off"   # optional — shown in run record
  resumeKey: manager_approval              # optional — label for external systems
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reason` | string | — | Human-readable reason for the pause, stored in the run record's `waitFor.reason`. |
| `resumeKey` | string | — | Arbitrary key stored in `waitFor.resumeKey`; use this to correlate with external approval flows. |

To resume: `ripline run --resume <runId>` or `POST /runs/<runId>/retry`.

---

## Template syntax

Ripline uses `{{ expression }}` templates in `prompt` strings, `cwd` values, and edge `when` conditions.

### Interpolation

```
{{ expr }}
```

- The expression is evaluated with the run context using `with (context) { return (expr); }`.
- `undefined` and `null` values produce an empty string.
- Object values are serialized with `JSON.stringify`.
- Errors produce `[[error:message]]`.

### Available context variables

| Variable | Description |
|----------|-------------|
| `inputs` | The run's initial inputs object. |
| `inputs.fieldName` | A specific input field. |
| `artifacts` | All artifacts produced so far, keyed by node ID. |
| `artifacts.nodeId` | Artifact from a specific prior node. |
| `env` | Environment key-value pairs passed at run start. |
| `run` | The run record object (`run.id`, `run.inputs`, `run.pipelineId`, etc.). |
| `nodeId` | Shorthand: each prior node's artifact is also accessible directly by its ID. |
| `nodeId.text` | Shorthand for the `text` field of a prior agent node's artifact. |

### Examples

```
{{ inputs.task }}                         # input field
{{ task }}                                # shorthand for inputs.task (works inside "with" context)
{{ break-down.text }}                     # text from a prior agent node named "break-down"
{{ JSON.stringify(headlines, null, 2) }}  # serialize an array to JSON
{{ run.inputs.repoPath }}                 # explicit access via run object
{{ new Date().toISOString().slice(0,10)}} # JS expression
```

### JSON pointer syntax

Expressions starting with `$` are treated as dot-path pointers:

```
{{ $.inputs.task }}         # same as inputs.task
{{ $.artifacts.step1.text}} # same as artifacts.step1.text
```

---

## Contracts (JSON Schema)

Contracts are JSON Schema (Draft-07) objects that validate node inputs and outputs at runtime. A validation failure marks the node `errored`.

### Per-node contracts

```yaml
- id: do-work
  type: agent
  contracts:
    input:
      type: object
      properties:
        task: { type: string }
      required: [task]
    output:
      type: object
      properties:
        text: { type: string }
      required: [text]
  prompt: "{{ task }}"
```

### Top-level pipeline contracts

```yaml
contracts:
  input:
    type: object
    properties:
      task: { type: string }
    required: [task]
  output:
    type: object
    properties:
      result: { type: object }
```

---

## Run output format

Completed runs are stored in `.ripline/runs/<runId>/run.json`:

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "pipelineId": "my_pipeline",
  "status": "completed",
  "startedAt": 1700000000000,
  "updatedAt": 1700000005000,
  "inputs": { "task": "build login" },
  "outputs": {
    "result": { "text": "Done.", "tokenUsage": { "input": 100, "output": 50 } }
  },
  "steps": [
    {
      "nodeId": "intake",
      "status": "completed",
      "startedAt": 1700000000100,
      "finishedAt": 1700000000200
    },
    {
      "nodeId": "do-work",
      "status": "completed",
      "startedAt": 1700000000300,
      "finishedAt": 1700000005000
    }
  ],
  "childRunIds": []
}
```

### Status values

| Status | Description |
|--------|-------------|
| `pending` | Enqueued, waiting for a worker. |
| `running` | Currently executing. |
| `paused` | Stopped at a `checkpoint` node; awaiting resume. |
| `errored` | A node failed; the run stopped. Use `--resume` or the retry endpoint to continue. |
| `completed` | All nodes finished successfully. |

---

## Full example: multi-agent spec pipeline

```yaml
id: spec_and_build
name: Spec then build
version: 1
description: Produce a design spec and then implement it.
entry: [intake]

nodes:
  - id: intake
    type: input
    description: "Provide `task` (string)"

  - id: validate
    type: transform
    expression: "({ task: inputs.task?.trim() })"

  - id: spec
    type: agent
    agentId: nova
    prompt: "Write a concise design spec for: {{ validate.task }}"
    timeoutSeconds: 90
    retry:
      maxAttempts: 2
      delayMs: 2000

  - id: implement
    type: agent
    agentId: vector
    runner: claude-code
    mode: execute
    cwd: "{{ run.inputs.repoPath }}"
    prompt: |
      Implement the following spec in the project at {{ run.inputs.repoPath }}.

      Spec:
      {{ spec.text }}
    timeoutSeconds: 180

  - id: approval
    type: checkpoint
    reason: "Review implementation before publishing"

  - id: result
    type: output
    source: implement
    path: implementation.result

edges:
  - from: { node: intake }
    to:   { node: validate }
  - from: { node: validate }
    to:   { node: spec }
  - from: { node: spec }
    to:   { node: implement }
  - from: { node: implement }
    to:   { node: approval }
  - from: { node: approval }
    to:   { node: result }

contracts:
  input:
    type: object
    properties:
      task: { type: string }
      repoPath: { type: string }
    required: [task, repoPath]
```
