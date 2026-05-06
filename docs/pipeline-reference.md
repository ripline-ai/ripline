# Pipeline Reference

This document is the complete reference for Ripline's pipeline YAML/JSON format. It covers all node types, review phase kinds, fields, edges, contracts, and template syntax.

---

## Review pipeline phases

Ripline has three built-in phase kinds for multi-agent review workflows: `plan`, `review`, and `review_only`. These are declared in a `phases` array (instead of or alongside the `nodes` array) using a `ReviewPipelineDefinition`.

Review pipelines support sequential chaining by default — each phase flows to the next — or explicit wiring via `inputs.include`. Edges between phases are derived automatically from the phase order; explicit `edges` are not required.

For a complete guide including the programmatic API and worked examples, see [Review Pipelines](review-pipelines.md).

---

### `plan` phase

A `plan` phase runs a single doer agent and produces output. There is no reviewer gate: the doer's output passes directly to the next phase. If an optional `reviewer` is specified with `require: 0`, it still behaves as doer-only.

```yaml
phases:
  - id: draft_spec
    kind: plan
    title: Draft the spec
    description: |
      You are a senior engineer. Write a technical spec for:
      {{ inputs.task }}
    doer:
      lineage: anthropic
      models:
        - claude-opus-4-5
    iterate:
      maxRounds: 1
      onDisagreement: stop
    inputs:
      include: []    # optional — list prior phase ids to receive as context
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | Yes | Unique phase identifier within the pipeline. |
| `kind` | `"plan"` | Yes | Discriminant for this phase type. |
| `title` | string | No | Short label shown in logs and run records. |
| `description` | string | No | The prompt text sent to the doer (supports `{{ }}` template interpolation). |
| `doer` | `DoerConfig` | Yes | Specifies which AI CLI runs the task. See below. |
| `reviewer` | `ReviewerConfig` | No | If omitted (or `require: 0`), the phase has no review gate. |
| `iterate` | `PhaseIterateConfig` | Yes | Controls the retry loop. |
| `inputs` | `PhaseInputsConfig` | No | Controls which prior phase outputs are included as context. |

**`DoerConfig`:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lineage` | `AgentLineage` | Yes | Which AI CLI family to use: `anthropic`, `openai`, `google`, `moonshot`, `opencode`, or `any`. |
| `models` | string[] | No | Preferred model names for this lineage, in priority order. The registry uses the first available. |

**`PhaseIterateConfig`:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `maxRounds` | number (int ≥ 1) | Yes | Maximum number of doer/reviewer rounds before returning `request_changes`. |
| `onDisagreement` | `"continue"` \| `"stop"` | Yes | When quorum is not met: `"continue"` feeds reviewer feedback back to the doer and retries; `"stop"` returns `request_changes` immediately. |
| `shareSessionAcrossRounds` | boolean | No | When `true`, the doer reuses the same session across retry rounds. |
| `shareSessionAcrossPhases` | boolean | No | When `true`, the doer reuses the same session across different phases. |

**`PhaseInputsConfig`:**

| Field | Type | Description |
|-------|------|-------------|
| `include` | string[] | List of prior phase IDs whose outputs are injected as context. When present and non-empty, suppresses the automatic sequential edge from the previous phase. |
| `exclude` | string[] | Prior phase IDs to exclude from the automatic context injection. |

---

### `review` phase

A `review` phase runs a doer agent, then fans out to N reviewer agents in parallel. If quorum is not met, the doer can be retried with reviewer feedback injected into its next-round prompt.

```yaml
phases:
  - id: review_spec
    kind: review
    title: Peer review the spec
    description: |
      Review the architecture spec. Focus on completeness, correctness,
      and risk coverage. State APPROVE or REQUEST CHANGES.
    doer:
      lineage: anthropic
    reviewer:
      require: 2
      crossLineage: true
      candidates:
        - lineage: google
        - lineage: openai
        - lineage: moonshot
    iterate:
      maxRounds: 3
      onDisagreement: continue
    inputs:
      include: [draft_spec]
```

#### Additional fields (beyond `plan`)

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `reviewer` | `ReviewerConfig` | Yes | Specifies how many reviewers must approve and who the candidates are. |

**`ReviewerConfig`:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `require` | number (int ≥ 0) | Yes | Minimum number of reviewer approvals needed for quorum. |
| `crossLineage` | boolean | No | When `true`, approvals must come from at least 2 distinct lineages. This prevents a single AI family from approving its own work. |
| `candidates` | `VoiceSpec[]` | Yes | The reviewer slots. Each slot is a `{ lineage, models? }` pair resolved via the voice registry. Reviewers run in parallel. |

