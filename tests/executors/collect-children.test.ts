import { describe, expect, it } from "vitest";
import type { CollectChildrenNode } from "../../src/types.js";
import { executeCollectChildren } from "../../src/pipeline/executors/collect-children.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";
import { MemoryRunStore } from "../../src/run-store-memory.js";

describe("CollectChildren executor", () => {
  it("returns childResults and summary with mixed completed and errored children", async () => {
    const store = new MemoryRunStore();
    const parentRecord = await store.createRun({ pipelineId: "parent", inputs: {} });
    const child1 = await store.createRun({
      pipelineId: "child-pipeline",
      inputs: { task: { id: "t1", title: "Story A" } },
      parentRunId: parentRecord.id,
      taskId: "t1",
      queueMode: "per-item",
    });
    const child2 = await store.createRun({
      pipelineId: "child-pipeline",
      inputs: { task: { id: "t2", title: "Story B" } },
      parentRunId: parentRecord.id,
      taskId: "t2",
      queueMode: "per-item",
    });
    await store.completeRun(child1, { out: "done", taskId: "t1" });
    await store.failRun(child2, "Build failed");
    await store.save({
      ...parentRecord,
      status: "paused",
      childRunIds: [child1.id, child2.id],
      steps: [],
    });

    const node: CollectChildrenNode = { id: "collect", type: "collect_children" };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: parentRecord.id,
      store,
    };

    const result = await executeCollectChildren(node, context);

    expect(result.artifactKey).toBe("collect");
    expect(result.value).toEqual({
      childResults: [
        { id: child1.id, taskId: "t1", status: "completed", outputs: { out: "done", taskId: "t1" } },
        { id: child2.id, taskId: "t2", status: "errored", error: "Build failed" },
      ],
      summary: { completed: 1, errored: 1, total: 2 },
    });
    expect(context.artifacts.collect).toEqual(result.value);
  });

  it("returns empty childResults and zero summary when parent has no childRunIds", async () => {
    const store = new MemoryRunStore();
    const parentRecord = await store.createRun({ pipelineId: "parent", inputs: {} });
    await store.save({ ...parentRecord, status: "running", childRunIds: [], steps: [] });

    const node: CollectChildrenNode = { id: "collect", type: "collect_children" };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: parentRecord.id,
      store,
    };

    const result = await executeCollectChildren(node, context);

    expect(result.artifactKey).toBe("collect");
    expect(result.value).toEqual({
      childResults: [],
      summary: { completed: 0, errored: 0, total: 0 },
    });
  });

  it("throws when runId or store is missing", async () => {
    const node: CollectChildrenNode = { id: "collect", type: "collect_children" };
    const contextNoRunId: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      store: new MemoryRunStore(),
    };
    const contextNoStore: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "some-id",
    };

    await expect(executeCollectChildren(node, contextNoRunId)).rejects.toThrow(/runId|store/);
    await expect(executeCollectChildren(node, contextNoStore)).rejects.toThrow(/runId|store/);
  });
});
