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

## Choosing stub vs OpenClaw vs LLM runner

- **CLI (`ripline run`):** If the CLI was registered by the plugin inside OpenClaw, it receives the OpenClaw agent runner and uses it. Otherwise, it uses an LLM runner if config is present (env, config file, or `--agent-provider` / `--agent-model`), or the stub. Use `--demo` for a deterministic stub.
- **HTTP server:** The server uses the runner passed in at startup. When started by the plugin inside OpenClaw, the plugin passes the OpenClaw runner. When started standalone (e.g. `ripline serve`), it uses an LLM runner if config is present, otherwise the stub. To force the stub even when an OpenClaw or LLM runner would be available, set **`RIPLINE_AGENT_RUNNER=stub`** in the environment before starting the server.

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
- `src/agent-runner-config.ts` – config resolution (env, file, plugin)
- `docs/stories/story-15-openclaw-agent-runner.md` – implementation story

## Node options

- **`resetSession`** (optional, default `true`): When `true` or omitted, the node runs with a new session (context isolation). When `false`, the node uses the run-level `sessionId` for conversation continuity.
- **`sessionId`** (optional, on node): Reserved for future use (e.g. explicit “use this session” override). Run-level session is set by the runner; nodes with `resetSession: false` receive it via execution context.
