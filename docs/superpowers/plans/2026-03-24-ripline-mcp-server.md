# Ripline Embedded MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stdio MCP server to Ripline that embeds the pipeline engine and exposes 6 tools to Claude Code — no separate HTTP server required.

**Architecture:** New files only: `src/mcp/config.ts` (config + runner resolution), `src/mcp/tools.ts` (tool handlers), `src/mcp/server.ts` (MCP wiring), `src/mcp-server.ts` (entry point). The entry point composes existing `PipelineRunStore`, `RunQueue`, `PipelineRegistry`, `createScheduler`, and agent runners — all unchanged.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, Vitest (existing), CommonJS build output

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `package.json` | Modify | Add `@modelcontextprotocol/sdk` production dependency |
| `src/mcp/config.ts` | Create | CLI arg parsing, config resolution, agent runner selection |
| `src/mcp/tools.ts` | Create | 6 tool handler functions |
| `src/mcp/server.ts` | Create | MCP Server instance + tool registration |
| `src/mcp-server.ts` | Create | Entry point with shebang |
| `tests/mcp/config.test.ts` | Create | Unit tests for config resolution |
| `tests/mcp/tools.test.ts` | Create | Unit tests for tool handlers |
| `tests/mcp/integration.test.ts` | Create | Integration test via hello-world pipeline |

---

## Task 1: Install MCP SDK Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install the SDK**

```bash
cd /home/openclaw/ripline
npm install @modelcontextprotocol/sdk
```

Expected: `@modelcontextprotocol/sdk` appears in `package.json` `dependencies`.

- [ ] **Step 2: Verify build still passes**

```bash
npm run build
```

Expected: `dist/` compiles without errors.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @modelcontextprotocol/sdk dependency"
```

---

## Task 2: Config Module

**Files:**
- Create: `src/mcp/config.ts`
- Create: `tests/mcp/config.test.ts`

### What this module does

Parses `process.argv` for `--pipelines-dir`, `--runs-dir`, `--max-concurrency`. Falls back to `loadUserConfig()` for `pipelinesDir` (reads `pipelineDir` key). `runsDir` is CLI-only (not in `RiplineUserConfig`). Provides `resolveStandaloneAgentRunner()` that returns an `AgentRunner` (LLM or stub).

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/config.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";

// We test resolveMcpConfig by passing argv arrays directly
import { resolveMcpConfig } from "../../src/mcp/config.js";

describe("resolveMcpConfig", () => {
  it("returns defaults when no args and no user config", () => {
    const cfg = resolveMcpConfig([], os.homedir());
    expect(cfg.runsDir).toBe(".ripline/runs");
    expect(cfg.maxConcurrency).toBe(4);
    expect(typeof cfg.pipelinesDir).toBe("string");
  });

  it("CLI --pipelines-dir overrides default", () => {
    const cfg = resolveMcpConfig(["--pipelines-dir", "/tmp/mypipes"], os.homedir());
    expect(cfg.pipelinesDir).toBe("/tmp/mypipes");
  });

  it("CLI --runs-dir sets runsDir (not from user config)", () => {
    const cfg = resolveMcpConfig(["--runs-dir", "/tmp/runs"], os.homedir());
    expect(cfg.runsDir).toBe("/tmp/runs");
  });

  it("CLI --max-concurrency parses integer", () => {
    const cfg = resolveMcpConfig(["--max-concurrency", "8"], os.homedir());
    expect(cfg.maxConcurrency).toBe(8);
  });

  it("ignores unknown flags", () => {
    expect(() => resolveMcpConfig(["--unknown", "val"], os.homedir())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/openclaw/ripline && npx vitest run tests/mcp/config.test.ts
```

Expected: FAIL — `src/mcp/config.ts` does not exist yet.

- [ ] **Step 3: Implement `src/mcp/config.ts`**

