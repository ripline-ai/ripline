import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AutoExecutor } from "../src/auto-executor.js";
import { BackgroundQueue } from "../src/background-queue.js";
import { YamlFileQueueStore } from "../src/interfaces/queue-store.js";
import { EventBus } from "../src/event-bus.js";
import type { RunStore } from "../src/run-store.js";
import type { RunQueue } from "../src/run-queue.js";
import type { TelegramNotifier } from "../src/telegram.js";
import type { PipelineRunRecord } from "../src/types.js";
import type { RunEvent } from "../src/event-bus.js";

/**
 * Minimal in-memory RunStore stub for testing AutoExecutor.
 */
function makeStubStore(records: Map<string, Partial<PipelineRunRecord>> = new Map()): RunStore {
  return {
    load: vi.fn(async (id: string) => (records.get(id) as PipelineRunRecord) ?? null),
    save: vi.fn(async () => {}),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => false),
  } as unknown as RunStore;
}

function makeStubRunQueue(enqueueResult = "run-123"): RunQueue {
  return {
    enqueue: vi.fn(async () => enqueueResult),
    claimNext: vi.fn(async () => null),
    depth: vi.fn(async () => 0),
  } as unknown as RunQueue;
}

function makeStubTelegram(): TelegramNotifier {
  return {
    notify: vi.fn(async () => true),
  } as unknown as TelegramNotifier;
}

