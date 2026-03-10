# Agent integration (OpenClaw)

## How agent nodes run

Every pipeline **agent** node delegates to a configurable **agent runner**. The runner is responsible for sending the prompt to a model (with optional thinking level and timeout) and returning text plus optional token usage.

- **Inside OpenClaw:** When the pipeline plugin is loaded by an OpenClaw host, the host passes a **runtime** API. The plugin then creates an agent runner that calls `openclaw agent --json` via `runtime.system.runCommandWithTimeout`. So all pipelines use the platform’s configured models, tools, and sandbox.
- **Standalone / local dev:** When the plugin runs without OpenClaw (e.g. `ripline serve` or CLI only), no runtime is provided. By default the HTTP server and inline runs use a **stub** runner that returns a short placeholder response. You can instead configure an **LLM agent runner** (Ollama, OpenAI, or Anthropic) so agent nodes run for real without OpenClaw.

## Running without OpenClaw (Ollama / OpenAI / Anthropic)

When not running inside OpenClaw, you can run agent nodes using a single configured LLM:

- **Provider:** `ollama`, `openai`, or `anthropic`
- **Model:** e.g. `llama3.2`, `gpt-4o-mini`, `claude-3-5-sonnet-20241022`
- **API keys:** Required for OpenAI and Anthropic; optional for Ollama (local). Use `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` in the environment, or set in config.

**Configuration (precedence: CLI flags > env > config file):**

1. **Environment variables**
   - `RIPLINE_AGENT_PROVIDER` – `ollama` | `openai` | `anthropic`
   - `RIPLINE_AGENT_MODEL` – model name
   - `RIPLINE_AGENT_BASE_URL` – optional (e.g. custom Ollama or OpenAI-compatible endpoint)
   - `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` – used when provider is openai/anthropic and no apiKey in config

2. **Config file** (optional)
   - `.ripline/agent.json` – `{ "provider": "ollama", "model": "llama3.2" }` (and optional `apiKey`, `baseURL`)
   - Or `ripline.config.json` with an `agent` (or `agentRunner`) section with the same shape

3. **CLI flags**
   - `ripline run --agent-provider ollama --agent-model llama3.2` (and optional `--agent-base-url`)
   - `ripline serve --agent-provider openai --agent-model gpt-4o-mini` (use `OPENAI_API_KEY` or plugin config for the key)

**Plugin config:** When the pipeline plugin is loaded without an OpenClaw runtime, you can set `agentRunner` in the plugin config: `{ "provider": "ollama", "model": "llama3.2" }` (and optional `apiKey`, `baseURL`). API keys can be omitted and read from env.

**Limitations of the LLM runner (this version):**

- One provider and model for all agent nodes; `agentId` is ignored.
- Session continuity (`resetSession: false`) and `thinking` are not supported; each call is a single stateless request.

## Choosing stub vs OpenClaw vs LLM vs Claude Code runner

**Runner selection (global order):**

1. **OpenClaw** – When the plugin runs inside an OpenClaw host, the host provides the agent runner. All agent nodes use it; **Claude Code runner is not available** (see below).
2. **Per-node `runner: claude-code`** – If an agent node has `runner: "claude-code"` and a Claude Code runner is configured, that node uses the Claude Code runner (plan or execute mode).
3. **LLM runner** – If no OpenClaw runtime and no per-node Claude Code, and LLM config is present, agent nodes use the LLM runner (Ollama/OpenAI/Anthropic).
4. **Stub** – Otherwise the stub returns a placeholder response.

**Per-node rule:** Nodes with `runner: "claude-code"` use the Claude Code runner when `claudeCodeRunner` is set; if it is not set (e.g. when running inside OpenClaw), the run fails with a clear “claude-code runner required” message. Nodes without `runner: "claude-code"` use the default runner (OpenClaw > LLM > stub).

- **CLI (`ripline run`):** If the CLI was registered by the plugin inside OpenClaw, it receives the OpenClaw agent runner and uses it. Otherwise, it uses an LLM runner if config is present (env, config file, or `--agent-provider` / `--agent-model`), and optionally a Claude Code runner from env/config; or the stub. Use `--demo` for a deterministic stub.
- **HTTP server:** The server uses the runners passed in at startup. When started by the plugin inside OpenClaw, the plugin passes only the OpenClaw runner (no Claude Code runner). When started standalone (e.g. `ripline serve`), it uses an LLM runner and/or Claude Code runner if config is present, otherwise the stub. To force the stub even when an OpenClaw or LLM runner would be available, set **`RIPLINE_AGENT_RUNNER=stub`** in the environment before starting the server.

---

## Using Claude Code as a runner

When running **standalone** (not inside OpenClaw), you can configure the **Claude Code** runner so that agent nodes with `runner: "claude-code"` invoke the Claude Code SDK (plan-only or full execute) with a configurable working directory. This is a standalone alternative to the LLM runner for full pipeline flows without OpenClaw.