```typescript
import path from "node:path";
import os from "node:os";
import { resolvePipelineDir, loadUserConfig } from "../config.js";
import { resolveStandaloneLlmAgentConfig } from "../agent-runner-config.js";
import { createLlmAgentRunner } from "../llm-agent-runner.js";
import type { AgentRunner } from "../pipeline/executors/agent.js";

export type McpServerConfig = {
  pipelinesDir: string;
  runsDir: string;
  maxConcurrency: number;
};

/**
 * Parse CLI args and resolve final MCP server config.
 * runsDir is CLI-only — it does not exist on RiplineUserConfig.
 * pipelinesDir: CLI --pipelines-dir > ~/.ripline/config.json pipelineDir > default.
 */
export function resolveMcpConfig(argv: string[] = process.argv.slice(2), homedir: string = os.homedir()): McpServerConfig {
  let pipelinesDirFlag: string | undefined;
  let runsDir: string | undefined;
  let maxConcurrency = 4;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pipelines-dir" && argv[i + 1]) {
      pipelinesDirFlag = argv[++i];
    } else if (arg === "--runs-dir" && argv[i + 1]) {
      runsDir = argv[++i];
    } else if (arg === "--max-concurrency" && argv[i + 1]) {
      const n = parseInt(argv[++i]!, 10);
      if (Number.isInteger(n) && n > 0) maxConcurrency = n;
    }
  }

  const pipelinesDir = resolvePipelineDir({ flag: pipelinesDirFlag, homedir });

  return {
    pipelinesDir,
    runsDir: runsDir ?? ".ripline/runs",
    maxConcurrency,
  };
}

/**
 * Build the agent runner for non-claude-code nodes.
 * Returns LlmAgentRunner when credentials are configured, stub runner otherwise.
 * Logs a warning to stderr when falling back to stub.
 */
export function resolveStandaloneAgentRunner(): AgentRunner {
  const llmConfig = resolveStandaloneLlmAgentConfig();
  if (llmConfig) {
    return createLlmAgentRunner(llmConfig);
  }
  process.stderr.write("[ripline-mcp] no LLM runner configured, using stub for agent nodes\n");
  return async (params) => ({
    text: `[stub] no LLM runner configured (agentId: ${params.agentId})`,
  });
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/openclaw/ripline && npx vitest run tests/mcp/config.test.ts
```

Expected: All 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/config.ts tests/mcp/config.test.ts
git commit -m "feat: add MCP server config resolution module"
```

---

## Task 3: Tools Module

**Files:**
- Create: `src/mcp/tools.ts`
- Create: `tests/mcp/tools.test.ts`

### What this module does

Six exported async functions, each taking a `McpToolContext` + validated args. Returns plain objects (serialized to JSON string by the server layer). Uses `MemoryRunStore` in tests for isolation.

- [ ] **Step 1: Write the failing tests**

Create `tests/mcp/tools.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { MemoryRunStore } from "../../src/run-store-memory.js";
import { createRunQueue } from "../../src/run-queue.js";
import { PipelineRegistry } from "../../src/registry.js";
import type { McpToolContext } from "../../src/mcp/tools.js";
import {
  handleListPipelines,
  handleRunPipeline,
  handleGetRun,
  handleGetRunLogs,
  handleListRuns,
  handleResumeRun,
} from "../../src/mcp/tools.js";

// Minimal valid pipeline definition
const helloWorldDef = {
  id: "hello_world",
  name: "Hello World",
  tags: ["test"],
  entry: ["intake"],
  nodes: [
    { id: "intake", type: "input" },
    { id: "out", type: "output", path: "result", source: "intake" },
  ],
  edges: [{ from: { node: "intake" }, to: { node: "out" } }],
};

// Stub registry that returns a single pipeline
const stubRegistry = {
  list: async () => [helloWorldDef as never],
  get: async (id: string) =>
    id === "hello_world"
      ? { definition: helloWorldDef as never, mtimeMs: 0, path: "" }
      : null,
} as unknown as PipelineRegistry;

function makeCtx(): McpToolContext {
  const store = new MemoryRunStore();
  const queue = createRunQueue(store);
  return { registry: stubRegistry, queue, store };
}

describe("handleListPipelines", () => {
  it("returns pipeline summaries", async () => {
    const result = await handleListPipelines(makeCtx());
    expect(Array.isArray(result)).toBe(true);
    const [p] = result as Array<{ id: string; name: string; tags: string[]; nodeCount: number; edgeCount: number }>;
    expect(p!.id).toBe("hello_world");
    expect(p!.nodeCount).toBe(2);
    expect(p!.edgeCount).toBe(1);
  });
});

describe("handleRunPipeline", () => {
  it("enqueues run and returns runId + status pending", async () => {
    const ctx = makeCtx();
    const result = await handleRunPipeline(ctx, { pipeline_id: "hello_world", inputs: {} });
    expect(typeof (result as { runId: string }).runId).toBe("string");
    expect((result as { status: string }).status).toBe("pending");
  });

  it("returns error for unknown pipeline", async () => {
    const result = await handleRunPipeline(makeCtx(), { pipeline_id: "no_such" });
    expect((result as { error: string }).error).toMatch(/not found/);
  });
});