**`VoiceSpec`:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `lineage` | `AgentLineage` | Yes | Which AI CLI family to use for this reviewer slot. |
| `models` | string[] | No | Preferred model names for this slot. |

**Quorum evaluation:**

The executor collects verdicts from all reviewer candidates by parsing the reviewer's free-form text for approval keywords (`approve`, `lgtm`, `looks good`, `ship it`) and rejection keywords (`request changes`, `disagree`, `reject`, `blocker`). If the text is ambiguous, it is treated as non-approval. When `crossLineage` is `true`, the set of approving lineages must span at least 2 distinct values.

**Retry loop:**

When quorum is not met and `iterate.onDisagreement` is `"continue"` and `round < maxRounds`, the executor builds a feedback block from all non-approving reviewers and prepends it to the doer's prompt for the next round. When `onDisagreement` is `"stop"`, or when all rounds are exhausted, the phase returns `verdict: "request_changes"`.

---

### `review_only` phase

A `review_only` phase has no doer. It takes an existing artifact (from a prior phase or an external source) and fans it out to reviewers. Use this to review diffs, documents, or any pre-existing artifact without running a generation step first.

```yaml
phases:
  - id: audit_pr_diff
    kind: review_only
    title: Review the PR diff
    description: |
      Review this diff for correctness and adherence to our coding standards.
    reviewer:
      require: 1
      candidates:
        - lineage: anthropic
        - lineage: google
    artifact:
      source: fetch_diff   # ID of the phase or artifact key whose output is being reviewed
      label: PR diff
    iterate:
      maxRounds: 1
      onDisagreement: stop
```

#### Additional fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `artifact` | object | No | Identifies the upstream output being reviewed. |
| `artifact.source` | string | Yes (if `artifact` present) | Phase ID or artifact key containing the content to review. |
| `artifact.label` | string | No | Human-readable label for the artifact (shown in reviewer prompts). |

---

### Full worked example: architecture review pipeline

```yaml
id: arch_review
name: Architecture review
version: 1
description: Draft an architecture, review it with two external reviewers, then ship if approved.
entry: [plan_arch]

ship:
  enabled: true
  branchPattern: ripline/arch-review-{chatId}
  titleTemplate: "Architecture review: {chatId}"

phases:
  - id: plan_arch
    kind: plan
    title: Draft architecture
    description: |
      You are a senior software architect. The request is:

      {{ inputs.request }}

      Write a concise architecture document: components, data flow, technology choices, risks.
    doer:
      lineage: anthropic
      models:
        - claude-opus-4-5
    iterate:
      maxRounds: 1
      onDisagreement: stop

  - id: review_arch
    kind: review
    title: Architecture review
    description: |
      Review the architecture document below for soundness, scalability, and risk coverage.
      State APPROVE (with a brief summary) or REQUEST CHANGES (with specific issues).
    doer:
      lineage: anthropic
    reviewer:
      require: 2
      crossLineage: true
      candidates:
        - lineage: google
        - lineage: openai
    iterate:
      maxRounds: 3
      onDisagreement: continue
    inputs:
      include: [plan_arch]

contracts:
  input:
    type: object
    properties:
      request: { type: string }
    required: [request]
```

**How it executes:**

1. `plan_arch` runs the `anthropic` doer. Because `iterate.maxRounds` is 1 and there is no reviewer, the doer's output passes through immediately.
2. `review_arch` receives the `plan_arch` output as context (via `inputs.include`). The `anthropic` doer runs first. Then `google` and `openai` reviewers run in parallel.
3. If both reviewers approve (`require: 2`, `crossLineage: true` ensures different lineages), the phase returns `approved`.
4. If either reviewer requests changes and `maxRounds` allows, the doer receives the feedback and retries.
5. After up to 3 rounds, the pipeline completes with a `verdict` and the doer's final output.

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

Calls an agent runner (LLM, Claude Code, Codex, or OpenClaw) with a prompt and returns a text artifact. This is the primary node type for agent-driven work.

```yaml
- id: summarize
  type: agent
  agentId: main                   # optional — agent identifier for OpenClaw integrations
  prompt: |
    Summarize the following content:
    {{ enrich.text }}
  thinking: medium                # optional — thinking level
  timeoutSeconds: 120             # optional — per-node timeout
  resetSession: true              # optional — isolate session context (default: true)
  runner: codex                   # optional — use a built-in code runner for this node
  mode: plan                      # optional — plan | execute (Claude Code or Codex)
  cwd: "{{ run.inputs.repoPath }}" # optional — working directory (Claude Code or Codex)
  dangerouslySkipPermissions: false # optional — bypass permissions (built-in code runners)
```

#### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | ✅ | The prompt sent to the agent. Supports `{{ }}` template interpolation. |
| `agentId` | string | — | Agent ID passed to the OpenClaw runner when that integration is active. Ignored by LLM, Claude Code, and Codex runners. |
| `thinking` | string | — | Thinking level: `off`, `minimal`, `low`, `medium`, `high`. Used by integrations that support it. |
| `timeoutSeconds` | number | — | Per-node deadline in seconds. The node is marked `errored` if exceeded. |
| `resetSession` | boolean | — | When `true` (default), use a fresh session UUID per node for context isolation. When `false`, share the run-level session ID for multi-turn continuity. |
| `sessionId` | string | — | Reserved for future explicit session override. |
| `channel` | string | — | Reserved for future delivery channel configuration. |
| `deliver` | boolean | — | Reserved for future delivery configuration. |
| `runner` | `"claude-code"` \| `"codex"` | — | Route this node to a built-in code runner. If that runner is not configured, the run fails with a clear error. |
| `mode` | `"plan"` \| `"execute"` | — | Built-in code runners only. `"plan"` = read-only. `"execute"` = write-capable/default. Exact behavior depends on the runner. |
| `cwd` | string | — | Built-in code runners only. Working directory; supports `{{ }}` interpolation. Must resolve to an existing directory. Must not contain `..`. |
| `dangerouslySkipPermissions` | boolean | — | Built-in code runners only. Enables the runner's dangerous bypass mode when the corresponding global gate is enabled. See [Agent integration](agent-integration#bypass-permissions-mode-advanced). |
| `skills` | string[] | — | Named skills to attach to this node. Each name is resolved in two ways: (1) as an MCP server from the skills registry (wires in a tool server), and (2) as a text file at `<skillsDir>/<name>.md` (injects usage instructions into the prompt). A skill may be one or both. See [Skills](agent-integration#skills). |
| `mcpServers` | object | — | Explicit MCP server configs keyed by name, merged on top of registry-resolved skills. Node-level entries win over agent-definition entries. |

**Output:** `{ text: string, tokenUsage?: { input: number, output: number } }` stored as the node's artifact.

See [Agent integration](agent-integration) for full runner selection rules and configuration.

If you run agent nodes in a container, the container is generic user-provided execution context. Ripline does not inject runner binaries or credentials into that container; your image must already contain the requested runner and any required auth/config.

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

If you need to trigger a follow-up pipeline from a `shell` or `agent` node instead of using `run_pipeline`, prefer Ripline's HTTP API over editing queue files directly. The supported path is `POST /pipelines/:id/run`, and Ripline includes a small helper for this:

```bash
node /home/openclaw/ripline/scripts/enqueue-pipeline-run.mjs \
  --ripline-url http://localhost:4001 \
  --dedupe-input-key idea_id \
  --inputs-json '{"idea_id":"abc123"}' \
  verify_and_promote_build_from_plan_isolated
```

This keeps queueing logic on the API boundary and avoids hidden runtime dependencies like PyYAML inside build containers.

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

### `collect_children`

Loads the current run's child run records (from a prior `enqueue` node) from the store and writes an artifact with per-child status, outputs, and error. Used immediately after the parent is resumed so downstream nodes (e.g. a verification agent) can see all child results and handle partial failures.

The parent run is resumed by the scheduler when **all** children are in a terminal state (`completed` or `errored`). This node runs in the parent run after resume and aggregates those results.

```yaml
- id: collect
  type: collect_children
```

**Convention:** Giving this node `id: collect` is recommended so downstream prompts can reliably reference `artifacts.collect.childResults` and `artifacts.collect.summary` without per-pipeline naming.

#### Artifact shape

The node writes an artifact (under its own `id`) with:

| Key | Type | Description |
|-----|------|-------------|
| `childResults` | array | One entry per child run. Each entry has `id`, `taskId` (if per-item enqueue), `status` (`"completed"` \| `"errored"`), and when applicable `outputs` (completed) or `error` (errored). |
| `summary` | object | `{ completed: number, errored: number, total: number }` for quick sanity checks in prompts. |

Failed child runs appear with `status: "errored"` and `error` set, so the next node can decide whether to proceed or flag.

#### When to use

Place `collect_children` as the first node after the `enqueue` node in the graph. Connect it to your verification or aggregation node (e.g. an agent that runs build/tests and reasons over `artifacts.collect.childResults` and `artifacts.collect.summary`).

#### Requirements

Requires `runId` and `store` in executor context (i.e. the run must be a stored run, as when using the queue/scheduler). If the run has no `childRunIds`, the node writes an empty `childResults` array and zero counts in `summary` instead of failing.

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

## Full example: spec-then-build pipeline

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