**When to use `runner: claude-code` vs the LLM runner**

- Use **Claude Code** when you want the model to use tools (read/write files, run commands) in a single node with a fixed `cwd`, with either **plan** (read-only) or **execute** (edits allowed) mode.
- Use the **LLM runner** when you want a single stateless chat completion per node (no tools, no `cwd`).

**Plan vs execute mode and security**

- **`mode: "plan"`** – Read-only. The runner uses the SDK with `permissionMode: "plan"` and a **PreToolUse** hook that **always denies** `Write`, `Edit`, and `MultiEdit` (defense-in-depth). Use this for “analyze and suggest” steps.
- **`mode: "execute"`** (default) – The model may use write/edit tools. Use for “implement this” or “apply changes” steps.

**`cwd` injection**

- Each node can set **`cwd`** (optional). It supports template interpolation (e.g. `{{ run.inputs.repoPath }}`). The runner resolves it and validates: the path must be an existing directory and must not contain `..`. Use this to run different nodes in different project roots (e.g. one node per repo).
- When using **profiles**, you can supply paths via profile inputs and reference them in `cwd`, e.g. `cwd: "{{ run.inputs.projectRoot }}"`. See [Pipelines and profiles](pipelines-and-profiles.md).

**Configuration**

- **Environment:** `RIPLINE_CLAUDE_CODE_MODE` (plan | execute), `RIPLINE_CLAUDE_CODE_CWD`, `RIPLINE_CLAUDE_CODE_MODEL` (default model, e.g. `claude-sonnet-4-6`), `RIPLINE_CLAUDE_CODE_MAX_TURNS`, `RIPLINE_CLAUDE_CODE_TIMEOUT` (seconds).
- **Config file:** In `.ripline/agent.json` or `ripline.config.json`, use a top-level **`claudeCode`** key: `{ "claudeCode": { "mode": "execute", "cwd": "/path/to/project", "model": "claude-sonnet-4-6", "maxTurns": 10, "timeoutSeconds": 120 } }`. The optional **`model`** sets the default for all Claude Code nodes; per-node **`model`** overrides it.
- **Plugin config:** When the plugin runs without OpenClaw, you can set `pluginConfig.claudeCode` with the same shape.

**Important:** When the pipeline runs **inside OpenClaw**, `claudeCodeRunner` is **not** set. Agent nodes with `runner: "claude-code"` will fail with “claude-code runner required”. Use the default runner (OpenClaw) for those environments.

**Example: spec then build queue with Claude Code**

```yaml
# Fragment: spec_then_build_queue with one node on Claude Code (execute) and one on default runner
nodes:
  - id: spec
    type: agent
    runner: claude-code
    mode: plan
    cwd: "{{ run.inputs.repoPath }}"
    prompt: "Analyze the codebase and produce a short spec for the feature."
  - id: implement
    type: agent
    runner: claude-code
    mode: execute
    cwd: "{{ run.inputs.repoPath }}"
    dangerouslySkipPermissions: true   # only when global bypass is enabled; use for isolated envs
    prompt: "Implement the spec from the previous step. Output a summary to stdout."
edges:
  - from: { node: spec }
    to:   { node: implement }
```

Ensure `run.inputs.repoPath` is set (e.g. from an input node or upstream artifact) and that Claude Code config (env or file) is present when running standalone.

### Bypass permissions mode (advanced)

By default, execute mode uses `permissionMode: "dontAsk"` with an explicit **allowedTools** whitelist and **disallowedTools** denylist. For fully autonomous headless execution in an isolated environment (e.g. a container or VM, or CI/CD), you can opt in to **bypass permissions** mode. In this mode the SDK does not prompt for tool approval and **allowedTools** is not enforced by the SDK (a known SDK behavior); **disallowedTools** is still applied as a last-resort constraint.

**When it’s appropriate:** Only in isolated environments where the host is already scoped (container, VM, dedicated CI runner). Do **not** use bypass on a shared or personal machine.

**How to enable (user-level only; not configurable from pipeline YAML or profiles):**

- **User config:** In `~/.ripline/config.json`, set `"claudeCode": { "allowDangerouslySkipPermissions": true }`.
- **Environment:** Set `RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true` (useful in CI/CD).

**Per-node opt-in (recommended):** For safety, bypass runs only for nodes that explicitly set **`dangerouslySkipPermissions: true`** in the pipeline YAML. Even with global bypass enabled, nodes that omit this property use default execute mode (`dontAsk` + allowedTools). This limits blast radius: only the nodes you mark get full autonomy.

### Logging (Claude Code runner)

The Claude Code runner writes diagnostic logs to stderr (and, when running a stored run, to `<runsDir>/<runId>/log.txt`):

