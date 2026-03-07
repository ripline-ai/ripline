import { describe, expect, it } from "vitest";
import { MemoryRunStore } from "../src/run-store-memory.js";
import { createRunQueue } from "../src/run-queue.js";
import type { RunStore } from "../src/run-store.js";

describe("RunQueue", () => {
  function makeQueue(): { store: RunStore; queue: ReturnType<typeof createRunQueue> } {
    const store = new MemoryRunStore();
    return { store, queue: createRunQueue(store) };
  }

  it("enqueue creates a pending run and returns runId", async () => {
    const { store, queue } = makeQueue();
    const runId = await queue.enqueue("p1", { x: 1 });
    expect(runId).toBeDefined();
    expect(typeof runId).toBe("string");
    const list = await store.list({ status: "pending" });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe(runId);
    expect(list[0].pipelineId).toBe("p1");
    expect(list[0].inputs).toEqual({ x: 1 });
  });

  it("claimNext returns null when no pending runs", async () => {
    const { queue } = makeQueue();
    const claimed = await queue.claimNext();
    expect(claimed).toBeNull();
  });

  it("claimNext returns oldest pending run and sets status to running", async () => {
    const { store, queue } = makeQueue();
    const id1 = await queue.enqueue("p1", {});
    const id2 = await queue.enqueue("p2", {});
    const first = await queue.claimNext();
    expect(first).not.toBeNull();
    expect(first!.id).toBe(id1);
    expect(first!.status).toBe("running");
    const loaded = await store.load(id1);
    expect(loaded?.status).toBe("running");
    const second = await queue.claimNext();
    expect(second!.id).toBe(id2);
    expect(second!.status).toBe("running");
    const none = await queue.claimNext();
    expect(none).toBeNull();
  });

  it("depth returns count of pending runs", async () => {
    const { queue } = makeQueue();
    expect(await queue.depth()).toBe(0);
    await queue.enqueue("p1", {});
    expect(await queue.depth()).toBe(1);
    await queue.enqueue("p2", {});
    expect(await queue.depth()).toBe(2);
    await queue.claimNext();
    expect(await queue.depth()).toBe(1);
  });
});
