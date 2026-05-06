import { describe, expect, it, vi } from "vitest";
import { MemoryRunStore } from "../src/run-store-memory.js";
import { createRunQueue } from "../src/run-queue.js";
import { createScheduler } from "../src/scheduler.js";
import type { DetailedSchedulerMetrics } from "../src/scheduler.js";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import type { RecoverStaleRunsOptions } from "../src/run-store.js";
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

const noopAgent: AgentRunner = {
  async *run() {
    yield { type: "message_done" as const, text: "ok" };
  },
};

describe("Scheduler", () => {
  it("start is idempotent and startup stale recovery is ownerPid-gated", async () => {
    class SpyStore extends MemoryRunStore {
      public recoverCalls: RecoverStaleRunsOptions[] = [];

      async recoverStaleRuns(options?: RecoverStaleRunsOptions): Promise<number> {
        this.recoverCalls.push(options ?? {});
        return super.recoverStaleRuns(options);
      }
    }

    const store = new SpyStore();
    const queue = createRunQueue(store);
    const scheduler = createScheduler({
      store,
      queue,
      registry: stubRegistry,
      maxConcurrency: 1,
      agentRunner: noopAgent,
    });

    scheduler.start();
    scheduler.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(store.recoverCalls).toHaveLength(1);
    expect(store.recoverCalls[0]).toMatchObject({ limit: 100, requireOwnerPid: true });

    scheduler.stop();
    await new Promise((r) => setTimeout(r, 20));

    scheduler.start();
    await new Promise((r) => setTimeout(r, 60));
    expect(store.recoverCalls).toHaveLength(2);
    expect(store.recoverCalls[1]).toMatchObject({ limit: 100, requireOwnerPid: true });

    scheduler.stop();
  });

  it("bounds startup stale-run recovery to 100 runs", async () => {
    const store = new MemoryRunStore();
    const recoverSpy = vi.spyOn(store, "recoverStaleRuns");
    const queue = createRunQueue(store);
    const scheduler = createScheduler({
      store,
      queue,
      registry: stubRegistry,
      maxConcurrency: 1,
      agentRunner: noopAgent,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 10));
    scheduler.stop();

    expect(recoverSpy).toHaveBeenCalledWith({ limit: 100, requireOwnerPid: true });
  });

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

  it("resumes parent run when all child runs are terminal (one completed, one errored)", async () => {
    const childDef: PipelineDefinition = {
      id: "child-may-fail",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        {
          id: "b",
          type: "transform",
          expression: "(function(){ var t = (artifacts.a && artifacts.a.task) ? artifacts.a.task : {}; if (t.id === \"t2\") throw new Error(\"intentional fail\"); return t.id; })()",
          assigns: "out",
        },
        { id: "c", type: "output", path: "out", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "c" } },
      ],
    };
    const parentDef: PipelineDefinition = {
      id: "parent-partial-fail",
      entry: ["tasks"],
      nodes: [
        {
          id: "tasks",
          type: "transform",
          expression: "[{ id: 't1', title: 'One' }, { id: 't2', title: 'Two' }]",
          assigns: "tasks",
        },
        {
          id: "enq",
          type: "enqueue",
          pipelineId: "child-may-fail",
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
        if (id === "child-may-fail") return { definition: childDef, mtimeMs: 0, path: "" };
        if (id === "parent-partial-fail") return { definition: parentDef, mtimeMs: 0, path: "" };
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

    const parentRunId = await queue.enqueue("parent-partial-fail", {});
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
    expect(parentRecord?.childRunIds).toHaveLength(2);
    const children = await Promise.all((parentRecord!.childRunIds ?? []).map((id) => store.load(id)));
    const completed = children.filter((r) => r?.status === "completed");
    const errored = children.filter((r) => r?.status === "errored");
    expect(completed).toHaveLength(1);
    expect(errored).toHaveLength(1);
    expect(errored[0]?.error).toContain("intentional fail");
  });

  it("getDetailedMetrics returns per-queue breakdown with multiple queues", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);

    // Enqueue runs into different queues
    await queue.enqueue("minimal", {});                         // default queue
    await queue.enqueue("minimal", {});                         // default queue
    await queue.enqueue("minimal", {}, { queueName: "build" }); // build queue
    await queue.enqueue("minimal", {}, { queueName: "build" }); // build queue
    await queue.enqueue("minimal", {}, { queueName: "build" }); // build queue

    const scheduler = createScheduler({
      store,
      queue,
      registry: stubRegistry,
      maxConcurrency: 1,
      queueConcurrencies: { build: 2 },
      agentRunner: noopAgent,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 200));
    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));

    // All runs should have completed
    const allRuns = await store.list();
    const completedRuns = allRuns.filter((r) => r.status === "completed");
    expect(completedRuns.length).toBe(5);

    // Check detailed metrics
    const detailed = await scheduler.getDetailedMetrics();

    // Aggregate fields remain backward compatible
    expect(detailed.queueDepth).toBe(0);
    expect(detailed.activeWorkers).toBe(0);
    expect(detailed.completedRunsCount).toBe(5);
    expect(typeof detailed.avgDurationMs).toBe("number");

    // Per-queue breakdown
    expect(detailed.queues).toBeDefined();
    expect(detailed.queues["default"]).toBeDefined();
    expect(detailed.queues["build"]).toBeDefined();

    // Default queue: 1 concurrency, 2 completed
    expect(detailed.queues["default"].maxConcurrency).toBe(1);
    expect(detailed.queues["default"].completedRunsCount).toBe(2);
    expect(detailed.queues["default"].activeWorkers).toBe(0);
    expect(detailed.queues["default"].depth).toBe(0);

    // Build queue: 2 concurrency, 3 completed
    expect(detailed.queues["build"].maxConcurrency).toBe(2);
    expect(detailed.queues["build"].completedRunsCount).toBe(3);
    expect(detailed.queues["build"].activeWorkers).toBe(0);
    expect(detailed.queues["build"].depth).toBe(0);
  });

  it("getMetrics remains backward compatible with per-queue tracking", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    await queue.enqueue("minimal", {});
    await queue.enqueue("minimal", {}, { queueName: "build" });

    const scheduler = createScheduler({
      store,
      queue,
      registry: stubRegistry,
      maxConcurrency: 1,
      queueConcurrencies: { build: 1 },
      agentRunner: noopAgent,
    });

    scheduler.start();
    await new Promise((r) => setTimeout(r, 100));
    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));

    const m = await scheduler.getMetrics();
    expect(m.queueDepth).toBe(0);
    expect(m.activeWorkers).toBe(0);
    expect(m.completedRunsCount).toBe(2);
    expect(typeof m.avgDurationMs).toBe("number");
    // Should not have queues property on basic metrics
    expect((m as any).queues).toBeUndefined();
  });
});
