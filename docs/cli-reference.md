# CLI Reference

This document is the complete reference for the `ripline` command-line interface.

---

## Installation

```bash
# From the repository
npm install
npm run build

# Global / npx (when published)
npm install -g ripline
# or without installing:
npx ripline <command>
```

After building, the `ripline` binary is available via `bin/ripline.js` or, if installed globally, as the `ripline` command.

---

## Global options

```
ripline [options] <command>

Options:
  -V, --version   Output the version number
  -h, --help      Display help
```

---

## `ripline run`

Run a pipeline by ID (from the pipeline directory) or by file path.

```
ripline run [pipelineId] [options]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `pipelineId` | Pipeline ID (filename without extension) looked up in the pipeline directory. Omit when using `--pipeline`. |

### Options

| Flag | Description |
|------|-------------|
| `-p, --pipeline <path>` | Path to a YAML or JSON pipeline file. Takes precedence over `pipelineId`. |
| `--profile <name>` | Profile name. Loads default inputs from `~/.ripline/profiles/<name>.yaml` (or the configured profile directory). |
| `-i, --input <json-or-path>` | Inputs as inline JSON (`'{"task":"..."}'`) or a path to a JSON file. Overrides profile values for the same keys. |
| `--inputs <json-or-path>` | Alias for `--input`. |
| `--pipeline-dir <path>` | Override the pipeline directory for this run. |
| `--profile-dir <path>` | Override the profile directory for this run. |
| `--no-profile` | Disable the default profile for this run (even if `defaultProfile` is set in user config). |
| `-e, --env <key=value>` | Add an environment key-value pair to the run context. Repeatable: `-e FOO=bar -e BAR=baz`. |
| `--resume <runId>` | Resume a paused or errored run by ID. Prior completed steps are replayed; execution continues from the first errored or paused node (or the next unfinished node). |
| `-o, --out <path>` | Write final run outputs to this JSON file on completion. |
| `--runs-dir <path>` | Directory for run state files (default: `.ripline/runs` or `RIPLINE_RUNS_DIR`). |
| `-v, --verbose` | Enable verbose logging — prints node ID, type, duration, and status for each step. |
| `--demo` | Run the Hello World pipeline with sample inputs and a deterministic stub agent. Writes the output to `dist/demo-artifact.json`. Does not require any pipeline file argument. |
| `--enqueue` | Add the run to the queue (status `pending`) without executing it immediately. Prints the `runId` and exits. Process it later via the scheduler or the HTTP retry endpoint. |
| `--tail <mode>` | Tail mode. Currently supported: `queue` — list queued runs. |
| `--follow` | With `--tail queue`: keep polling and printing the queue state until interrupted. |
| `--agent-provider <provider>` | Standalone agent provider: `ollama`, `openai`, or `anthropic`. Overrides env/config for this run. |
| `--agent-model <model>` | Standalone agent model (e.g. `llama3.2`, `gpt-4o-mini`). Overrides env/config for this run. |
| `--agent-base-url <url>` | Standalone agent base URL (e.g. a custom Ollama endpoint). Overrides env/config. |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Pipeline completed successfully. |
| Non-zero | Pipeline errored, failed to load, or an unexpected error occurred. Use in cron/CI for alerts. |

### Examples

```bash
# Run by pipeline file with inline inputs
ripline run --pipeline pipelines/examples/hello-world.yaml \
  --input '{"person":"World","goal":"get started"}'

# Run by ID from the default pipeline directory
ripline run hello_world --input '{"person":"Alice"}'

# Run with a profile (loads default inputs from the profile)
ripline run spec-then-implement --profile my-app \
  --input '{"task":"add OAuth login"}'

# Run and write outputs to a file
ripline run daily_brief -i inputs.json -o output.json

# Resume a paused or errored run
ripline run --resume 550e8400-e29b-41d4-a716-446655440000

# Run with verbose logging and a specific agent provider
ripline run my_pipeline --agent-provider ollama --agent-model llama3.2 --verbose

# Enqueue a run for later processing
ripline run my_pipeline --input '{"task":"build feature"}' --enqueue