1. **Stream message logging** — Every message from the Claude Agent SDK stream is logged with `type` and `subtype` (e.g. `system/init`, `assistant`, `user`, `result`) so you can see turns in real time.
2. **Result message dump** — When a `type=result` message arrives, the full object is logged (truncated to 2000 chars).
3. **Rich error detail on failure** — On non-success (e.g. `error_max_turns`), the runner logs `subtype`, `errors`, and a result snippet, then throws with that detail.
4. **Config at startup** — Set **`RIPLINE_LOG_CONFIG=1`** to log the effective config once per invocation: `maxTurns`, `timeoutMs`, `mode`, `cwd`. Omit or leave unset to keep startup quiet.

To view logs for a run: use **`ripline logs <runId>`** (or **`ripline logs <runId> --follow`** to stream), or **`GET /runs/:runId/logs`** / **`GET /runs/:runId/logs/stream`** via the HTTP API. See [Logging](../README.md#logging) and [HTTP API – run logs](http-api.md#get-run-logs).

**Activation rules:** Bypass is used only when **all** of the following are true: the global flag is enabled (config or env), the **node** sets `dangerouslySkipPermissions: true`, the node **mode** is `"execute"`, and **cwd** is explicitly set (in config or node params) and resolves to an existing directory. Otherwise the runner falls back to default execute mode and logs why bypass was not activated.

**What does not change:** Plan mode is never affected. `cwd` validation, `maxTurns` ceiling, timeout, and the PreToolUse hook behavior are unchanged. A **warning** is always printed to stderr when bypass is active; it cannot be suppressed.

**Reference:** Claude Code’s own documentation for `--dangerously-skip-permissions` (or equivalent) describes the same capability at the CLI level.

## Context isolation (sessions)

To avoid **context bleed** between agent nodes, the plugin uses OpenClaw’s native session model:

- **Default (isolation):** Each agent node runs with a **new unique session ID** (UUID) passed as `--session <id>`. The agent only sees the current prompt and inputs; no prior turns from other nodes.
- **Continuity (opt-in):** Set **`resetSession: false`** on an agent node to use the **run-level session**. The runner generates one shared `sessionId` per pipeline run and passes it to every node that has `resetSession: false`, so those nodes share the same conversation.

No file deletion, in-chat “reset” prompts, or compact commands are used; isolation and continuity are driven only by the `--session` argument.

## Agent JSON envelope

The OpenClaw runner invokes:

```bash
openclaw agent --json --agent <agentId> --session <sessionId> [--thinking <level>] [--timeout <seconds>]
```

with the prompt on stdin. The `sessionId` is either a new UUID per node (context isolation) or the run-level session ID (when the node has `resetSession: false`). It expects stdout to be a single JSON object:

- **`text`** (string, required): model response text.
- **`tokenUsage`** (optional): `{ "input": number, "output": number }`.

Any non-zero exit code or invalid JSON is surfaced as an error; the run record is updated (status `errored`, `waitFor` cleared) with a clear message.

## References

- `src/pipeline/executors/agent.ts` – agent node executor and `AgentRunner` type
- `src/openclaw-agent-runner.ts` – `createOpenClawAgentRunner(api)` and `OpenClawPluginApi`
- `src/llm-agent-runner.ts` – `createLlmAgentRunner(config)` for Ollama/OpenAI/Anthropic
- `src/claude-code-runner.ts` – `createClaudeCodeRunner(config)` for Claude Code (plan/execute)
- `src/agent-runner-config.ts` – config resolution (env, file, plugin)
- `docs/stories/story-15-openclaw-agent-runner.md` – implementation story

## Node options

- **`resetSession`** (optional, default `true`): When `true` or omitted, the node runs with a new session (context isolation). When `false`, the node uses the run-level `sessionId` for conversation continuity.
- **`sessionId`** (optional, on node): Reserved for future use (e.g. explicit “use this session” override). Run-level session is set by the runner; nodes with `resetSession: false` receive it via execution context.
- **`runner`** (optional): Set to `"claude-code"` to use the Claude Code runner for this node when configured; otherwise the default runner (OpenClaw > LLM > stub) is used.
- **`mode`** (optional, when `runner: "claude-code"`): `"plan"` (read-only) or `"execute"` (default). Ignored for other runners.
- **`model`** (optional, when `runner: "claude-code"`): Model to use for this node (e.g. `claude-sonnet-4-6`, `claude-opus-4-6`). Overrides the default from config or CLI. Omit to use the default.
- **`cwd`** (optional, when `runner: "claude-code"`): Working directory for the Claude Code run; supports template interpolation (e.g. `{{ run.inputs.repoPath }}`). Must be an existing directory and must not contain `..`. Ignored for other runners.
- **`dangerouslySkipPermissions`** (optional, when `runner: "claude-code"`): Set to `true` to allow bypass permissions for this node when global bypass is enabled (`~/.ripline/config.json` or `RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true`). Omit or `false` = use default execute mode (`dontAsk` + allowedTools) for this node. Safer to enable only on specific nodes that need full autonomy.
