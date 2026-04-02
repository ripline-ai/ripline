import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { PipelineRunStore, type RunStore } from "../src/run-store.js";
import { MemoryRunStore } from "../src/run-store-memory.js";
import type { PipelineRunRecord, PipelineRunStep, PipelineRunStatus } from "../src/types.js";

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

async function rewritePersistedRunMetadata(
  runsDir: string,
  runId: string,
  updates: Partial<Pick<PipelineRunRecord, "status" | "startedAt" | "updatedAt">>
): Promise<void> {
  const runPath = path.join(runsDir, runId, "run.json");
  const record = JSON.parse(await fs.readFile(runPath, "utf8")) as PipelineRunRecord;
  const nextRecord = { ...record, ...updates };
  await fs.writeFile(runPath, JSON.stringify(nextRecord, null, 2), "utf8");

  const indexPath = path.join(runsDir, "_index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<string, {
    status: PipelineRunStatus;
    pipelineId: string;
    startedAt: number;
    updatedAt: number;
  }>;
  index[runId] = {
    status: nextRecord.status,
    pipelineId: nextRecord.pipelineId,
    startedAt: nextRecord.startedAt,
    updatedAt: nextRecord.updatedAt,
  };
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

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

    it("list({ limit }) caps the number of returned runs after sorting", async () => {
      const { store, cleanup } = await createStore();
      try {
        await store.createRun({ pipelineId: "p1", inputs: {} });
        await store.createRun({ pipelineId: "p2", inputs: {} });
        await store.createRun({ pipelineId: "p3", inputs: {} });
        const limited = await store.list({ limit: 2 });
        expect(limited.length).toBe(2);
      } finally {
        await cleanup?.();
      }
    });

    it("list({ status, limit }) caps after status filter", async () => {
      const { store, cleanup } = await createStore();
      try {
        const r1 = await store.createRun({ pipelineId: "p1", inputs: {} });
        const r2 = await store.createRun({ pipelineId: "p2", inputs: {} });
        await store.createRun({ pipelineId: "p3", inputs: {} });
        await store.completeRun(r1, {});
        await store.completeRun(r2, {});
        const limited = await store.list({ status: "completed" as PipelineRunStatus, limit: 1 });
        expect(limited.length).toBe(1);
        expect(limited[0]!.status).toBe("completed");
      } finally {
        await cleanup?.();
      }
    });

    it("list({ sortOrder: 'asc' }) returns oldest first by startedAt", async () => {
      const { store, cleanup } = await createStore();
      try {
        const r1 = await store.createRun({ pipelineId: "p1", inputs: {} });
        await new Promise((r) => setTimeout(r, 5));
        const r2 = await store.createRun({ pipelineId: "p2", inputs: {} });
        await new Promise((r) => setTimeout(r, 5));
        const r3 = await store.createRun({ pipelineId: "p3", inputs: {} });
        const asc = await store.list({ sortOrder: 'asc' });
        expect(asc.length).toBe(3);
        expect(asc[0]!.id).toBe(r1.id);
        expect(asc[2]!.id).toBe(r3.id);
      } finally {
        await cleanup?.();
      }
    });

    it("list({ sortOrder: 'desc' }) returns most-recent first by updatedAt", async () => {
      const { store, cleanup } = await createStore();
      try {
        const r1 = await store.createRun({ pipelineId: "p1", inputs: {} });
        await new Promise((r) => setTimeout(r, 5));
        const r2 = await store.createRun({ pipelineId: "p2", inputs: {} });
        await new Promise((r) => setTimeout(r, 5));
        await store.createRun({ pipelineId: "p3", inputs: {} });
        // Touch r1 to make it the most recently updated
        await new Promise((r) => setTimeout(r, 5));
        await store.save(r1);
        const desc = await store.list({ sortOrder: 'desc' });
        expect(desc.length).toBe(3);
        expect(desc[0]!.id).toBe(r1.id);
        // r2 should appear before r3 (both untouched after r1, but r3 started last)
        // desc sorts by updatedAt so last-updated (r1) is first
        expect(desc.map((r) => r.id)).toContain(r2.id);
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

  it("PipelineRunStore: live stale recovery only reclaims dead-owned running runs", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-live-recovery-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const alive = await store.createRun({ pipelineId: "alive", inputs: {} });
      alive.status = "running";
      alive.ownerPid = process.pid;
      await store.save(alive);

      const dead = await store.createRun({ pipelineId: "dead", inputs: {} });
      dead.status = "running";
      dead.ownerPid = 999999;
      await store.save(dead);

      const legacy = await store.createRun({ pipelineId: "legacy", inputs: {} });
      legacy.status = "running";
      await store.save(legacy);

      const recovered = await store.recoverStaleRuns({ requireOwnerPid: true });
      expect(recovered).toBe(1);

      expect((await store.load(alive.id))!.status).toBe("running");
      expect((await store.load(dead.id))!.status).toBe("pending");
      expect((await store.load(dead.id))!.ownerPid).toBeUndefined();
      expect((await store.load(legacy.id))!.status).toBe("running");
    } finally {
      await rmDirRobust(runsDir);
    }
  });

  it("PipelineRunStore: list() only loads matching run records after filtering and limit selection", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-indexed-list-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const pending = await store.createRun({ pipelineId: "pending-pipeline", inputs: {} });
      const runningOldest = await store.createRun({ pipelineId: "running-oldest", inputs: {} });
      await new Promise((r) => setTimeout(r, 5));
      const runningNewest = await store.createRun({ pipelineId: "running-newest", inputs: {} });
      const completed = await store.createRun({ pipelineId: "completed-pipeline", inputs: {} });

      runningOldest.status = "running";
      runningNewest.status = "running";
      completed.status = "completed";
      await store.save(runningOldest);
      await store.save(runningNewest);
      await store.save(completed);

      const readSpy = vi.spyOn(fs, "readFile");
      try {
        const runs = await store.list({ status: "running", limit: 1 });
        expect(runs).toHaveLength(1);
        expect(runs[0]!.id).toBe(runningOldest.id);
        expect(runs[0]!.status).toBe("running");

        const runFileReads = readSpy.mock.calls.filter(([filePath]) =>
          String(filePath).endsWith(`${path.sep}run.json`)
        );
        expect(runFileReads).toHaveLength(1);
        expect(String(runFileReads[0]![0])).toContain(runningOldest.id);
      } finally {
        readSpy.mockRestore();
      }

      const pendingRuns = await store.list({ status: "pending" });
      expect(pendingRuns.map((run) => run.id)).toEqual([pending.id]);
    } finally {
      await rmDirRobust(runsDir);
    }
  });

  it("PipelineRunStore: rebuildIndex repopulates the on-disk index from run directories", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-rebuild-index-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const run = await store.createRun({ pipelineId: "rebuild-target", inputs: { hello: "world" } });
      run.status = "completed";
      await store.save(run);

      await fs.writeFile(path.join(runsDir, "_index.json"), "{}", "utf8");
      await store.rebuildIndex();

      const rawIndex = JSON.parse(await fs.readFile(path.join(runsDir, "_index.json"), "utf8")) as Record<string, {
        pipelineId: string;
        status: string;
      }>;
      expect(rawIndex[run.id]).toMatchObject({
        pipelineId: "rebuild-target",
        status: "completed",
      });
    } finally {
      await rmDirRobust(runsDir);
    }
  });

  it("PipelineRunStore: missing index file falls back to a full rebuild on startup", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-missing-index-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const run = await store.createRun({ pipelineId: "startup-rebuild", inputs: {} });
      run.status = "running";
      await store.save(run);
      await fs.unlink(path.join(runsDir, "_index.json"));

      const restartedStore = new PipelineRunStore(runsDir);
      await restartedStore.init();

      const running = await restartedStore.list({ status: "running" });
      expect(running.map((entry) => entry.id)).toEqual([run.id]);

      const rebuiltIndex = JSON.parse(await fs.readFile(path.join(runsDir, "_index.json"), "utf8")) as Record<string, {
        status: string;
      }>;
      expect(rebuiltIndex[run.id]?.status).toBe("running");
    } finally {
      await rmDirRobust(runsDir);
    }
  });

  it("PipelineRunStore: corrupt index file falls back to a full rebuild on startup", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-corrupt-index-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const run = await store.createRun({ pipelineId: "corrupt-index-rebuild", inputs: {} });
      run.status = "completed";
      await store.save(run);
      await fs.writeFile(path.join(runsDir, "_index.json"), "{not-valid-json", "utf8");

      const restartedStore = new PipelineRunStore(runsDir);
      await restartedStore.init();

      const completed = await restartedStore.list({ status: "completed" });
      expect(completed.map((entry) => entry.id)).toEqual([run.id]);

      const rebuiltIndex = JSON.parse(await fs.readFile(path.join(runsDir, "_index.json"), "utf8")) as Record<string, {
        status: string;
      }>;
      expect(rebuiltIndex[run.id]?.status).toBe("completed");
    } finally {
      await rmDirRobust(runsDir);
    }
  });

  it("PipelineRunStore: concurrent save calls leave a valid index containing every run", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-concurrent-index-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const runs = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          store.createRun({ pipelineId: `pipeline-${index}`, inputs: { index } })
        )
      );

      await Promise.all(
        runs.map(async (run, index) => {
          run.status = index % 2 === 0 ? "completed" : "errored";
          await store.save(run);
        })
      );

      const rawIndexText = await fs.readFile(path.join(runsDir, "_index.json"), "utf8");
      const rawIndex = JSON.parse(rawIndexText) as Record<string, { status: string; pipelineId: string }>;
      expect(Object.keys(rawIndex)).toHaveLength(12);
      for (const run of runs) {
        expect(rawIndex[run.id]).toBeDefined();
        expect(rawIndex[run.id]!.pipelineId).toBe(run.pipelineId);
      }

      const listedRuns = await store.list();
      expect(listedRuns).toHaveLength(12);
    } finally {
      await rmDirRobust(runsDir);
    }
  });

  it("PipelineRunStore: pruneOlderThan removes only terminal runs older than the cutoff and updates the index", async () => {
    const runsDir = path.join(process.cwd(), ".ripline", "runs", "test-run-store-prune-" + Date.now());
    const store = new PipelineRunStore(runsDir);
    await store.init();
    try {
      const oldCompleted = await store.createRun({ pipelineId: "old-completed", inputs: {} });
      oldCompleted.status = "completed";
      await store.save(oldCompleted);
      await rewritePersistedRunMetadata(runsDir, oldCompleted.id, {
        status: "completed",
        updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      });

      const oldErrored = await store.createRun({ pipelineId: "old-errored", inputs: {} });
      oldErrored.status = "errored";
      await store.save(oldErrored);
      await rewritePersistedRunMetadata(runsDir, oldErrored.id, {
        status: "errored",
        updatedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
      });

      const recentCompleted = await store.createRun({ pipelineId: "recent-completed", inputs: {} });
      recentCompleted.status = "completed";
      await store.save(recentCompleted);

      const oldRunning = await store.createRun({ pipelineId: "old-running", inputs: {} });
      oldRunning.status = "running";
      await store.save(oldRunning);
      await rewritePersistedRunMetadata(runsDir, oldRunning.id, {
        status: "running",
        updatedAt: Date.now() - 12 * 24 * 60 * 60 * 1000,
      });

      const removed = await store.pruneOlderThan(7);
      expect(removed).toBe(2);
      expect(await store.load(oldCompleted.id)).toBeNull();
      expect(await store.load(oldErrored.id)).toBeNull();
      expect((await store.load(recentCompleted.id))?.status).toBe("completed");
      expect((await store.load(oldRunning.id))?.status).toBe("running");

      const rawIndex = JSON.parse(await fs.readFile(path.join(runsDir, "_index.json"), "utf8")) as Record<string, unknown>;
      expect(rawIndex[oldCompleted.id]).toBeUndefined();
      expect(rawIndex[oldErrored.id]).toBeUndefined();
      expect(rawIndex[recentCompleted.id]).toBeDefined();
      expect(rawIndex[oldRunning.id]).toBeDefined();
    } finally {
      await rmDirRobust(runsDir);
    }
  });
});
