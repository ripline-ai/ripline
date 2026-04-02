import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import { PipelineRunStore } from "../src/run-store.js";
import type { PipelinePluginConfig } from "../src/types.js";
import type { AgentRunner } from "../src/pipeline/executors/agent.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

async function rewritePersistedRunMetadata(
  runsDir: string,
  runId: string,
  updates: { status?: string; updatedAt?: number; ownerPid?: number }
): Promise<void> {
  const runPath = path.join(runsDir, runId, "run.json");
  const record = JSON.parse(await fs.readFile(runPath, "utf8")) as Record<string, unknown>;
  const nextRecord = { ...record, ...updates };
  await fs.writeFile(runPath, JSON.stringify(nextRecord, null, 2), "utf8");

  const indexPath = path.join(runsDir, "_index.json");
  const index = JSON.parse(await fs.readFile(indexPath, "utf8")) as Record<string, {
    status: string;
    pipelineId: string;
    startedAt: number;
    updatedAt: number;
  }>;
  index[runId] = {
    ...index[runId]!,
    status: typeof nextRecord.status === "string" ? nextRecord.status : index[runId]!.status,
    updatedAt: typeof nextRecord.updatedAt === "number" ? nextRecord.updatedAt : index[runId]!.updatedAt,
  };
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");
}

