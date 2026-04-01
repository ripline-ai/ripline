# Configuration Reference

This document is the complete reference for all Ripline configuration files, environment variables, and plugin config options.

---

## Configuration files

Ripline reads configuration from three separate files, each scoped to a different level.

| File | Scope | Purpose |
|------|-------|---------|
| `~/.ripline/config.json` | User (global) | Default pipeline/profile directories, default profile, built-in runner user-level settings |
| `ripline.config.json` | Project (local) | Per-project pipeline/profile directory overrides; commit alongside your code |
| `~/.ripline/agent.json` | User (global) | Standalone agent runner configuration (provider, model, API key, base URL, Claude Code, Codex) |

---

## User config — `~/.ripline/config.json`

Optional. Applied globally for the current user.

```json
{
  "pipelineDir": "~/.ripline/pipelines",
  "profileDir": "~/.ripline/profiles",
  "defaultProfile": null,
  "claudeCode": {
    "allowDangerouslySkipPermissions": false
  },
  "codex": {
    "allowDangerouslySkipPermissions": false
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pipelineDir` | string | `~/.ripline/pipelines` | Default directory to search for pipeline YAML/JSON files. Supports `~` expansion. |
| `profileDir` | string | `~/.ripline/profiles` | Default directory to search for profile YAML files. Supports `~` expansion. |
| `skillsDir` | string | `~/.ripline/skills` | Directory containing per-skill markdown files. See [Text skills](agent-integration#text-skills). Supports `~` expansion. |
| `defaultProfile` | string \| null | `null` | Profile name applied to every run unless `--profile` or `--no-profile` is passed. |
| `claudeCode.allowDangerouslySkipPermissions` | boolean | `false` | **User-level gate** for the bypass permissions feature in the Claude Code runner. Must be `true` here (or via the env var) for any node with `dangerouslySkipPermissions: true` to use bypass mode. See [Agent integration](agent-integration#bypass-permissions-mode-advanced). |
| `codex.allowDangerouslySkipPermissions` | boolean | `false` | **User-level gate** for the dangerous bypass mode in the Codex runner. Must be `true` here (or via the env var) for any node with `dangerouslySkipPermissions: true` to use bypass mode. |

---

## Project config — `ripline.config.json`

Optional. Place this file in the root of a project to set project-local overrides. It is resolved from the current working directory when the CLI is run.

```json
{
  "pipelineDir": "./pipelines",
  "profileDir": "./profiles",
  "agent": {
    "provider": "ollama",
    "model": "llama3.2"
  },
  "agentRunner": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "sk-..."
  },
  "claudeCode": {
    "mode": "execute",
    "cwd": "./",
    "maxTurns": 10,
    "timeoutSeconds": 120
  },
  "codex": {
    "mode": "execute",
    "cwd": "./",
    "model": "gpt-5.4",
    "timeoutSeconds": 120
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `pipelineDir` | string | — | Override the pipeline directory for this project. Relative paths resolve from the project root (CWD). |
| `profileDir` | string | — | Override the profile directory for this project. |
| `agent` / `agentRunner` | object | — | Standalone LLM agent config. Either key is accepted. See [Agent config](#agent-config). |
| `claudeCode` | object | — | Claude Code runner config. See [Claude Code config](#claude-code-config). |
| `codex` | object | — | Codex runner config. See [Codex config](#codex-config). |

---

## Agent config — `~/.ripline/agent.json` or `ripline.config.json`

Configure the standalone agent runner (Ollama, OpenAI, or Anthropic) used when running outside of an OpenClaw host.

You can put this in either:
- `~/.ripline/agent.json` — user-level default
- `ripline.config.json` (in the project root) under the `agent` or `agentRunner` key

```json
{
  "provider": "openai",
  "model": "gpt-4o-mini",
  "apiKey": "sk-your-key",
  "baseURL": "https://api.openai.com/v1"
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `provider` | `"ollama"` \| `"openai"` \| `"anthropic"` | ✅ | LLM provider. |
| `model` | string | ✅ | Model name (e.g. `llama3.2`, `gpt-4o-mini`, `claude-3-5-sonnet-20241022`). |
| `apiKey` | string | — | API key. If omitted, falls back to `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` from the environment. |
| `baseURL` | string | — | Custom API base URL (e.g. for a local Ollama instance or an OpenAI-compatible endpoint). |

---

## Claude Code config

Configure the Claude Code runner. Place in `ripline.config.json` under `claudeCode` or set via environment variables.

```json
{
  "claudeCode": {
    "mode": "execute",
    "cwd": "/path/to/project",
    "maxTurns": 10,
    "timeoutSeconds": 120
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"plan"` \| `"execute"` | `"execute"` | Default mode for all Claude Code nodes. `"plan"` = read-only (writes denied). `"execute"` = full tool access. Per-node `mode` overrides this. |
| `cwd` | string | — | Default working directory for all Claude Code nodes. Per-node `cwd` overrides this. |
| `maxTurns` | number | — | Maximum number of agent turns per Claude Code invocation. |
| `timeoutSeconds` | number | — | Timeout in seconds per Claude Code invocation. |

---

## Codex config

Configure the Codex runner. Place in `ripline.config.json` under `codex` or set via environment variables.

```json
{
  "codex": {
    "mode": "execute",
    "cwd": "/path/to/project",
    "model": "gpt-5.4",
    "timeoutSeconds": 120
  }
}
```

### Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | `"plan"` \| `"execute"` | `"execute"` | Default mode for all Codex nodes. `"plan"` = `read-only` sandbox. `"execute"` = `workspace-write` sandbox. Per-node `mode` overrides this. |
| `cwd` | string | — | Default working directory for all Codex nodes. Per-node `cwd` overrides this. |
| `model` | string | — | Default model for Codex nodes. Per-node `model` overrides this. |
| `timeoutSeconds` | number | — | Timeout in seconds per Codex invocation. |

---

## Plugin config (OpenClaw host)

When Ripline is loaded as an OpenClaw plugin, these fields are set in the host's plugin config block (in `openclaw.plugin.json` or the host config).

```jsonc
{
  "id": "ripline",
  "from": "./path/to/ripline/openclaw.plugin.json",
  "config": {
    "pipelinesDir": "./pipelines",        // required
    "runsDir": ".ripline/runs",           // optional
    "maxConcurrency": 4,                  // optional
    "httpPath": "/pipelines",             // optional
    "httpPort": 4001,                     // optional
    "authToken": "optional-bearer-token", // optional
    "agentRunner": {                      // optional — standalone LLM runner
      "provider": "ollama",
      "model": "llama3.2"
    },
    "claudeCode": {                       // optional — Claude Code runner
      "mode": "execute",
      "cwd": "/path/to/project",
      "maxTurns": 10,
      "timeoutSeconds": 120
    },
    "codex": {                            // optional — Codex runner
      "mode": "execute",
      "cwd": "/path/to/project",
      "model": "gpt-5.4",
      "timeoutSeconds": 120
    }
  }
}
```

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `pipelinesDir` | string | ✅ | Directory containing pipeline YAML/JSON files. Relative paths resolve from the OpenClaw workspace root. |
| `runsDir` | string | — | Directory for run state (one subdirectory per run). Default: `.ripline/runs`. Relative paths resolve from the workspace. |
| `maxConcurrency` | number | — | Maximum number of pipeline runs executing in parallel (default: `4`). |
| `httpPath` | string | — | Base URL path for the HTTP API when mounted by the OpenClaw host (default: `/pipelines`). |
| `httpPort` | number | — | Port for the HTTP server when started by the plugin (default: `4001`). |
| `authToken` | string | — | If set, all HTTP requests must include `Authorization: Bearer <token>`. |
| `agentRunner` | object | — | Standalone LLM agent config. Used when the plugin runs without an OpenClaw runtime. Same shape as the [agent config](#agent-config). |
| `claudeCode` | object | — | Claude Code runner config. Same shape as [Claude Code config](#claude-code-config). |
| `codex` | object | — | Codex runner config. Same shape as [Codex config](#codex-config). |

---

## Environment variables

All environment variables override the corresponding config file values unless a CLI flag is also provided (CLI flags have the highest precedence).

### Agent runner

| Variable | Description |
|----------|-------------|
| `RIPLINE_AGENT_PROVIDER` | Standalone agent provider: `ollama`, `openai`, or `anthropic`. |
| `RIPLINE_AGENT_MODEL` | Standalone agent model name. |
| `RIPLINE_AGENT_BASE_URL` | Custom base URL for the agent API endpoint. |
| `RIPLINE_AGENT_RUNNER` | Force runner: `stub` bypasses OpenClaw and LLM runners even if configured. |
| `OPENAI_API_KEY` | OpenAI API key (used when provider is `openai` and no `apiKey` in config). |
| `ANTHROPIC_API_KEY` | Anthropic API key (used when provider is `anthropic` and no `apiKey` in config). |

### Claude Code runner

| Variable | Description |
|----------|-------------|
| `RIPLINE_CLAUDE_CODE_MODE` | Claude Code mode: `plan` or `execute`. |
| `RIPLINE_CLAUDE_CODE_CWD` | Default working directory for Claude Code. |
| `RIPLINE_CLAUDE_CODE_MAX_TURNS` | Maximum turns per Claude Code invocation. |
| `RIPLINE_CLAUDE_CODE_TIMEOUT` | Timeout in seconds per Claude Code invocation. |
| `RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS` | Set to `true` to enable the global bypass permissions gate. Must still be combined with `dangerouslySkipPermissions: true` on individual nodes. |

### Codex runner

| Variable | Description |
|----------|-------------|
| `RIPLINE_CODEX_MODE` | Codex mode: `plan` or `execute`. |
| `RIPLINE_CODEX_CWD` | Default working directory for Codex. |
| `RIPLINE_CODEX_MODEL` | Default model for Codex nodes. |
| `RIPLINE_CODEX_TIMEOUT` | Timeout in seconds per Codex invocation. |
| `RIPLINE_CODEX_DANGEROUSLY_SKIP_PERMISSIONS` | Set to `true` to enable the global dangerous-bypass gate. Must still be combined with `dangerouslySkipPermissions: true` on individual nodes. |

### Run storage

| Variable | Description |
|----------|-------------|
| `RIPLINE_RUNS_DIR` | Directory for run state files (overridden by `--runs-dir`). |

### Helper scripts

| Variable | Description |
|----------|-------------|
| `RIPLINE_INPUTS` | Path to JSON inputs file (used by cron/automation helper scripts). |
| `RIPLINE_OUT` | Path for output JSON (used by cron/automation helper scripts). |

---

## Precedence order

When the same setting is available from multiple sources, values are resolved in the following order (highest to lowest):

### Pipeline directory

1. `--pipeline-dir` (CLI flag)
2. `pipelineDir` in `~/.ripline/config.json`
3. `pipelineDir` in `ripline.config.json` (project root)
4. Default: `~/.ripline/pipelines/`

### Profile directory

1. `--profile-dir` (CLI flag)
2. `profileDir` in `~/.ripline/config.json`
3. Default: `~/.ripline/profiles/`

### Skills directory

1. `skillsDir` in `~/.ripline/config.json`
2. Default: `~/.ripline/skills/`

### Agent runner config

1. CLI flags (`--agent-provider`, `--agent-model`, `--agent-base-url`)
2. Environment variables (`RIPLINE_AGENT_PROVIDER`, `RIPLINE_AGENT_MODEL`, `RIPLINE_AGENT_BASE_URL`)
3. Config file (`~/.ripline/agent.json` or `ripline.config.json` `agent`/`agentRunner` section)

### Run directory

1. `--runs-dir` (CLI flag)
2. `RIPLINE_RUNS_DIR` (environment variable)
3. `runsDir` in plugin config
4. Default: `.ripline/runs` (relative to CWD)

---

## Directory layout reference

```
~/.ripline/
├── config.json          # user config (pipelineDir, profileDir, skillsDir, defaultProfile, claudeCode)
├── agent.json           # standalone agent runner config (provider, model, apiKey, baseURL)
├── pipelines/           # default pipeline directory
│   ├── my-pipeline.yaml
│   └── spec-then-implement.yaml
├── profiles/            # default profile directory
│   ├── project-a.yaml
│   └── project-b.yaml
└── skills/              # text skill files (one .md per skill name)
    ├── github-cli.md
    ├── aws-cli.md
    └── web-search.md

<project-root>/
├── ripline.config.json  # project-local overrides (pipelineDir, agent, claudeCode)
├── pipelines/           # project-local pipelines (if pipelineDir points here)
│   └── ...
└── .ripline/
    └── runs/            # default run state directory
        └── <runId>/
            └── run.json
```