describe("handleGetRun", () => {
  it("returns run record for existing run", async () => {
    const ctx = makeCtx();
    const { runId } = await handleRunPipeline(ctx, { pipeline_id: "hello_world" }) as { runId: string };
    const result = await handleGetRun(ctx, { run_id: runId });
    expect((result as { id: string }).id).toBe(runId);
    expect((result as { pipelineId: string }).pipelineId).toBe("hello_world");
  });

  it("returns error for unknown run", async () => {
    const result = await handleGetRun(makeCtx(), { run_id: "nonexistent" });
    expect((result as { error: string }).error).toMatch(/not found/);
  });
});

describe("handleGetRunLogs", () => {
  it("returns empty string when no log file (in-memory store has no log files)", async () => {
    const ctx = makeCtx();
    const { runId } = await handleRunPipeline(ctx, { pipeline_id: "hello_world" }) as { runId: string };
    const result = await handleGetRunLogs(ctx, { run_id: runId });
    expect((result as { logs: string }).logs).toBe("");
  });

  it("returns error for unknown run", async () => {
    const result = await handleGetRunLogs(makeCtx(), { run_id: "nonexistent" });
    expect((result as { error: string }).error).toMatch(/not found/);
  });
});

describe("handleListRuns", () => {
  it("returns runs, filtered by pipeline_id in-memory", async () => {
    const ctx = makeCtx();
    await handleRunPipeline(ctx, { pipeline_id: "hello_world" });
    const result = await handleListRuns(ctx, { pipeline_id: "hello_world" });
    expect((result as unknown[]).length).toBe(1);
  });

  it("returns empty array for unknown pipeline_id filter", async () => {
    const ctx = makeCtx();
    await handleRunPipeline(ctx, { pipeline_id: "hello_world" });
    const result = await handleListRuns(ctx, { pipeline_id: "other" });
    expect((result as unknown[]).length).toBe(0);
  });

  it("applies limit", async () => {
    const ctx = makeCtx();
    for (let i = 0; i < 5; i++) {
      await handleRunPipeline(ctx, { pipeline_id: "hello_world" });
    }
    const result = await handleListRuns(ctx, { limit: 2 });
    expect((result as unknown[]).length).toBe(2);
  });
});