describe("AutoExecutor", () => {
  let tmpDir: string;
  let bgQueue: BackgroundQueue;

  beforeEach(() => {
    EventBus.resetForTesting();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ae-test-"));
    bgQueue = new BackgroundQueue({ store: new YamlFileQueueStore(path.join(tmpDir, "queue.yaml")) });
  });

  afterEach(() => {
    EventBus.resetForTesting();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ─── Story 5: Enable / Disable toggle ─────────────────

  describe("enable / disable", () => {
    it("starts disabled by default", () => {
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store: makeStubStore(),
      });
      expect(ae.isEnabled()).toBe(false);
    });

    it("enable flips state and subscribes to EventBus", () => {
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store: makeStubStore(),
      });
      ae.enable();
      expect(ae.isEnabled()).toBe(true);
      expect(EventBus.getInstance().listenerCount("run-event")).toBeGreaterThan(0);
    });

    it("disable flips state and unsubscribes from EventBus", () => {
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store: makeStubStore(),
      });
      ae.enable();
      ae.disable();
      expect(ae.isEnabled()).toBe(false);
      expect(EventBus.getInstance().listenerCount("run-event")).toBe(0);
    });

    it("calling enable twice is idempotent", () => {
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store: makeStubStore(),
      });
      ae.enable();
      ae.enable();
      expect(EventBus.getInstance().listenerCount("run-event")).toBe(1);
    });

    it("calling disable when already disabled is idempotent", () => {
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store: makeStubStore(),
      });
      ae.disable(); // no-op
      expect(ae.isEnabled()).toBe(false);
    });
  });

  // ─── Story 5: Auto-dispatch on enable ──────────────────

  describe("dispatch on enable", () => {
    it("dispatches highest-priority pending item when enabled", async () => {
      const runQueue = makeStubRunQueue("run-abc");
      bgQueue.add({ pipeline: "low-pri", severityWeight: 1 });
      bgQueue.add({ pipeline: "high-pri", severityWeight: 10 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store: makeStubStore(),
      });
      ae.enable();

      // Wait a tick for async dispatch
      await new Promise((r) => setTimeout(r, 50));

      expect(runQueue.enqueue).toHaveBeenCalledWith(
        "high-pri",
        expect.any(Object),
        expect.objectContaining({ source: "background" }),
      );
    });

    it("does not dispatch when queue is empty", async () => {
      const runQueue = makeStubRunQueue();
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store: makeStubStore(),
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));
      expect(runQueue.enqueue).not.toHaveBeenCalled();
    });
  });

  // ─── Story 5: Sequential dispatch after run finishes ───

  describe("sequential dispatch on run completion", () => {
    it("marks queue item completed and dispatches next on run.completed", async () => {
      const runQueue = makeStubRunQueue("run-1");
      const store = makeStubStore();
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      bgQueue.add({ pipeline: "first", severityWeight: 10 });
      bgQueue.add({ pipeline: "second", severityWeight: 5 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));

      // First item should be dispatched
      expect(runQueue.enqueue).toHaveBeenCalledTimes(1);
      expect(runQueue.enqueue).toHaveBeenCalledWith(
        "first",
        expect.any(Object),
        expect.objectContaining({ source: "background" }),
      );

      // Now set up second dispatch to return a new runId
      (runQueue.enqueue as ReturnType<typeof vi.fn>).mockResolvedValue("run-2");

      // Simulate run.completed for run-1
      const event: RunEvent = {
        event: "run.completed",
        runId: "run-1",
        pipelineId: "first",
        status: "completed",
        timestamp: Date.now(),
      };
      EventBus.getInstance().emitRunEvent(event);
      await new Promise((r) => setTimeout(r, 100));

      // First item should now be completed
      const items = bgQueue.list();
      const firstItem = items.find((i) => i.pipeline === "first");
      expect(firstItem!.status).toBe("completed");

      // Second item should have been dispatched
      expect(runQueue.enqueue).toHaveBeenCalledTimes(2);
    });
  });

  // ─── Story 5: Circuit breaker on run error ─────────────

  describe("circuit breaker on run error", () => {
    it("records retry via circuit breaker on run.errored", async () => {
      const runQueue = makeStubRunQueue("run-err");
      const store = makeStubStore();
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      bgQueue.add({ pipeline: "flaky", severityWeight: 5, maxRetries: 3 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate run error
      const event: RunEvent = {
        event: "run.errored",
        runId: "run-err",
        pipelineId: "flaky",
        status: "errored",
        timestamp: Date.now(),
      };
      EventBus.getInstance().emitRunEvent(event);
      await new Promise((r) => setTimeout(r, 100));

      const item = bgQueue.list().find((i) => i.pipeline === "flaky");
      expect(item!.retries).toBe(1);
      // After recordRetry sets status to "pending", tryDispatchNext re-pops it → "running"
      expect(item!.status).toBe("running");
    });
  });

  // ─── Story 5: Does not dispatch when disabled ──────────

  describe("does not dispatch after disable", () => {
    it("ignores run events after being disabled", async () => {
      const runQueue = makeStubRunQueue("run-x");
      const store = makeStubStore();
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      bgQueue.add({ pipeline: "a", severityWeight: 10 });
      bgQueue.add({ pipeline: "b", severityWeight: 5 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));

      // Disable before first run completes
      ae.disable();

      // Simulate completion — should NOT dispatch next
      const event: RunEvent = {
        event: "run.completed",
        runId: "run-x",
        pipelineId: "a",
        status: "completed",
        timestamp: Date.now(),
      };
      // Manually emit since we unsubscribed — simulate the edge
      EventBus.getInstance().emit("run-event", event);
      await new Promise((r) => setTimeout(r, 100));

      // Only the initial dispatch should have happened
      expect(runQueue.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  // ─── reconcileGhostItems ───────────────────────────────

  describe("reconcileGhostItems", () => {
    it("resets running items with no runId to pending", async () => {
      const store = makeStubStore();
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store,
      });

      const id = bgQueue.add({ pipeline: "ghost-no-runid" });
      // Simulate a stuck item in running with no runId
      bgQueue.update(id, { status: "running" });

      const count = await ae.reconcileGhostItems();
      expect(count).toBe(1);
      expect(bgQueue.get(id)!.status).toBe("pending");
    });

    it("resets running items whose run is missing from the store to pending", async () => {
      const store = makeStubStore(); // returns null for all loads
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store,
      });

      const id = bgQueue.add({ pipeline: "ghost-missing-run" });
      bgQueue.update(id, { status: "running", runId: "run-deleted" });

      const count = await ae.reconcileGhostItems();
      expect(count).toBe(1);
      const item = bgQueue.get(id)!;
      expect(item.status).toBe("pending");
      expect(item.runId).toBeUndefined();
    });

    it("resets running items whose run is in a terminal state to pending", async () => {
      const records = new Map<string, Partial<PipelineRunRecord>>([
        ["run-completed", { id: "run-completed", status: "completed", source: "background" } as PipelineRunRecord],
        ["run-errored", { id: "run-errored", status: "errored", source: "background" } as PipelineRunRecord],
      ]);
      const store = makeStubStore(records);
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store,
      });

      const id1 = bgQueue.add({ pipeline: "ghost-completed" });
      bgQueue.update(id1, { status: "running", runId: "run-completed" });
      const id2 = bgQueue.add({ pipeline: "ghost-errored" });
      bgQueue.update(id2, { status: "running", runId: "run-errored" });

      const count = await ae.reconcileGhostItems();
      expect(count).toBe(2);
      expect(bgQueue.get(id1)!.status).toBe("pending");
      expect(bgQueue.get(id1)!.runId).toBeUndefined();
      expect(bgQueue.get(id2)!.status).toBe("pending");
      expect(bgQueue.get(id2)!.runId).toBeUndefined();
    });

    it("does not reset running items whose run is still active", async () => {
      const records = new Map<string, Partial<PipelineRunRecord>>([
        ["run-live", { id: "run-live", status: "running", source: "background" } as PipelineRunRecord],
      ]);
      const store = makeStubStore(records);
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store,
      });

      const id = bgQueue.add({ pipeline: "active-item" });
      bgQueue.update(id, { status: "running", runId: "run-live" });

      const count = await ae.reconcileGhostItems();
      expect(count).toBe(0);
      expect(bgQueue.get(id)!.status).toBe("running");
    });

    it("returns 0 when there are no running items", async () => {
      const store = makeStubStore();
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store,
      });

      bgQueue.add({ pipeline: "pending-item" });

      const count = await ae.reconcileGhostItems();
      expect(count).toBe(0);
    });

    it("restores activeRunMap for running items with active runs", async () => {
      const records = new Map<string, Partial<PipelineRunRecord>>([
        ["run-active", { id: "run-active", status: "running", source: "background" } as PipelineRunRecord],
      ]);
      const store = makeStubStore(records);
      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue: makeStubRunQueue(),
        store,
      });

      const id = bgQueue.add({ pipeline: "restore-map" });
      bgQueue.update(id, { status: "running", runId: "run-active" });

      await ae.reconcileGhostItems();
      // After reconcile, the active run should be in the map so tryDispatchNext won't double-dispatch
      // We verify by enabling and checking that enqueue is NOT called (map prevents dispatch)
      const runQueue = makeStubRunQueue();
      const ae2 = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
        reconcileIntervalMs: 99_999, // don't fire watchdog during test
      });
      // Directly verify the behavior: with a live run in the queue, enable should not dispatch new
      ae2.enable();
      await new Promise((r) => setTimeout(r, 80));
      expect(runQueue.enqueue).not.toHaveBeenCalled();
      ae2.disable();
    });

    it("enable() uses reconcileGhostItems and unblocks dispatch after ghost reset", async () => {
      const store = makeStubStore(); // all loads return null
      const runQueue = makeStubRunQueue("run-new");
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      // Simulate a ghost item blocking the queue
      const ghostId = bgQueue.add({ pipeline: "ghost" });
      bgQueue.update(ghostId, { status: "running", runId: "run-missing" });

      // Add a real pending item that should be dispatched after ghost is cleared
      bgQueue.add({ pipeline: "real-task", severityWeight: 5 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
        reconcileIntervalMs: 99_999,
      });
      ae.enable();
      // Give enough time for async reconcile + dispatch
      await new Promise((r) => setTimeout(r, 150));

      // Ghost should have been reset
      expect(bgQueue.get(ghostId)!.status).toBe("pending");
      // Real task should have been dispatched
      expect(runQueue.enqueue).toHaveBeenCalledWith(
        expect.stringMatching(/ghost|real-task/),
        expect.any(Object),
        expect.objectContaining({ source: "background" }),
      );
      ae.disable();
    });
  });

  // ─── Story 4/5 integration: Telegram notifications ─────

  describe("Telegram notification integration", () => {
    it("sends run_started notification on dispatch", async () => {
      const telegram = makeStubTelegram();
      const runQueue = makeStubRunQueue("run-tg");
      const store = makeStubStore();
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      bgQueue.add({ pipeline: "notif-test", severityWeight: 5 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
        telegram,
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));

      expect(telegram.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: "run_started", pipelineName: "notif-test" }),
      );
    });

    it("sends run_completed notification on successful finish", async () => {
      const telegram = makeStubTelegram();
      const runQueue = makeStubRunQueue("run-tg2");
      const store = makeStubStore();
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      bgQueue.add({ pipeline: "done-test", severityWeight: 5 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
        telegram,
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));

      // Simulate completion
      EventBus.getInstance().emitRunEvent({
        event: "run.completed",
        runId: "run-tg2",
        pipelineId: "done-test",
        status: "completed",
        timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 100));

      expect(telegram.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: "run_completed", pipelineName: "done-test" }),
      );
    });

    it("sends run_failed notification on error", async () => {
      const telegram = makeStubTelegram();
      const runQueue = makeStubRunQueue("run-tg3");
      const store = makeStubStore();
      (store.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      bgQueue.add({ pipeline: "fail-test", severityWeight: 5, maxRetries: 3 });

      const ae = new AutoExecutor({
        backgroundQueue: bgQueue,
        runQueue,
        store,
        telegram,
      });
      ae.enable();
      await new Promise((r) => setTimeout(r, 50));

      EventBus.getInstance().emitRunEvent({
        event: "run.errored",
        runId: "run-tg3",
        pipelineId: "fail-test",
        status: "errored",
        timestamp: Date.now(),
      });
      await new Promise((r) => setTimeout(r, 100));

      expect(telegram.notify).toHaveBeenCalledWith(
        expect.objectContaining({ type: "run_failed", pipelineName: "fail-test" }),
      );
    });
  });
});
