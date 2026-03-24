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
