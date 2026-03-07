import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "../src/run-store-memory.js";
import { createRunQueue } from "../src/run-queue.js";
import { createScheduler } from "../src/scheduler.js";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import type { PipelineDefinition } from "../src/types.js";
import type { AgentRunner } from "../src/pipeline/executors/agent.js";

const minimalDef: PipelineDefinition = {
  id: "minimal",
  entry: ["a"],
  nodes: [
    { id: "a", type: "input" },
    { id: "b", type: "transform", expression: "1" },
    { id: "c", type: "output", path: "out", source: "b" },
  ],
  edges: [
    { from: { node: "a" }, to: { node: "b" } },
    { from: { node: "b" }, to: { node: "c" } },
  ],
};

const stubRegistry = {
  get: async (id: string) =>
    id === "minimal"
      ? { definition: minimalDef, mtimeMs: 0, path: "" }
      : null,
};

const noopAgent: AgentRunner = async () => ({
  text: "ok",
  tokenUsage: { input: 0, output: 0 },
});

describe("Scheduler", () => {
  it("processes at most maxConcurrency runs at a time", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    await queue.enqueue("minimal", {});
    await queue.enqueue("minimal", {});
    await queue.enqueue("minimal", {});
    await queue.enqueue("minimal", {});
    await queue.enqueue("minimal", {});

    const scheduler = createScheduler({
      store,
      queue,
      registry: stubRegistry,
      maxConcurrency: 2,
      agentRunner: noopAgent,
    });
    const activeCounts: number[] = [];
    const interval = setInterval(async () => {
      const m = await scheduler.getMetrics();
      activeCounts.push(m.activeWorkers);
    }, 5);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 80));
    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));
    clearInterval(interval);

    const maxActive = Math.max(...activeCounts);
    expect(maxActive).toBeLessThanOrEqual(2);
    const runs = await store.list();
    const completed = runs.filter((r) => r.status === "completed");
    expect(completed.length).toBe(5);
  });

  it("getMetrics returns queueDepth, activeWorkers, and avgDurationMs", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const scheduler = createScheduler({
      store,
      queue,
      registry: stubRegistry,
      maxConcurrency: 1,
      agentRunner: noopAgent,
    });
    expect((await scheduler.getMetrics()).queueDepth).toBe(0);
    expect((await scheduler.getMetrics()).activeWorkers).toBe(0);
    await queue.enqueue("minimal", {});
    expect(await queue.depth()).toBe(1);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 60));
    scheduler.stop();
    await new Promise((r) => setTimeout(r, 30));
    const m = await scheduler.getMetrics();
    expect(m.queueDepth).toBe(0);
    expect(m.activeWorkers).toBe(0);
    if (m.completedRunsCount !== undefined && m.completedRunsCount > 0) {
      expect(typeof m.avgDurationMs).toBe("number");
    }
  });

  it("resumes parent run when all child runs complete (enqueue → per-item)", async () => {
    const childDef: PipelineDefinition = {
      id: "child-pipeline",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "inputs.task ? inputs.task.id : 'batch'" },
        { id: "c", type: "output", path: "out", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "c" } },
      ],
    };
    const parentDef: PipelineDefinition = {
      id: "parent-with-enqueue",
      entry: ["tasks"],
      nodes: [
        {
          id: "tasks",
          type: "transform",
          expression: "[{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }, { id: 't3', title: 'Three' }]",
          assigns: "tasks",
        },
        {
          id: "enq",
          type: "enqueue",
          pipelineId: "child-pipeline",
          tasksSource: "tasks",
          mode: "per-item",
        },
        { id: "after", type: "output", path: "done", source: "enq" },
      ],
      edges: [
        { from: { node: "tasks" }, to: { node: "enq" } },
        { from: { node: "enq" }, to: { node: "after" } },
      ],
    };
    const registry = {
      get: async (id: string) => {
        if (id === "minimal") return { definition: minimalDef, mtimeMs: 0, path: "" };
        if (id === "child-pipeline") return { definition: childDef, mtimeMs: 0, path: "" };
        if (id === "parent-with-enqueue") return { definition: parentDef, mtimeMs: 0, path: "" };
        return null;
      },
    };

    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const scheduler = createScheduler({
      store,
      queue,
      registry,
      maxConcurrency: 2,
      agentRunner: noopAgent,
    });

    const parentRunId = await queue.enqueue("parent-with-enqueue", {});
    scheduler.start();

    const deadline = Date.now() + 5000;
    let parentRecord = await store.load(parentRunId);
    while (parentRecord?.status !== "completed" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 30));
      parentRecord = await store.load(parentRunId);
    }

    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));

    expect(parentRecord?.status).toBe("completed");
    expect(parentRecord?.childRunIds).toHaveLength(3);
    const children = await Promise.all((parentRecord!.childRunIds ?? []).map((id) => store.load(id)));
    expect(children.every((r) => r?.status === "completed")).toBe(true);
  });
});
