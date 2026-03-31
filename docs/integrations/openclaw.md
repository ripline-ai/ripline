# OpenClaw Integration

Ripline includes a first-party integration for [OpenClaw](https://github.com/craigjmidwinter/openclaw) at `src/integrations/openclaw/`. This integration is **optional** — Ripline works fully standalone without it.

---

## What the integration provides

| Export | Description |
|--------|-------------|
| `createOpenClawAgentRunner(api)` | Factory that creates an `AgentRunner` backed by the OpenClaw agent subprocess. |
| `registerOpenClawRunner(registry, api)` | Convenience helper — detects the OpenClaw runtime and registers the runner into a `RunnerRegistry`. |
| `hasOpenClawRuntime(api)` | Type-guard returning `true` when the OpenClaw runtime API is present. |
| `WintermuteEventSink` | `EventSink` implementation that forwards pipeline events to the Wintermute task management HTTP API. |

---

## Loading Ripline as an OpenClaw plugin

When Ripline is loaded as a plugin inside an OpenClaw host, the host provides a runtime API. The integration uses that API to route all agent nodes through the OpenClaw subprocess.

**Plugin config example (in your OpenClaw host config):**

```jsonc
{
  "id": "ripline",
  "from": "./path/to/ripline/openclaw.plugin.json",
  "config": {
    "pipelinesDir": "./pipelines",
    "runsDir": ".ripline/runs",
    "maxConcurrency": 4,
    "httpPath": "/pipelines",
    "httpPort": 4001,
    "authToken": "optional-bearer-token"
  }
}
```

### What changes when running inside OpenClaw

- All `agent` nodes use the OpenClaw runtime's configured models, tools, and sandbox.
- `agentId` on each node selects the OpenClaw agent persona to invoke (e.g. `vector`, `nova`).
- The `claude-code` runner is **not available** inside OpenClaw. Nodes with `runner: "claude-code"` will fail with a clear error message.
- The HTTP server mounts at the path and port specified in plugin config.

---

## The OpenClaw agent runner

The runner invokes:

```bash
openclaw agent --json --agent <agentId> --session <sessionId> [--thinking <level>] [--timeout <seconds>]
```

with the prompt on stdin. It expects stdout to be a JSON object:

```json
{ "text": "...", "tokenUsage": { "input": 100, "output": 50 } }
```

Any non-zero exit code or invalid JSON is surfaced as an error in the run record.

---

## WintermuteEventSink

`WintermuteEventSink` implements the `EventSink` interface and forwards pipeline events to the Wintermute task management API. Register it in your plugin setup:

```typescript
import { WintermuteEventSink } from 'ripline/integrations/openclaw';

const sink = new WintermuteEventSink({ baseUrl: 'http://localhost:3000' });
// pass sink to the Ripline plugin/scheduler
```

---

## Using the pluggable interfaces

The OpenClaw integration is built on top of Ripline's core pluggable interfaces — the same interfaces you can use to build any custom integration:

| Interface | Purpose |
|-----------|---------|
| `RunnerRegistry` | Map runner type strings to `AgentRunner` implementations |
| `EventSink` | Receive pipeline events (started, completed, errored) |
| `QueueStore` | Persist and load background queue items |

All three are exported from `src/interfaces/`. Built-in implementations include `DefaultRunnerRegistry`, `NoopEventSink`, `ConsoleEventSink`, `WebhookEventSink`, `MemoryQueueStore`, and `YamlFileQueueStore`.

---

## Source location

```
src/integrations/openclaw/
├── index.ts               # re-exports and registerOpenClawRunner helper
├── openclaw-runner.ts     # createOpenClawAgentRunner + OpenClawPluginApi type
└── wintermute-event-sink.ts  # WintermuteEventSink
```

---

## Further reading

- [Agent integration](../agent-integration) — runner selection, Claude Code runner, LLM runner
- [Migrating pipelines from OpenClaw](../migrating-from-openclaw) — parameterise hardcoded paths and move to profiles
- [Configuration reference](../configuration) — plugin config fields