describe("handleResumeRun", () => {
  it("returns error for completed run", async () => {
    // Create a run and manually complete it via store
    const ctx = makeCtx();
    const { runId } = await handleRunPipeline(ctx, { pipeline_id: "hello_world" }) as { runId: string };
    const record = await ctx.store.load(runId);
    await ctx.store.completeRun(record!);
    const result = await handleResumeRun(ctx, { run_id: runId });
    expect((result as { error: string }).error).toMatch(/not resumable/);
  });

  it("returns error for running run", async () => {
    const ctx = makeCtx();
    const { runId } = await handleRunPipeline(ctx, { pipeline_id: "hello_world" }) as { runId: string };
    // Claim it (sets status to running)
    await ctx.store.claimRun(runId);
    const result = await handleResumeRun(ctx, { run_id: runId });
    expect((result as { error: string }).error).toMatch(/not resumable/);
  });

  it("returns error for unknown run", async () => {
    const result = await handleResumeRun(makeCtx(), { run_id: "nonexistent" });
    expect((result as { error: string }).error).toMatch(/not found/);
  });

  it("re-queues errored run and returns pending status", async () => {
    const ctx = makeCtx();
    const { runId } = await handleRunPipeline(ctx, { pipeline_id: "hello_world" }) as { runId: string };
    const record = await ctx.store.load(runId);
    await ctx.store.failRun(record!, "test error");
    const result = await handleResumeRun(ctx, { run_id: runId });
    expect((result as { runId: string }).runId).toBe(runId);
    expect((result as { status: string }).status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /home/openclaw/ripline && npx vitest run tests/mcp/tools.test.ts
```

Expected: FAIL — `src/mcp/tools.ts` does not exist yet.

- [ ] **Step 3: Implement `src/mcp/tools.ts`**

```typescript
import { promises as fs } from "node:fs";
import path from "node:path";
import type { PipelineRegistry } from "../registry.js";
import type { RunQueue } from "../run-queue.js";
import type { RunStore } from "../run-store.js";
import type { PipelineRunRecord } from "../types.js";

export type McpToolContext = {
  registry: PipelineRegistry;
  queue: RunQueue;
  store: RunStore;
  /** Optional: path to the runs directory, used to read log files. */
  runsDir?: string;
};

// ---------------------------------------------------------------------------
// list_pipelines
// ---------------------------------------------------------------------------

export async function handleListPipelines(ctx: McpToolContext): Promise<unknown> {
  const pipelines = await ctx.registry.list();
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    tags: p.tags ?? [],
    nodeCount: p.nodes.length,
    edgeCount: p.edges.length,
  }));
}

// ---------------------------------------------------------------------------
// run_pipeline
// ---------------------------------------------------------------------------

type RunPipelineArgs = {
  pipeline_id: string;
  inputs?: Record<string, unknown>;
  env?: Record<string, string>;
};

export async function handleRunPipeline(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { pipeline_id, inputs = {}, env: _env = {} } = args as RunPipelineArgs;

  const entry = await ctx.registry.get(pipeline_id);
  if (!entry) {
    return { error: `pipeline not found: ${pipeline_id}` };
  }

  const runId = await ctx.queue.enqueue(pipeline_id, inputs);
  return { runId: runId as string, status: "pending" };
}

// ---------------------------------------------------------------------------
// get_run
// ---------------------------------------------------------------------------

export async function handleGetRun(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { run_id } = args as { run_id: string };
  const record = await ctx.store.load(run_id);
  if (!record) {
    return { error: `run not found: ${run_id}` };
  }
  return record;
}

// ---------------------------------------------------------------------------
// get_run_logs
// ---------------------------------------------------------------------------

export async function handleGetRunLogs(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { run_id } = args as { run_id: string };

  const record = await ctx.store.load(run_id);
  if (!record) {
    return { error: `run not found: ${run_id}` };
  }

  if (!ctx.runsDir) {
    // In-memory store has no log files
    return { logs: "" };
  }

  const logPath = path.join(ctx.runsDir, run_id, "log.txt");
  try {
    const logs = await fs.readFile(logPath, "utf8");
    return { logs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { logs: "" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// list_runs
// ---------------------------------------------------------------------------

type ListRunsArgs = {
  pipeline_id?: string;
  status?: "pending" | "running" | "paused" | "errored" | "completed";
  limit?: number;
};

export async function handleListRuns(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { pipeline_id, status, limit = 20 } = (args ?? {}) as ListRunsArgs;

  // Store already sorts: pending/running FIFO, others updatedAt desc
  let runs = await ctx.store.list(status !== undefined ? { status } : undefined);

  if (pipeline_id !== undefined) {
    runs = runs.filter((r) => r.pipelineId === pipeline_id);
  }

  return runs.slice(0, limit).map((r) => ({
    id: r.id,
    pipelineId: r.pipelineId,
    status: r.status,
    startedAt: r.startedAt,
  }));
}

// ---------------------------------------------------------------------------
// resume_run
// ---------------------------------------------------------------------------

export async function handleResumeRun(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { run_id } = args as { run_id: string };

  const record = await ctx.store.load(run_id);
  if (!record) {
    return { error: `run not found: ${run_id}` };
  }

  const NON_RESUMABLE = new Set<string>(["completed", "running", "pending"]);
  if (NON_RESUMABLE.has(record.status)) {
    return { error: `run is not resumable (status: ${record.status})` };
  }

  // Reset to pending so the scheduler picks it up and resumes from cursor
  record.status = "pending";
  await ctx.store.save(record);

  return { runId: run_id, status: "pending" };
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /home/openclaw/ripline && npx vitest run tests/mcp/tools.test.ts
```

Expected: All 12 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools.ts tests/mcp/tools.test.ts
git commit -m "feat: add MCP tool handlers"
```

---

## Task 4: MCP Server Module

**Files:**
- Create: `src/mcp/server.ts`

This module wires tools into an MCP `Server` instance. There's no complex logic here — it registers `ListToolsRequestSchema` and `CallToolRequestSchema` handlers that delegate to the tool functions. No separate unit test; correctness is covered by the integration test.

- [ ] **Step 1: Implement `src/mcp/server.ts`**

```typescript
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpToolContext } from "./tools.js";
import {
  handleListPipelines,
  handleRunPipeline,
  handleGetRun,
  handleGetRunLogs,
  handleListRuns,
  handleResumeRun,
} from "./tools.js";

const TOOL_DEFINITIONS = [
  {
    name: "list_pipelines",
    description: "List all available Ripline pipelines",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_pipeline",
    description: "Trigger a Ripline pipeline run. Returns immediately with a runId.",
    inputSchema: {
      type: "object",
      required: ["pipeline_id"],
      properties: {
        pipeline_id: { type: "string", description: "Pipeline ID to run" },
        inputs: { type: "object", description: "Input payload for the pipeline entry node" },
        env: { type: "object", description: "Environment variables for this run" },
      },
    },
  },
  {
    name: "get_run",
    description: "Get the full status and output of a pipeline run by runId",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
      },
    },
  },
  {
    name: "get_run_logs",
    description: "Get the log output for a pipeline run",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
      },
    },
  },
  {
    name: "list_runs",
    description: "List recent pipeline runs, optionally filtered by pipeline_id or status",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "paused", "errored", "completed"] },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "resume_run",
    description: "Re-queue an errored or paused run from where it stopped",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
      },
    },
  },
];

export function createMcpServer(ctx: McpToolContext): Server {
  const server = new Server(
    { name: "ripline", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result: unknown;

    switch (name) {
      case "list_pipelines":
        result = await handleListPipelines(ctx);
        break;
      case "run_pipeline":
        result = await handleRunPipeline(ctx, args);
        break;
      case "get_run":
        result = await handleGetRun(ctx, args);
        break;
      case "get_run_logs":
        result = await handleGetRunLogs(ctx, args);
        break;
      case "list_runs":
        result = await handleListRuns(ctx, args);
        break;
      case "resume_run":
        result = await handleResumeRun(ctx, args);
        break;
      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
          isError: true,
        };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}
```

- [ ] **Step 2: Run build to verify types**

```bash
cd /home/openclaw/ripline && npm run build
```

Expected: Compiles to `dist/` without errors.

- [ ] **Step 3: Commit**

```bash
git add src/mcp/server.ts
git commit -m "feat: add MCP server module with tool registration"
```

---

## Task 5: Entry Point

**Files:**
- Create: `src/mcp-server.ts`

- [ ] **Step 1: Implement `src/mcp-server.ts`**

```typescript
#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PipelineRunStore } from "./run-store.js";
import { createRunQueue } from "./run-queue.js";
import { PipelineRegistry } from "./registry.js";
import { createScheduler } from "./scheduler.js";
import { resolveMcpConfig, resolveStandaloneAgentRunner } from "./mcp/config.js";
import { createMcpServer } from "./mcp/server.js";
import type { McpToolContext } from "./mcp/tools.js";

async function main() {
  const config = resolveMcpConfig();

  const store = new PipelineRunStore(config.runsDir);
  await store.init();

  const queue = createRunQueue(store);
  const registry = new PipelineRegistry(config.pipelinesDir);
  const agentRunner = resolveStandaloneAgentRunner();

  const scheduler = createScheduler({
    store,
    queue,
    registry,
    maxConcurrency: config.maxConcurrency,
    agentRunner,
  });

  scheduler.start();

  const ctx: McpToolContext = {
    registry,
    queue,
    store,
    runsDir: config.runsDir,
  };

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = () => {
    scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[ripline-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
```

- [ ] **Step 2: Build**

```bash
cd /home/openclaw/ripline && npm run build
```

Expected: `dist/mcp-server.js` created alongside `dist/` other files. No errors.

- [ ] **Step 3: Quick smoke test — verify the server starts**

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/mcp-server.js --pipelines-dir ./pipelines/examples 2>/dev/null
```

Expected: JSON response with `tools` array containing 6 entries (`list_pipelines`, `run_pipeline`, `get_run`, `get_run_logs`, `list_runs`, `resume_run`). Process may hang waiting for more input — that's correct stdio behaviour. Kill with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add src/mcp-server.ts
git commit -m "feat: add MCP server entry point"
```

---

## Task 6: Integration Test

**Files:**
- Create: `tests/mcp/integration.test.ts`

This test uses `PipelineRunStore` (file-based) + the hello-world pipeline. It runs the pipeline through the scheduler and polls `get_run` until completed.

- [ ] **Step 1: Write the integration test**

Create `tests/mcp/integration.test.ts`:

```typescript
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PipelineRunStore } from "../../src/run-store.js";
import { createRunQueue } from "../../src/run-queue.js";
import { PipelineRegistry } from "../../src/registry.js";
import { createScheduler } from "../../src/scheduler.js";
import type { AgentRunner } from "../../src/pipeline/executors/agent.js";
import type { McpToolContext } from "../../src/mcp/tools.js";
import { handleListPipelines, handleRunPipeline, handleGetRun } from "../../src/mcp/tools.js";

// Use process.cwd() instead of __dirname — Vitest runs in ESM context where __dirname is not available
const PIPELINES_DIR = path.resolve(process.cwd(), "pipelines/examples");
const RUNS_DIR = path.join(os.tmpdir(), `ripline-mcp-test-${randomUUID()}`);

const noopAgent: AgentRunner = async () => ({ text: "ok" });

let scheduler: ReturnType<typeof createScheduler>;
let ctx: McpToolContext;

// setup() called in beforeAll so both tests share a single initialized context
beforeAll(async () => {
  const store = new PipelineRunStore(RUNS_DIR);
  await store.init();
  const queue = createRunQueue(store);
  const registry = new PipelineRegistry(PIPELINES_DIR);
  scheduler = createScheduler({ store, queue, registry, maxConcurrency: 2, agentRunner: noopAgent });
  scheduler.start();
  ctx = { registry, queue, store, runsDir: RUNS_DIR };
});

afterAll(async () => {
  scheduler?.stop();
  await fs.rm(RUNS_DIR, { recursive: true, force: true });
});

describe("MCP integration: hello_world pipeline", () => {
  it("list_pipelines includes hello_world", async () => {
    const result = await handleListPipelines(ctx) as Array<{ id: string }>;
    expect(result.some((p) => p.id === "hello_world")).toBe(true);
  });

  it("run_pipeline → poll get_run until completed", async () => {
    const { runId } = await handleRunPipeline(ctx, {
      pipeline_id: "hello_world",
      inputs: { person: "World", goal: "test" },
    }) as { runId: string };

    expect(typeof runId).toBe("string");

    // Poll until completed or errored (max 10s)
    const deadline = Date.now() + 10_000;
    let run: { status: string; outputs?: unknown } | null = null;
    while (Date.now() < deadline) {
      run = await handleGetRun(ctx, { run_id: runId }) as { status: string; outputs?: unknown };
      if (run.status === "completed" || run.status === "errored") break;
      await new Promise((r) => setTimeout(r, 200));
    }

    expect(run?.status).toBe("completed");
  });
});
```

- [ ] **Step 2: Run the integration test**

```bash
cd /home/openclaw/ripline && npx vitest run tests/mcp/integration.test.ts
```

Expected: Both tests pass. The scheduler picks up the hello_world run and completes it (it's a transform pipeline — no agent nodes — so it finishes immediately).

- [ ] **Step 3: Run full test suite to check for regressions**

```bash
cd /home/openclaw/ripline && npm test
```

Expected: All existing tests plus new MCP tests pass. No regressions.

- [ ] **Step 4: Commit**

```bash
git add tests/mcp/integration.test.ts
git commit -m "test: add MCP server integration test"
```

---

## Task 7: Claude Code MCP Config

**Files:**
- Modify: `~/.claude/settings.json`

- [ ] **Step 1: Add ripline MCP server to Claude Code settings**

Read current `~/.claude/settings.json`, then add or merge the `mcpServers.ripline` entry:

```json
{
  "mcpServers": {
    "ripline": {
      "type": "stdio",
      "command": "node",
      "args": ["/home/openclaw/ripline/dist/mcp-server.js"]
    }
  }
}
```

- [ ] **Step 2: Verify Claude Code sees the tools**

Restart Claude Code or use `/mcp` to list available servers. Verify `ripline` appears and its 6 tools are listed.

- [ ] **Step 3: Commit final state**

```bash
cd /home/openclaw/ripline
git add -A
git commit -m "feat: Ripline embedded MCP server — complete implementation"
```

---

## Reference

### MCP tool response envelope (Claude Code expects this shape)

```typescript
{
  content: [{ type: "text", text: string }]  // text is JSON-serialized result
  isError?: boolean                            // set true for error responses
}
```

### Key types to know

```typescript
// src/types.ts
type PipelineRunStatus = "pending" | "running" | "paused" | "errored" | "completed";
type PipelineRunStep = { nodeId: string; status: string; startedAt?: number; finishedAt?: number; data?: unknown; error?: string };
type PipelineRunRecord = { id: string; pipelineId: string; status: PipelineRunStatus; startedAt: number; updatedAt: number; inputs: ...; outputs?: ...; steps: PipelineRunStep[]; cursor?: { nextNodeIndex: number; context: ... } };
```

### resumable statuses: `errored`, `paused`
### non-resumable statuses: `completed`, `running`, `pending`

### `createScheduler` returns a plain object (not a class):
```typescript
{ start(): void; stop(): void; getMetrics(): Promise<SchedulerMetrics> }
```
