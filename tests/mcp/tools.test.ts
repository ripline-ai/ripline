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