# Run the built-in demo (no pipeline file needed)
ripline run --demo
```

---

## `ripline serve`

Start the Ripline HTTP API server as a standalone process.

```
ripline serve [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--port <number>` | Port to listen on (default: `4001`). |
| `--pipelines-dir <path>` | Directory containing pipeline YAML/JSON files (default: `./pipelines`). |
| `--runs-dir <path>` | Directory for run state (default: `.ripline/runs` or `RIPLINE_RUNS_DIR`). |
| `--auth-token <token>` | Require `Authorization: Bearer <token>` on all requests. |
| `--agent-provider <provider>` | Standalone agent provider: `ollama`, `openai`, or `anthropic`. |
| `--agent-model <model>` | Standalone agent model. |
| `--agent-base-url <url>` | Standalone agent base URL. |

### Example

```bash
# Start server on default port 4001
ripline serve

# Start server on port 8080 with a custom pipelines directory
ripline serve --port 8080 --pipelines-dir ./my-pipelines

# Start with an LLM agent provider
ripline serve --agent-provider openai --agent-model gpt-4o-mini
```

See [HTTP API reference](http-api) for the available endpoints.

---

## `ripline pipelines`

Manage and inspect the pipeline registry.

### `ripline pipelines list`

List all pipelines in the pipeline directory.

```
ripline pipelines list [options]
```

| Flag | Description |
|------|-------------|
| `--pipeline-dir <path>` | Override the pipeline directory for this listing. |

**Output:** Pipeline ID (filename stem), name, and entry node(s) for each pipeline.

```bash
ripline pipelines list
# hello_world     Hello World Pipeline    [intake]
# daily_brief     Daily Brief Workflow    [load_inputs]
```

---

## `ripline profiles`

Manage input profiles.

### `ripline profiles list`

List all profiles in the profile directory.

```bash
ripline profiles list [--profile-dir <path>]
```

### `ripline profiles show <name>`

Show the inputs for a named profile.

```bash
ripline profiles show my-app
```

### `ripline profiles create <name>`

Create a new profile template and open it in `$EDITOR` (use `--no-edit` to skip the editor).

```bash
ripline profiles create my-app
ripline profiles create my-app --no-edit
```

### `ripline profiles validate <name>`

Check that a profile file is valid (has the required `name` field and matching filename, valid YAML).

```bash
ripline profiles validate my-app
```

---

## Environment variables

The following environment variables are read by the CLI and affect its behavior.

| Variable | Description |
|----------|-------------|
| `RIPLINE_RUNS_DIR` | Default directory for run state files. Overridden by `--runs-dir`. |
| `RIPLINE_AGENT_PROVIDER` | Standalone agent provider (`ollama`, `openai`, `anthropic`). Overridden by `--agent-provider`. |
| `RIPLINE_AGENT_MODEL` | Standalone agent model. Overridden by `--agent-model`. |
| `RIPLINE_AGENT_BASE_URL` | Standalone agent base URL. Overridden by `--agent-base-url`. |
| `RIPLINE_AGENT_RUNNER` | Force agent runner selection: set to `stub` to use the stub runner even when an OpenClaw or LLM runner is available. |
| `OPENAI_API_KEY` | API key for OpenAI when `RIPLINE_AGENT_PROVIDER=openai`. |
| `ANTHROPIC_API_KEY` | API key for Anthropic when `RIPLINE_AGENT_PROVIDER=anthropic`. |
| `RIPLINE_CLAUDE_CODE_MODE` | Claude Code runner mode: `plan` or `execute`. |
| `RIPLINE_CLAUDE_CODE_CWD` | Default working directory for the Claude Code runner. |
| `RIPLINE_CLAUDE_CODE_MAX_TURNS` | Maximum turns for Claude Code sessions. |
| `RIPLINE_CLAUDE_CODE_TIMEOUT` | Timeout in seconds for Claude Code sessions. |
| `RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS` | Set to `true` to enable bypass permissions mode globally (see [Agent integration](agent-integration#bypass-permissions-mode-advanced)). |
| `RIPLINE_CODEX_MODE` | Codex runner mode: `plan` or `execute`. |
| `RIPLINE_CODEX_CWD` | Default working directory for the Codex runner. |
| `RIPLINE_CODEX_MODEL` | Default model for Codex sessions. |
| `RIPLINE_CODEX_TIMEOUT` | Timeout in seconds for Codex sessions. |
| `RIPLINE_CODEX_DANGEROUSLY_SKIP_PERMISSIONS` | Set to `true` to enable Codex dangerous bypass mode globally. |
| `RIPLINE_INPUTS` | Path to a JSON inputs file (used by helper scripts, e.g. cron). |
| `RIPLINE_OUT` | Output path for run artifacts (used by helper scripts). |

---

## Input resolution order

When multiple input sources are provided, they are merged in the following order (later sources override earlier ones):

1. Profile inputs (from `--profile` or `defaultProfile` in user config)
2. `--input` / `--inputs` value

---

## Run storage

By default, run state is written to `.ripline/runs/<runId>/run.json` in the current working directory. Change this with:

- `--runs-dir <path>` (CLI flag)
- `RIPLINE_RUNS_DIR` (environment variable)
- `runsDir` in the plugin config

Runs are **not auto-deleted**. For long-lived or high-volume deployments, set up a rotation or cleanup job.

---

## Demo mode

```bash
ripline run --demo
# or
npm run demo
```

Runs the Hello World pipeline with a stub agent and deterministic sample inputs. No real agent is called. Output is written to `dist/demo-artifact.json`. Useful for verifying the pipeline engine without configuring an agent provider.
