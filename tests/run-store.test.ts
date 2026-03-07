import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { PipelineRunStore, type RunStore } from "../src/run-store.js";

/** Remove directory and contents; retry once on ENOTEMPTY (e.g. .tmp left by concurrent save). */
async function rmDirRobust(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTEMPTY") {
      await new Promise((r) => setTimeout(r, 50));
      await fs.rm(dir, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}
import { MemoryRunStore } from "../src/run-store-memory.js";
import type { PipelineRunRecord, PipelineRunStep, PipelineRunStatus } from "../src/types.js";

const runStoreInterfaceTests = (name: string, createStore: () => Promise<{ store: RunStore; cleanup?: () => Promise<void> }>) => {
  describe(name, () => {
    it("createRun returns record with pending status and empty steps", async () => {
      const { store, cleanup } = await createStore();
      try {
        const record = await store.createRun({
          pipelineId: "p1",
          inputs: { x: 1 },
        });
        expect(record.id).toBeDefined();
        expect(record.pipelineId).toBe("p1");
        expect(record.status).toBe("pending");
        expect(record.steps).toEqual([]);
        expect(record.inputs).toEqual({ x: 1 });
        expect(record.startedAt).toBeDefined();
        expect(record.updatedAt).toBeDefined();
      } finally {
        await cleanup?.();
      }
    });

    it("load returns null for missing runId", async () => {
      const { store, cleanup } = await createStore();
      try {
        const loaded = await store.load("nonexistent-id");
        expect(loaded).toBeNull();
      } finally {
        await cleanup?.();
      }
    });

    it("appendStep adds step and persists", async () => {
      const { store, cleanup } = await createStore();
      try {
        const record = await store.createRun({ pipelineId: "p1", inputs: {} });
        const step: PipelineRunStep = { nodeId: "n1", status: "running", startedAt: Date.now() };
        await store.appendStep(record, step);
        expect(record.steps).toHaveLength(1);
        expect(record.steps[0]).toMatchObject({ nodeId: "n1", status: "running" });

        const loaded = await store.load(record.id);
        expect(loaded?.steps).toHaveLength(1);
        expect(loaded?.steps[0].nodeId).toBe("n1");
      } finally {
        await cleanup?.();
      }
    });

    it("updateCursor persists cursor and save updates record", async () => {
      const { store, cleanup } = await createStore();
      try {
        const record = await store.createRun({ pipelineId: "p1", inputs: {} });
        await store.updateCursor(record, { nextNodeIndex: 2, context: { artifacts: { a: 1 } } });
        expect(record.cursor).toEqual({ nextNodeIndex: 2, context: { artifacts: { a: 1 } } });

        const loaded = await store.load(record.id);
        expect(loaded?.cursor?.nextNodeIndex).toBe(2);
        expect(loaded?.cursor?.context.artifacts).toEqual({ a: 1 });
      } finally {
        await cleanup?.();
      }
    });

    it("completeRun sets status completed and optional outputs", async () => {
      const { store, cleanup } = await createStore();
      try {
        const record = await store.createRun({ pipelineId: "p1", inputs: {} });
        await store.completeRun(record, { out: "result" });
        expect(record.status).toBe("completed");
        expect(record.outputs).toEqual({ out: "result" });

        const loaded = await store.load(record.id);
        expect(loaded?.status).toBe("completed");
        expect(loaded?.outputs).toEqual({ out: "result" });
      } finally {
        await cleanup?.();
      }
    });

    it("failRun sets status errored and error message", async () => {
      const { store, cleanup } = await createStore();
      try {
        const record = await store.createRun({ pipelineId: "p1", inputs: {} });
        await store.failRun(record, "Node n2 failed");
        expect(record.status).toBe("errored");
        expect(record.error).toBe("Node n2 failed");

        const loaded = await store.load(record.id);
        expect(loaded?.status).toBe("errored");
        expect(loaded?.error).toBe("Node n2 failed");
      } finally {
        await cleanup?.();
      }
    });

    it("run records track statuses pending, running, completed, errored", async () => {
      const { store, cleanup } = await createStore();
      try {
        const record = await store.createRun({ pipelineId: "p1", inputs: {} });
        expect(record.status).toBe("pending");

        record.status = "running";
        await store.save(record);
        const loadedRunning = await store.load(record.id);
        expect(loadedRunning?.status).toBe("running");

        await store.completeRun(record, {});
        const loadedCompleted = await store.load(record.id);
        expect(loadedCompleted?.status).toBe("completed");

        const record2 = await store.createRun({ pipelineId: "p2", inputs: {} });
        await store.failRun(record2, "err");
        const loadedErrored = await store.load(record2.id);
        expect(loadedErrored?.status).toBe("errored");
      } finally {
        await cleanup?.();
      }
    });

    it("list returns all runs when no options, list({ status }) returns filtered FIFO for pending", async () => {
      const { store, cleanup } = await createStore();
      try {
        const r1 = await store.createRun({ pipelineId: "p1", inputs: {} });
        const r2 = await store.createRun({ pipelineId: "p2", inputs: {} });
        const r3 = await store.createRun({ pipelineId: "p3", inputs: {} });
        const listAll = await store.list();
        expect(listAll.length).toBe(3);
        const pending = await store.list({ status: "pending" as PipelineRunStatus });
        expect(pending.length).toBe(3);
        expect(pending.map((r) => r.id).sort()).toEqual([r1.id, r2.id, r3.id].sort());
        r2.status = "running";
        await store.save(r2);
        const pendingOnly = await store.list({ status: "pending" as PipelineRunStatus });
        expect(pendingOnly.length).toBe(2);
        expect(pendingOnly.map((r) => r.id)).toContain(r1.id);
        expect(pendingOnly.map((r) => r.id)).toContain(r3.id);
      } finally {
        await cleanup?.();
      }
    });
  });
};

/** Run-store integrity: readers never see malformed JSON while a single writer updates the run. */
async function runStoreConcurrentReadWriteTest(createStore: () => Promise<{ store: RunStore; cleanup?: () => Promise<void> }>) {
  const { store, cleanup } = await createStore();
  try {
    const record = await store.createRun({ pipelineId: "p1", inputs: { x: 0 } });
    const runId = record.id;
    const writeCount = 15;
    const readCount = 30;
    const readResults: { ok: boolean; error?: string }[] = [];
    const writer = (async () => {
      for (let i = 0; i < writeCount; i++) {
        const r = await store.load(runId);
        if (r) {
          r.inputs = { x: i };
          await store.save(r);
        }
      }
    })();
    const readers = Array.from({ length: readCount }, () =>
      (async () => {
        try {
          const loaded = await store.load(runId);
          if (loaded !== null) {
            expect(loaded.id).toBe(runId);
            expect(loaded.pipelineId).toBe("p1");
            expect(typeof loaded.updatedAt).toBe("number");
          }
          readResults.push({ ok: true });
        } catch (e) {
          readResults.push({ ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      })()
    );
    await Promise.all([writer, ...readers]);
    const failures = readResults.filter((r) => !r.ok);
    expect(failures).toEqual([]);
  } finally {
    await cleanup?.();
  }
}

describe("RunStore", () => {
  runStoreInterfaceTests("MemoryRunStore", async () => ({
    store: new MemoryRunStore(),
  }));

  runStoreInterfaceTests("PipelineRunStore (file)", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    return {
      store,
      cleanup: async () => {
        await rmDirRobust(runsDir);
      },
    };
  });

  it(
    "PipelineRunStore: concurrent read/write never yields malformed JSON",
    async () => {
      const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-concurrent-" + Date.now());
      const store = new PipelineRunStore(runsDir);
      await store.init();
      try {
        await runStoreConcurrentReadWriteTest(async () => ({
          store,
          cleanup: async () => {
            await rmDirRobust(runsDir);
          },
        }));
      } finally {
        await rmDirRobust(runsDir);
      }
    },
    15_000
  );
});