describe("HTTP server", () => {
  let config: PipelinePluginConfig;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    const runsDir = path.join(os.tmpdir(), `ripline-server-test-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });
    config = {
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
    };
    app = await createApp(config);
  });

  afterEach(async () => {
    if (app?.close) await app.close();
  });

  describe("GET /pipelines", () => {
    it("returns list of pipeline definitions with id, name, tags", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/pipelines",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { pipelines: { id: string; name?: string; tags?: string[] }[] };
      expect(Array.isArray(body.pipelines)).toBe(true);
      const ripline = body.pipelines.find((p) => p.id === "ripline-area-owner");
      expect(ripline).toBeDefined();
      expect(ripline!.name).toBeDefined();
      expect(ripline!.id).toBe("ripline-area-owner");
    });

    it("returns 401 when authToken is set and Authorization header is missing", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({ method: "GET", url: "/pipelines" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 when authToken is set and Bearer token is valid", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({
        method: "GET",
        url: "/pipelines",
        headers: { authorization: "Bearer secret" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /pipelines/:id/run", () => {
    it("returns runId and triggers execution", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { runId: string };
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe("string");
    });

    it("writes run artifacts to the configured runsDir", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const { runId } = res.json() as { runId: string };
      const runDir = path.join(config.runsDir!, runId);
      const runFile = path.join(runDir, "run.json");
      await expect(fs.access(runDir)).resolves.toBeUndefined();
      await expect(fs.access(runFile)).resolves.toBeUndefined();
      const data = JSON.parse(await fs.readFile(runFile, "utf8")) as { id: string; pipelineId: string };
      expect(data.id).toBe(runId);
      expect(data.pipelineId).toBe("ripline-area-owner");
    });

    it("accepts optional inputs and env in body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: { inputs: { foo: "bar" }, env: { FOO: "BAR" } },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { runId: string };
      expect(body.runId).toBeDefined();
    });

    it("returns 404 for unknown pipeline id", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/nonexistent-pipeline/run",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 401 when authToken is set and no Bearer token", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /runs", () => {
    it("returns 200 with empty runs array when no runs exist", async () => {
      const res = await app.inject({ method: "GET", url: "/runs" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { runs: unknown[] };
      expect(Array.isArray(body.runs)).toBe(true);
      expect(body.runs).toHaveLength(0);
    });

    it("returns runs after POST /pipelines/:id/run", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const listRes = await app.inject({ method: "GET", url: "/runs" });
      expect(listRes.statusCode).toBe(200);
      const body = listRes.json() as { runs: { id: string; pipelineId: string; status: string }[] };
      expect(body.runs.length).toBeGreaterThanOrEqual(1);
      const run = body.runs.find((r) => r.id === runId);
      expect(run).toBeDefined();
      expect(run!.pipelineId).toBe("ripline-area-owner");
      expect(run!.status).toBeDefined();
    });

    it("filters by pipelineId when query param is provided", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const matchingRes = await app.inject({
        method: "GET",
        url: "/runs?pipelineId=ripline-area-owner",
      });
      expect(matchingRes.statusCode).toBe(200);
      const matchingBody = matchingRes.json() as { runs: { id: string; pipelineId: string }[] };
      expect(matchingBody.runs.every((r) => r.pipelineId === "ripline-area-owner")).toBe(true);
      expect(matchingBody.runs.some((r) => r.id === runId)).toBe(true);

      const noMatchRes = await app.inject({
        method: "GET",
        url: "/runs?pipelineId=nonexistent-pipeline",
      });
      expect(noMatchRes.statusCode).toBe(200);
      const noMatchBody = noMatchRes.json() as { runs: unknown[] };
      expect(noMatchBody.runs.filter((r: { pipelineId: string }) => r.pipelineId === "ripline-area-owner")).toHaveLength(0);
    });

    it("filters by status when query param is provided", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);

      const pendingRes = await app.inject({ method: "GET", url: "/runs?status=pending" });
      expect(pendingRes.statusCode).toBe(200);
      const pendingBody = pendingRes.json() as { runs: { status: string }[] };
      expect(pendingBody.runs.every((r) => r.status === "pending")).toBe(true);

      const runningRes = await app.inject({ method: "GET", url: "/runs?status=running" });
      expect(runningRes.statusCode).toBe(200);
      const runningBody = runningRes.json() as { runs: { status: string }[] };
      expect(runningBody.runs.every((r) => r.status === "running")).toBe(true);
    });

    it("returns 401 when authToken is set and Authorization header is missing", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({ method: "GET", url: "/runs" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 when authToken is set and Bearer token is valid", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({
        method: "GET",
        url: "/runs",
        headers: { authorization: "Bearer secret" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { runs: unknown[] };
      expect(Array.isArray(body.runs)).toBe(true);
    });

    it("rebuilds the run index and recovers stale running runs during startup", async () => {
      await app.close();

      const store = new PipelineRunStore(config.runsDir!);
      await store.init();
      const staleRun = await store.createRun({ pipelineId: "startup-rebuild", inputs: {} });
      staleRun.status = "running";
      await store.save(staleRun);
      await fs.unlink(path.join(config.runsDir!, "_index.json"));

      app = await createApp(config);

      const listRes = await app.inject({ method: "GET", url: "/runs?status=pending" });
      expect(listRes.statusCode).toBe(200);
      const body = listRes.json() as { runs: { id: string; status: string }[] };
      expect(body.runs.some((run) => run.id === staleRun.id && run.status === "pending")).toBe(true);

      const index = JSON.parse(await fs.readFile(path.join(config.runsDir!, "_index.json"), "utf8")) as Record<string, {
        status: string;
      }>;
      expect(index[staleRun.id]?.status).toBe("pending");
    });
  });

  describe("DELETE /runs/prune", () => {
    it("removes old terminal runs and returns the deleted count", async () => {
      const store = new PipelineRunStore(config.runsDir!);
      await store.init();

      const oldCompleted = await store.createRun({ pipelineId: "old-completed", inputs: {} });
      oldCompleted.status = "completed";
      await store.save(oldCompleted);
      await rewritePersistedRunMetadata(config.runsDir!, oldCompleted.id, {
        status: "completed",
        updatedAt: Date.now() - 10 * 24 * 60 * 60 * 1000,
      });

      const oldErrored = await store.createRun({ pipelineId: "old-errored", inputs: {} });
      oldErrored.status = "errored";
      await store.save(oldErrored);
      await rewritePersistedRunMetadata(config.runsDir!, oldErrored.id, {
        status: "errored",
        updatedAt: Date.now() - 9 * 24 * 60 * 60 * 1000,
      });

      const recentCompleted = await store.createRun({ pipelineId: "recent-completed", inputs: {} });
      recentCompleted.status = "completed";
      await store.save(recentCompleted);

      const oldRunning = await store.createRun({ pipelineId: "old-running", inputs: {} });
      oldRunning.status = "running";
      await store.save(oldRunning);
      await rewritePersistedRunMetadata(config.runsDir!, oldRunning.id, {
        status: "running",
        updatedAt: Date.now() - 11 * 24 * 60 * 60 * 1000,
      });

      const pruneRes = await app.inject({
        method: "DELETE",
        url: "/runs/prune?olderThanDays=7",
      });
      expect(pruneRes.statusCode).toBe(200);
      expect(pruneRes.json()).toEqual({ deleted: 2 });

      const runsRes = await app.inject({ method: "GET", url: "/runs" });
      const runs = (runsRes.json() as { runs: { id: string; status: string }[] }).runs;
      expect(runs.some((run) => run.id === oldCompleted.id)).toBe(false);
      expect(runs.some((run) => run.id === oldErrored.id)).toBe(false);
      expect(runs.some((run) => run.id === recentCompleted.id && run.status === "completed")).toBe(true);
      expect(runs.some((run) => run.id === oldRunning.id && run.status === "running")).toBe(true);
    });

    it("rejects invalid olderThanDays values", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/runs/prune?olderThanDays=0",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({
        error: "Bad Request",
        message: "olderThanDays must be a number greater than or equal to 1",
      });
    });
  });

  describe("GET /runs/:runId", () => {
    it("returns run record with node-by-node status", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const getRes = await app.inject({
        method: "GET",
        url: `/runs/${runId}`,
      });
      expect(getRes.statusCode).toBe(200);
      const record = getRes.json() as {
        id: string;
        pipelineId: string;
        status: string;
        steps: { nodeId: string; status: string }[];
      };
      expect(record.id).toBe(runId);
      expect(record.pipelineId).toBe("ripline-area-owner");
      expect(record.steps).toBeDefined();
      expect(Array.isArray(record.steps)).toBe(true);
    });

    it("returns 404 for unknown runId", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/runs/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /metrics (when maxConcurrency > 0)", () => {
    it("returns queue depth, active workers, and avg duration", async () => {
      await app.close();
      app = await createApp({ ...config, maxConcurrency: 1 });
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { queueDepth: number; activeWorkers: number };
      expect(typeof body.queueDepth).toBe("number");
      expect(typeof body.activeWorkers).toBe("number");
    });
  });

  describe("GET /runs/:runId/stream", () => {
    it("returns SSE stream with node updates", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      const streamRes = await app.inject({
        method: "GET",
        url: `/runs/${runId}/stream`,
      });
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers["content-type"]).toMatch(/text\/event-stream/);
      const body = streamRes.payload as string;
      expect(body).toContain("data:");
      expect(body).toContain("id");
      expect(body).toContain("steps");
    });
  });

  describe("run-store integrity under concurrent load/save", () => {
    it("GET /runs/:runId and /stream return 200 with valid JSON under concurrent load/save", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const numGet = 20;
      const numStream = 5;
      const getPromises = Array.from({ length: numGet }, () =>
        app.inject({ method: "GET", url: `/runs/${runId}` })
      );
      const streamPromises = Array.from({ length: numStream }, () =>
        app.inject({ method: "GET", url: `/runs/${runId}/stream` })
      );
      const getResults = await Promise.all(getPromises);
      const streamResults = await Promise.all(streamPromises);

      for (const res of getResults) {
        expect(res.statusCode).toBe(200);
        const body = res.json() as { id: string; status: string };
        expect(body.id).toBe(runId);
        expect(typeof body.status).toBe("string");
      }
      for (const res of streamResults) {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
        const body = res.payload as string;
        expect(body).toContain("data:");
        expect(() => {
          const line = body.split("\n").find((l) => l.startsWith("data:"));
          if (line) JSON.parse(line.slice(5));
        }).not.toThrow();
      }
    });
  });

  describe("POST /pipelines/:id/run with custom agentRunner", () => {
    it("uses injected agentRunner for agent nodes (not stub)", { timeout: 10000 }, async () => {
      const mockAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
        text: `[mock] ${agentId}: ${prompt.slice(0, 50)}`,
        tokenUsage: { input: 1, output: 2 },
      });
      await app.close();
      app = await createApp({ ...config, agentRunner: mockAgentRunner });

      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: { inputs: {} },
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      let record: { status: string; steps?: { status: string; data?: { artifactValue?: { text?: string } } }[] } | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
        record = getRes.json() as typeof record;
        if (record?.status === "completed" || record?.status === "errored") break;
      }
      expect(record).toBeDefined();
      expect(record!.status).toBe("completed");
      const withArtifact = record!.steps?.filter(
        (s) => s.data && typeof (s.data as { artifactValue?: { text?: string } }).artifactValue?.text === "string"
      ) ?? [];
      expect(withArtifact.length).toBeGreaterThan(0);
      const firstText = (withArtifact[0]!.data as { artifactValue?: { text?: string } }).artifactValue?.text ?? "";
      expect(firstText).toMatch(/\[mock\]/);
      expect(firstText).not.toMatch(/\[http-stub\]/);
    });

    it("RIPLINE_AGENT_RUNNER=stub forces stub even when config provides agentRunner", { timeout: 10000 }, async () => {
      const mockAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
        text: `[mock] ${agentId}: ${prompt.slice(0, 50)}`,
        tokenUsage: { input: 1, output: 2 },
      });
      await app.close();
      const prev = process.env.RIPLINE_AGENT_RUNNER;
      process.env.RIPLINE_AGENT_RUNNER = "stub";
      try {
        app = await createApp({ ...config, agentRunner: mockAgentRunner });
        const runRes = await app.inject({
          method: "POST",
          url: "/pipelines/ripline-area-owner/run",
          payload: { inputs: {} },
        });
        expect(runRes.statusCode).toBe(202);
        const { runId } = runRes.json() as { runId: string };

        let record: { status: string; steps?: { status: string; data?: { artifactValue?: { text?: string } } }[] } | null = null;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
          record = getRes.json() as typeof record;
          if (record?.status === "completed" || record?.status === "errored") break;
        }
        expect(record).toBeDefined();
        expect(record!.status).toBe("completed");
        const withArtifact = record!.steps?.filter(
          (s) => s.data && typeof (s.data as { artifactValue?: { text?: string } }).artifactValue?.text === "string"
        ) ?? [];
        expect(withArtifact.length).toBeGreaterThan(0);
        const firstText = (withArtifact[0]!.data as { artifactValue?: { text?: string } }).artifactValue?.text ?? "";
        expect(firstText).toMatch(/\[http-stub\]/);
        expect(firstText).not.toMatch(/\[mock\]/);
      } finally {
        if (prev !== undefined) process.env.RIPLINE_AGENT_RUNNER = prev;
        else delete process.env.RIPLINE_AGENT_RUNNER;
      }
    });
  });

  describe("DELETE /runs/prune", () => {
    it("returns 200 with pruned and skipped counts", async () => {
      // Create a run and mark it completed
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      // Wait for the run to reach a terminal state before manipulating run.json.
      // The background runner writes to run.json concurrently; we must not race it.
      for (let i = 0; i < 50; i++) {
        const statusRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
        const r = statusRes.json() as { status: string };
        if (r.status === "completed" || r.status === "errored") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Mark the run as completed in the run.json directly so it qualifies for pruning
      const runFile = path.join(config.runsDir!, runId, "run.json");
      const record = JSON.parse(await fs.readFile(runFile, "utf8")) as {
        status: string;
        updatedAt: number;
      };
      record.status = "completed";
      // Set updatedAt far in the past so it falls outside the 1-day window
      record.updatedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
      await fs.writeFile(runFile, JSON.stringify(record));

      const pruneRes = await app.inject({
        method: "DELETE",
        url: "/runs/prune?olderThanDays=1",
      });
      expect(pruneRes.statusCode).toBe(200);
      const body = pruneRes.json() as { pruned: number; skipped: number };
      expect(typeof body.pruned).toBe("number");
      expect(typeof body.skipped).toBe("number");
      expect(body.pruned).toBeGreaterThanOrEqual(1);

      // Run directory should be gone
      await expect(fs.access(path.join(config.runsDir!, runId))).rejects.toThrow();
    });

    it("does not prune runs that are too recent", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      // Mark run completed but recent
      const runFile = path.join(config.runsDir!, runId, "run.json");
      const record = JSON.parse(await fs.readFile(runFile, "utf8")) as {
        status: string;
        updatedAt: number;
      };
      record.status = "completed";
      // updatedAt is current (just now), well inside the 7-day window
      record.updatedAt = Date.now();
      await fs.writeFile(runFile, JSON.stringify(record));

      const pruneRes = await app.inject({
        method: "DELETE",
        url: "/runs/prune?olderThanDays=7",
      });
      expect(pruneRes.statusCode).toBe(200);
      const body = pruneRes.json() as { pruned: number; skipped: number };
      // This run should be skipped (too recent)
      expect(body.skipped).toBeGreaterThanOrEqual(1);

      // Run directory should still exist
      await expect(fs.access(path.join(config.runsDir!, runId))).resolves.toBeUndefined();
    });

    it("does not prune running or pending runs", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      // Leave the run as pending (default status), set updatedAt to old
      const runFile = path.join(config.runsDir!, runId, "run.json");
      const record = JSON.parse(await fs.readFile(runFile, "utf8")) as {
        status: string;
        updatedAt: number;
      };
      // status stays pending
      record.updatedAt = Date.now() - 30 * 24 * 60 * 60 * 1000;
      await fs.writeFile(runFile, JSON.stringify(record));

      const pruneRes = await app.inject({
        method: "DELETE",
        url: "/runs/prune?olderThanDays=1",
      });
      expect(pruneRes.statusCode).toBe(200);
      const body = pruneRes.json() as { pruned: number; skipped: number };
      expect(body.skipped).toBeGreaterThanOrEqual(1);

      // Run directory should still exist (status = pending, protected from prune)
      await expect(fs.access(path.join(config.runsDir!, runId))).resolves.toBeUndefined();
    });
  });
});
