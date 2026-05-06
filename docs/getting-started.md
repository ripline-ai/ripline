# Getting Started

Ripline is a pipeline engine for repeatable multi-agent workflows. You declare the flow as a YAML DAG, Ripline executes it reliably, and every run is fully traceable and resumable. Alongside basic node pipelines, Ripline has built-in support for multi-agent review phases that fan out to multiple AI CLIs, evaluate quorum, and retry on disagreement.

## Installation

```bash
# From the repository
git clone https://github.com/craigjmidwinter/ripline
cd ripline
npm install
npm run build
```

Once built, the `ripline` CLI is available via `node bin/ripline.js` or, if the package is installed globally, as the `ripline` command.

## Hello World

The minimal pipeline has three steps: **input** (load JSON), **transform** (shape data), and **output** (write artifact).

**Pipeline** (`pipelines/examples/hello-world.yaml`):

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

**Run it:**

```bash
ripline run --pipeline pipelines/examples/hello-world.yaml \
  --input '{"person":"World","goal":"get started"}'
```

Or use the built-in demo (uses a stub agent, no configuration needed):

```bash
npm run demo
```

Outputs are written to `.ripline/runs/<runId>/run.json` and, if you pass `-o <path>`, to that file.

## What to understand next

- **Pipelines are explicit.** Nodes, edges, retries, and templates are all declared in the pipeline file.
- **Agent steps are isolated by default.** Set `resetSession: false` only when you intentionally want continuity across steps.
- **Contracts are optional but useful.** Add JSON Schema at pipeline or node boundaries when you want stricter guarantees.

## Next: multi-agent review

The Hello World pipeline above covers the basic node types. Ripline also ships with three built-in phase kinds — `plan`, `review`, and `review_only` — that run a doer agent and fan its output to N reviewer agents in parallel, evaluate quorum, and feed disagreements back to the doer for retry.

If your use case involves reviewing documents, specs, code, or any generated artifact with multiple AI CLIs, see [docs/review-pipelines.md](review-pipelines.md) for:

- When to use review pipelines vs regular agent pipelines
- The `parseReviewPipeline` / `loadReviewPipeline` programmatic API
- How quorum and cross-lineage enforcement works
- The retry loop and `iterate.onDisagreement` options
- The `ship` config for auto-PR after approval
- A complete end-to-end example

## Next steps

| Topic | Guide |
|-------|-------|
| Multi-agent review phases | [Review Pipelines](review-pipelines.md) |
| Learn the pipeline YAML format | [Pipeline Reference](pipeline-reference) |
| Explore all CLI commands and flags | [CLI Reference](cli-reference) |
| Set up config files and env vars | [Configuration](configuration) |
| Connect an AI model or agent runner | [Agent Integration](agent-integration) |
| Set up profiles for different projects | [Pipelines & Profiles](pipelines-and-profiles) |
| Run pipelines on a schedule | [Automation & Cron](automation-cron) |
| Trigger and inspect runs over HTTP | [HTTP API](http-api) |
