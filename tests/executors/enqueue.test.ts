import { describe, expect, it } from "vitest";
import type { EnqueueNode } from "../../src/types.js";
import { executeEnqueue } from "../../src/pipeline/executors/enqueue.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";
import { MemoryRunStore } from "../../src/run-store-memory.js";
import { createRunQueue } from "../../src/run-queue.js";

describe("Enqueue executor", () => {
  it("per-item mode creates one pending run per task and returns childRunIds", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const parentRecord = await store.createRun({
      pipelineId: "parent",
      inputs: {},
    });
    await store.save({ ...parentRecord, status: "running", steps: [] });

    const node: EnqueueNode = {
      id: "enq1",
      type: "enqueue",
      pipelineId: "child-pipeline",
      tasksSource: "tasks",
      mode: "per-item",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {
        tasks: [
          { id: "t1", title: "Story A", detail: "Do A" },
          { id: "t2", title: "Story B", priority: 1 },
        ],
      },
      env: {},
      outputs: {},
      runId: parentRecord.id,
      store,
      queue,
    };

    const result = await executeEnqueue(node, context);

    expect(result.artifactKey).toBe("enq1");
    expect(result.childRunIds).toHaveLength(2);
    expect(result.value).toEqual({ enqueued: result.childRunIds });

    const pending = await store.list({ status: "pending" });
    expect(pending).toHaveLength(2);
    expect(pending.map((r) => r.inputs)).toEqual([{ task: { id: "t1", title: "Story A", detail: "Do A" } }, { task: { id: "t2", title: "Story B", priority: 1 } }]);
    expect(pending.every((r) => r.parentRunId === parentRecord.id && r.taskId !== undefined && r.queueMode === "per-item")).toBe(true);

    const parent = await store.load(parentRecord.id);
    expect(parent?.childRunIds).toEqual(result.childRunIds);
  });

  it("batch mode creates one pending run with full tasks list", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const parentRecord = await store.createRun({
      pipelineId: "parent",
      inputs: {},
    });
    await store.save({ ...parentRecord, status: "running", steps: [] });

    const node: EnqueueNode = {
      id: "enq1",
      type: "enqueue",
      pipelineId: "child-pipeline",
      tasksSource: "tasks",
      mode: "batch",
    };
    const tasks = [
      { id: "t1", title: "Story A" },
      { id: "t2", title: "Story B" },
    ];
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { tasks },
      env: {},
      outputs: {},
      runId: parentRecord.id,
      store,
      queue,
    };

    const result = await executeEnqueue(node, context);

    expect(result.childRunIds).toHaveLength(1);
    const pending = await store.list({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.inputs).toEqual({ tasks });
    expect(pending[0]!.queueMode).toBe("batch");
    expect(pending[0]!.parentRunId).toBe(parentRecord.id);

    const parent = await store.load(parentRecord.id);
    expect(parent?.childRunIds).toEqual(result.childRunIds);
  });

  it("defaults tasksSource to 'tasks' and mode to 'per-item'", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const parentRecord = await store.createRun({ pipelineId: "p", inputs: {} });
    await store.save({ ...parentRecord, status: "running", steps: [] });

    const node: EnqueueNode = {
      id: "enq1",
      type: "enqueue",
      pipelineId: "child",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { tasks: [{ id: "x", title: "One" }] },
      env: {},
      outputs: {},
      runId: parentRecord.id,
      store,
      queue,
    };

    const result = await executeEnqueue(node, context);

    expect(result.childRunIds).toHaveLength(1);
    const pending = await store.list({ status: "pending" });
    expect(pending[0]!.inputs).toEqual({ task: { id: "x", title: "One" } });
  });

  it("throws when runId or queue is missing", async () => {
    const node: EnqueueNode = {
      id: "enq1",
      type: "enqueue",
      pipelineId: "child",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { tasks: [{ id: "x", title: "One" }] },
      env: {},
      outputs: {},
    };

    await expect(executeEnqueue(node, context)).rejects.toThrow(/runId|queue/);
  });

  it("throws when tasks artifact is missing or not an array", async () => {
    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const parentRecord = await store.createRun({ pipelineId: "p", inputs: {} });
    await store.save({ ...parentRecord, status: "running", steps: [] });

    const node: EnqueueNode = {
      id: "enq1",
      type: "enqueue",
      pipelineId: "child",
      tasksSource: "tasks",
    };
    const baseContext: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: parentRecord.id,
      store,
      queue,
    };

    await expect(executeEnqueue(node, baseContext)).rejects.toThrow(/tasks/);

    const badContext: ExecutorContext = { ...baseContext, artifacts: { tasks: "not-array" } };
    await expect(executeEnqueue(node, badContext)).rejects.toThrow(/tasks/);
  });
});
