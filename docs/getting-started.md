# Getting Started

Ripline is a graph-native pipeline engine for orchestrating multi-agent workflows. You declare the flow as a YAML DAG, Ripline executes it reliably, and every run is fully traceable and resumable.

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

The minimal pipeline has three steps: **input** (load JSON), **transform** (shape data), **output** (write artifact).

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

## Next steps

| Topic | Guide |
|-------|-------|
| Learn the pipeline YAML format | [Pipeline Reference](pipeline-reference) |
| Explore all CLI commands and flags | [CLI Reference](cli-reference) |
| Set up config files and env vars | [Configuration](configuration) |
| Connect an AI model or agent runner | [Agent Integration](agent-integration) |
| Set up profiles for different projects | [Pipelines & Profiles](pipelines-and-profiles) |
| Run pipelines on a schedule | [Automation & Cron](automation-cron) |
| Trigger and inspect runs over HTTP | [HTTP API](http-api) |
