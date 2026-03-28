import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { BackgroundQueue } from "../src/background-queue.js";

describe("BackgroundQueue", () => {
  let tmpDir: string;
  let queueFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bq-test-"));
    queueFile = path.join(tmpDir, "queue.yaml");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeQueue(opts?: { maxRetries?: number }) {
    return new BackgroundQueue({ filePath: queueFile, maxRetries: opts?.maxRetries });
  }

  // ─── Story 2: YAML persistence & CRUD ──────────────────

  describe("CRUD operations", () => {
    it("add creates an item with correct defaults and returns its ID", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "my-pipeline" });
      expect(typeof id).toBe("string");
      const item = q.get(id);
      expect(item).toBeDefined();
      expect(item!.pipeline).toBe("my-pipeline");
      expect(item!.status).toBe("pending");
      expect(item!.retries).toBe(0);
      expect(item!.needsReview).toBe(false);
      expect(item!.severityWeight).toBe(1);
      expect(item!.manualBoost).toBe(0);
      expect(item!.inputs).toEqual({});
    });

    it("add respects custom severityWeight, manualBoost, maxRetries and inputs", () => {
      const q = makeQueue();
      const id = q.add({
        pipeline: "p",
        inputs: { foo: "bar" },
        severityWeight: 5,
        manualBoost: 10,
        maxRetries: 2,
      });
      const item = q.get(id)!;
      expect(item.inputs).toEqual({ foo: "bar" });
      expect(item.severityWeight).toBe(5);
      expect(item.manualBoost).toBe(10);
      expect(item.maxRetries).toBe(2);
    });

    it("list returns all items", () => {
      const q = makeQueue();
      q.add({ pipeline: "a" });
      q.add({ pipeline: "b" });
      expect(q.list()).toHaveLength(2);
    });

    it("get returns undefined for missing ID", () => {
      const q = makeQueue();
      expect(q.get("nonexistent")).toBeUndefined();
    });

    it("update modifies fields and persists them", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "p" });
      const updated = q.update(id, { manualBoost: 99 });
      expect(updated?.manualBoost).toBe(99);
      // Re-read from a fresh instance to verify persistence
      const q2 = makeQueue();
      expect(q2.get(id)!.manualBoost).toBe(99);
    });

    it("update returns undefined for missing ID", () => {
      const q = makeQueue();
      expect(q.update("nope", { manualBoost: 1 })).toBeUndefined();
    });

    it("remove deletes an item and returns true", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "p" });
      expect(q.remove(id)).toBe(true);
      expect(q.get(id)).toBeUndefined();
      expect(q.list()).toHaveLength(0);
    });

    it("remove returns false for missing ID", () => {
      const q = makeQueue();
      expect(q.remove("nope")).toBe(false);
    });
  });

  // ─── Story 2: YAML persistence ─────────────────────────

  describe("YAML persistence", () => {
    it("persists items across separate queue instances", () => {
      const q1 = makeQueue();
      const id = q1.add({ pipeline: "persist-test" });

      const q2 = makeQueue();
      const item = q2.get(id);
      expect(item).toBeDefined();
      expect(item!.pipeline).toBe("persist-test");
    });

    it("returns empty list when file does not exist", () => {
      const q = new BackgroundQueue({ filePath: path.join(tmpDir, "no-file.yaml") });
      expect(q.list()).toEqual([]);
    });

    it("creates parent directories if they do not exist", () => {
      const nested = path.join(tmpDir, "a", "b", "queue.yaml");
      const q = new BackgroundQueue({ filePath: nested });
      q.add({ pipeline: "nested" });
      expect(fs.existsSync(nested)).toBe(true);
    });
  });

  // ─── Story 2: Priority scoring ─────────────────────────

  describe("priority scoring", () => {
    it("computePriority = severityWeight + ageHours*0.5 + manualBoost", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "p", severityWeight: 3, manualBoost: 2 });
      const item = q.get(id)!;
      // Item was just created so age ≈ 0
      const score = q.computePriority(item);
      expect(score).toBeCloseTo(5, 0); // 3 + ~0 + 2
    });

    it("older items score higher due to age decay", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "p", severityWeight: 1 });
      const item = q.get(id)!;
      // Simulate an item created 10 hours ago
      const oldItem = { ...item, createdAt: Date.now() - 10 * 60 * 60 * 1000 };
      const score = q.computePriority(oldItem);
      // 1 + 10*0.5 + 0 = 6
      expect(score).toBeCloseTo(6, 0);
    });
  });

  // ─── Story 2: Pop highest-priority ─────────────────────

  describe("pop", () => {
    it("returns undefined when queue is empty", () => {
      const q = makeQueue();
      expect(q.pop()).toBeUndefined();
    });

    it("returns the highest-priority pending item and marks it running", () => {
      const q = makeQueue();
      q.add({ pipeline: "low", severityWeight: 1 });
      q.add({ pipeline: "high", severityWeight: 10 });
      q.add({ pipeline: "mid", severityWeight: 5 });

      const popped = q.pop();
      expect(popped).toBeDefined();
      expect(popped!.pipeline).toBe("high");
      expect(popped!.status).toBe("running");
    });

    it("skips non-pending items", () => {
      const q = makeQueue();
      const id1 = q.add({ pipeline: "a", severityWeight: 10 });
      q.add({ pipeline: "b", severityWeight: 1 });

      // Mark first as completed
      q.update(id1, { status: "completed" });

      const popped = q.pop();
      expect(popped!.pipeline).toBe("b");
    });

    it("returns undefined when all items are non-pending", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "a" });
      q.update(id, { status: "running" });
      expect(q.pop()).toBeUndefined();
    });
  });

  // ─── Story 2: Circuit breaker ──────────────────────────

  describe("circuit breaker (recordRetry)", () => {
    it("increments retries and keeps status pending when under limit", () => {
      const q = makeQueue({ maxRetries: 3 });
      const id = q.add({ pipeline: "p", maxRetries: 3 });

      const updated = q.recordRetry(id);
      expect(updated!.retries).toBe(1);
      expect(updated!.status).toBe("pending");
      expect(updated!.needsReview).toBe(false);
    });

    it("marks item as failed with needsReview when retries reach maxRetries", () => {
      const q = makeQueue();
      const id = q.add({ pipeline: "p", maxRetries: 2 });

      q.recordRetry(id); // retries=1, still pending
      const final = q.recordRetry(id); // retries=2, >= maxRetries=2 → failed
      expect(final!.retries).toBe(2);
      expect(final!.status).toBe("failed");
      expect(final!.needsReview).toBe(true);
    });

    it("returns undefined for missing ID", () => {
      const q = makeQueue();
      expect(q.recordRetry("nope")).toBeUndefined();
    });

    it("uses constructor default maxRetries when item does not specify", () => {
      const q = makeQueue({ maxRetries: 1 });
      const id = q.add({ pipeline: "p" }); // maxRetries from constructor default
      const item = q.get(id)!;
      expect(item.maxRetries).toBe(1);

      const updated = q.recordRetry(id); // retries=1, >= maxRetries=1 → failed
      expect(updated!.status).toBe("failed");
    });
  });
});
