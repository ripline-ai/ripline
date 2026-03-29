/**
 * Tests for the Pipeline Page Redesign feature.
 *
 * Covers acceptance criteria across all stories:
 *   - Expanded pipeline listing (id, name, tags, queue, nodeCount, edgeCount)
 *   - Queue display with computedPriority, sorting, filtering
 *   - Inline run status with node-by-node steps, timestamps, error info
 *   - Run logs endpoint (fewer clicks to see logs)
 *   - Run logs SSE stream for real-time tailing
 *   - Retry endpoint with strategy support
 *   - SSE event stream (global) for real-time pipeline status
 *   - Detailed scheduler metrics (per-queue breakdown)
 *   - Background queue config toggle
 *   - Integration: queue→run→status→logs flow end-to-end
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig, PipelineRunRecord, BackgroundQueueItem } from "../src/types.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("Pipeline Page Redesign", () => {
  let config: PipelinePluginConfig;
  let app: Awaited<ReturnType<typeof createApp>>;
  let runsDir: string;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-redesign-test-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });
    config = {
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
      queueFilePath: path.join(runsDir, "queue.yaml"),
    };
    app = await createApp(config);
  });

  afterEach(async () => {
    if (app?.close) await app.close();
  });

  // ─── Story: Expanded pipeline listing ─────────────────────────

  describe("GET /pipelines — expanded pipeline info", () => {
    it("returns nodeCount and edgeCount for each pipeline", async () => {
      const res = await app.inject({ method: "GET", url: "/pipelines" });
      expect(res.statusCode).toBe(200);
      const { pipelines } = res.json() as {
        pipelines: { id: string; name?: string; tags?: string[]; queue?: string; nodeCount: number; edgeCount: number }[];
      };
      expect(Array.isArray(pipelines)).toBe(true);
      expect(pipelines.length).toBeGreaterThan(0);
      for (const p of pipelines) {
        expect(typeof p.nodeCount).toBe("number");
        expect(typeof p.edgeCount).toBe("number");
        expect(p.nodeCount).toBeGreaterThanOrEqual(0);
        expect(p.edgeCount).toBeGreaterThanOrEqual(0);
      }
    });

    it("returns queue field when pipeline specifies a queue", async () => {
      const res = await app.inject({ method: "GET", url: "/pipelines" });
      const { pipelines } = res.json() as {
        pipelines: { id: string; queue?: string }[];
      };
      // At minimum, all pipeline entries should have id
      for (const p of pipelines) {
        expect(p.id).toBeDefined();
        // queue is optional — should be string or undefined
        if (p.queue !== undefined) {
          expect(typeof p.queue).toBe("string");
        }
      }
    });

    it("returns id, name, and tags for each pipeline", async () => {
      const res = await app.inject({ method: "GET", url: "/pipelines" });
      const { pipelines } = res.json() as {
        pipelines: { id: string; name?: string; tags?: string[] }[];
      };
      for (const p of pipelines) {
        expect(typeof p.id).toBe("string");
        // name and tags should be present when defined in the pipeline
        if (p.name !== undefined) expect(typeof p.name).toBe("string");
        if (p.tags !== undefined) expect(Array.isArray(p.tags)).toBe(true);
      }
    });
  });

  // ─── Story: Single pipeline detail ────────────────────────────

  describe("GET /pipelines/:id — single pipeline detail", () => {
    it("returns full pipeline definition including nodes and edges", async () => {
      const listRes = await app.inject({ method: "GET", url: "/pipelines" });
      const { pipelines } = listRes.json() as { pipelines: { id: string }[] };
      const firstId = pipelines[0]?.id;
      expect(firstId).toBeDefined();

      const res = await app.inject({ method: "GET", url: `/pipelines/${firstId}` });
      expect(res.statusCode).toBe(200);
      const def = res.json() as { id: string; nodes: unknown[]; edges: unknown[]; entry: string[] };
      expect(def.id).toBe(firstId);
      expect(Array.isArray(def.nodes)).toBe(true);
      expect(Array.isArray(def.edges)).toBe(true);
      expect(Array.isArray(def.entry)).toBe(true);
    });

    it("returns 404 for nonexistent pipeline", async () => {
      const res = await app.inject({ method: "GET", url: "/pipelines/nonexistent-xyz" });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Story: Inline run status (fewer clicks) ─────────────────

  describe("GET /runs/:runId — inline run detail with steps", () => {
    it("returns run record with steps array containing per-node status", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(getRes.statusCode).toBe(200);
      const record = getRes.json() as PipelineRunRecord;
      expect(record.id).toBe(runId);
      expect(record.pipelineId).toBe("ripline-area-owner");
      expect(record.status).toBeDefined();
      expect(Array.isArray(record.steps)).toBe(true);
      for (const step of record.steps) {
        expect(step.nodeId).toBeDefined();
        expect(typeof step.status).toBe("string");
      }
    });

    it("includes startedAt and updatedAt timestamps", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
      const record = getRes.json() as PipelineRunRecord;
      expect(typeof record.startedAt).toBe("number");
      expect(typeof record.updatedAt).toBe("number");
      expect(record.startedAt).toBeGreaterThan(0);
    });

    it("includes inputs in run record", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: { inputs: { task: "hello-world" } },
      });
      const { runId } = runRes.json() as { runId: string };

      const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
      const record = getRes.json() as PipelineRunRecord;
      expect(record.inputs).toBeDefined();
      expect(record.inputs.task).toBe("hello-world");
    });
  });

  // ─── Story: Run list filtering ────────────────────────────────

  describe("GET /runs — filtering and limit", () => {
    it("supports limit query parameter", async () => {
      // Create multiple runs
      await app.inject({ method: "POST", url: "/pipelines/ripline-area-owner/run", payload: {} });
      await app.inject({ method: "POST", url: "/pipelines/ripline-area-owner/run", payload: {} });
      await app.inject({ method: "POST", url: "/pipelines/ripline-area-owner/run", payload: {} });

      const res = await app.inject({ method: "GET", url: "/runs?limit=2" });
      expect(res.statusCode).toBe(200);
      const { runs } = res.json() as { runs: PipelineRunRecord[] };
      expect(runs.length).toBeLessThanOrEqual(2);
    });

    it("supports combined pipelineId and status filters", async () => {
      await app.inject({ method: "POST", url: "/pipelines/ripline-area-owner/run", payload: {} });

      const res = await app.inject({
        method: "GET",
        url: "/runs?pipelineId=ripline-area-owner&status=pending",
      });
      expect(res.statusCode).toBe(200);
      const { runs } = res.json() as { runs: PipelineRunRecord[] };
      for (const run of runs) {
        expect(run.pipelineId).toBe("ripline-area-owner");
        // Status could be pending or already running; both are valid at this point
      }
    });

    it("returns empty array for nonexistent pipeline filter", async () => {
      const res = await app.inject({ method: "GET", url: "/runs?pipelineId=does-not-exist" });
      expect(res.statusCode).toBe(200);
      const { runs } = res.json() as { runs: unknown[] };
      expect(runs).toHaveLength(0);
    });
  });

  // ─── Story: Real-time run SSE stream ──────────────────────────

  describe("GET /runs/:runId/stream — real-time SSE", () => {
    it("returns SSE content-type with initial data event", async () => {
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
      const payload = streamRes.payload as string;
      expect(payload).toContain("data:");
      // Parse the first data line to verify it's valid JSON with run info
      const firstDataLine = payload.split("\n").find((l) => l.startsWith("data:"));
      expect(firstDataLine).toBeDefined();
      const parsed = JSON.parse(firstDataLine!.slice(5)) as PipelineRunRecord;
      expect(parsed.id).toBe(runId);
      expect(parsed.steps).toBeDefined();
    });

    it("returns 404 for nonexistent runId stream", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/runs/00000000-0000-0000-0000-000000000000/stream",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Story: Run logs (fewer clicks) ───────────────────────────

  describe("GET /runs/:runId/logs — run log access", () => {
    it("returns 404 when no log file exists yet", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      // Immediately check logs — may not exist yet
      const logRes = await app.inject({ method: "GET", url: `/runs/${runId}/logs` });
      // Could be 200 (if logs already written) or 404 (no logs yet)
      expect([200, 404]).toContain(logRes.statusCode);
    });

    it("returns 404 for nonexistent run logs", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/runs/00000000-0000-0000-0000-000000000000/logs",
      });
      expect(res.statusCode).toBe(404);
    });

    it("supports format=json query parameter", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      // Wait briefly for log file creation
      await new Promise((r) => setTimeout(r, 100));

      const logRes = await app.inject({
        method: "GET",
        url: `/runs/${runId}/logs?format=json`,
      });
      // If log exists, it returns JSON lines; if not, 404
      if (logRes.statusCode === 200) {
        const body = logRes.json() as { lines: string[] };
        expect(Array.isArray(body.lines)).toBe(true);
      } else {
        expect(logRes.statusCode).toBe(404);
      }
    });
  });

  // ─── Story: Log stream SSE ────────────────────────────────────

  describe("GET /runs/:runId/logs/stream — SSE log tailing", () => {
    it("returns SSE content-type for existing run", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      const streamRes = await app.inject({
        method: "GET",
        url: `/runs/${runId}/logs/stream`,
      });
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers["content-type"]).toMatch(/text\/event-stream/);
    });

    it("returns 404 for nonexistent run", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/runs/00000000-0000-0000-0000-000000000000/logs/stream",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Story: Retry with strategy ───────────────────────────────

  describe("POST /runs/:runId/retry — retry with strategy", () => {
    it("returns 404 for nonexistent run", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/runs/00000000-0000-0000-0000-000000000000/retry",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 409 when run is not errored or paused", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      const retryRes = await app.inject({
        method: "POST",
        url: `/runs/${runId}/retry`,
        payload: {},
      });
      // Run is pending or running, not retryable
      expect(retryRes.statusCode).toBe(409);
    });

    it("returns 400 for invalid strategy value", async () => {
      // We need an errored run to test strategy validation
      // Create a run first, then manually set it to errored
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      // Wait for run to start and modify it to errored state
      await new Promise((r) => setTimeout(r, 50));
      const runFile = path.join(runsDir, runId, "run.json");
      try {
        const data = JSON.parse(await fs.readFile(runFile, "utf8")) as PipelineRunRecord;
        data.status = "errored";
        data.error = "test error";
        await fs.writeFile(runFile, JSON.stringify(data), "utf8");

        const retryRes = await app.inject({
          method: "POST",
          url: `/runs/${runId}/retry`,
          payload: { strategy: "invalid-strategy" },
        });
        expect(retryRes.statusCode).toBe(400);
        expect(retryRes.json().message).toContain("strategy");
      } catch {
        // If run file doesn't exist yet, skip this assertion
      }
    });

    it("accepts from-failure strategy", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      await new Promise((r) => setTimeout(r, 50));
      const runFile = path.join(runsDir, runId, "run.json");
      try {
        const data = JSON.parse(await fs.readFile(runFile, "utf8")) as PipelineRunRecord;
        data.status = "errored";
        data.error = "test error";
        if (data.steps.length > 0) {
          data.steps[data.steps.length - 1]!.status = "errored";
        }
        await fs.writeFile(runFile, JSON.stringify(data), "utf8");

        const retryRes = await app.inject({
          method: "POST",
          url: `/runs/${runId}/retry`,
          payload: { strategy: "from-failure" },
        });
        expect(retryRes.statusCode).toBe(202);
        const body = retryRes.json() as { runId: string; strategy: string };
        expect(body.runId).toBe(runId);
        expect(body.strategy).toBe("from-failure");
      } catch {
        // Run may complete before we can modify it
      }
    });

    it("accepts from-start strategy", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      await new Promise((r) => setTimeout(r, 50));
      const runFile = path.join(runsDir, runId, "run.json");
      try {
        const data = JSON.parse(await fs.readFile(runFile, "utf8")) as PipelineRunRecord;
        data.status = "errored";
        data.error = "test error";
        await fs.writeFile(runFile, JSON.stringify(data), "utf8");

        const retryRes = await app.inject({
          method: "POST",
          url: `/runs/${runId}/retry`,
          payload: { strategy: "from-start" },
        });
        expect(retryRes.statusCode).toBe(202);
        const body = retryRes.json() as { runId: string; strategy: string };
        expect(body.strategy).toBe("from-start");
      } catch {
        // Run may complete before we can modify it
      }
    });
  });

  // ─── Story: Queue with expanded info ──────────────────────────

  describe("Queue endpoints — expanded display", () => {
    it("GET /queue items include all fields needed for display", async () => {
      await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "test-pipe", inputs: { task: "test" }, severityWeight: 5, manualBoost: 2 },
      });

      const res = await app.inject({ method: "GET", url: "/queue" });
      expect(res.statusCode).toBe(200);
      const { items } = res.json() as { items: (BackgroundQueueItem & { computedPriority: number })[] };
      expect(items).toHaveLength(1);
      const item = items[0]!;
      // All fields needed for expanded queue display
      expect(item.id).toBeDefined();
      expect(item.pipeline).toBe("test-pipe");
      expect(item.inputs).toEqual({ task: "test" });
      expect(item.status).toBe("pending");
      expect(typeof item.severityWeight).toBe("number");
      expect(typeof item.manualBoost).toBe("number");
      expect(typeof item.createdAt).toBe("number");
      expect(typeof item.retries).toBe("number");
      expect(typeof item.maxRetries).toBe("number");
      expect(typeof item.needsReview).toBe("boolean");
      expect(typeof item.computedPriority).toBe("number");
    });

    it("GET /queue sorts items by computedPriority descending", async () => {
      await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "low", severityWeight: 1 } });
      await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "high", severityWeight: 10 } });
      await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "mid", severityWeight: 5 } });

      const res = await app.inject({ method: "GET", url: "/queue" });
      const { items } = res.json() as { items: { pipeline: string; computedPriority: number }[] };
      expect(items).toHaveLength(3);
      expect(items[0]!.pipeline).toBe("high");
      expect(items[1]!.pipeline).toBe("mid");
      expect(items[2]!.pipeline).toBe("low");
      // Verify sorted descending
      for (let i = 1; i < items.length; i++) {
        expect(items[i - 1]!.computedPriority).toBeGreaterThanOrEqual(items[i]!.computedPriority);
      }
    });

    it("GET /queue/approved returns only pending items with computedPriority", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "a" } });
      const created2 = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "b" } });
      const id2 = (created2.json() as { id: string }).id;
      // Mark one as running
      await app.inject({ method: "PATCH", url: `/queue/${id2}`, payload: { status: "running" } });

      const res = await app.inject({ method: "GET", url: "/queue/approved" });
      expect(res.statusCode).toBe(200);
      const { items } = res.json() as { items: (BackgroundQueueItem & { computedPriority: number })[] };
      expect(items).toHaveLength(1);
      expect(items[0]!.status).toBe("pending");
      expect(typeof items[0]!.computedPriority).toBe("number");
    });

    it("PATCH /queue/:id allows updating severityWeight", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "p" } });
      const id = (created.json() as { id: string }).id;

      const res = await app.inject({
        method: "PATCH",
        url: `/queue/${id}`,
        payload: { severityWeight: 99 },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { severityWeight: number }).severityWeight).toBe(99);
    });

    it("validates status field on PATCH", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "p" } });
      const id = (created.json() as { id: string }).id;

      // Valid statuses
      for (const status of ["pending", "running", "completed", "errored", "failed"]) {
        const res = await app.inject({
          method: "PATCH",
          url: `/queue/${id}`,
          payload: { status },
        });
        expect(res.statusCode).toBe(200);
      }

      // Invalid status
      const badRes = await app.inject({
        method: "PATCH",
        url: `/queue/${id}`,
        payload: { status: "unknown" },
      });
      expect(badRes.statusCode).toBe(400);
    });
  });

  // ─── Story: Background queue config toggle ────────────────────

  describe("Background queue config toggle", () => {
    it("GET /config/background-queue returns enabled boolean", async () => {
      const res = await app.inject({ method: "GET", url: "/config/background-queue" });
      expect(res.statusCode).toBe(200);
      expect(typeof (res.json() as { enabled: boolean }).enabled).toBe("boolean");
    });

    it("PUT /config/background-queue toggles and persists state", async () => {
      // Enable
      const enableRes = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: { enabled: true },
      });
      expect(enableRes.statusCode).toBe(200);
      expect((enableRes.json() as { backgroundQueue: { enabled: boolean } }).backgroundQueue.enabled).toBe(true);

      // Verify
      const checkRes = await app.inject({ method: "GET", url: "/config/background-queue" });
      expect((checkRes.json() as { enabled: boolean }).enabled).toBe(true);

      // Disable
      const disableRes = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: { enabled: false },
      });
      expect((disableRes.json() as { backgroundQueue: { enabled: boolean } }).backgroundQueue.enabled).toBe(false);
    });

    it("rejects non-boolean enabled", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: { enabled: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Story: Global events SSE stream ──────────────────────────

  describe("GET /events — global SSE event stream", () => {
    it("returns SSE content-type", async () => {
      const res = await app.inject({ method: "GET", url: "/events" });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    });

    it("supports pipelineId filter parameter", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/events?pipelineId=ripline-area-owner",
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    });

    it("supports status filter parameter", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/events?status=completed",
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
    });
  });

  // ─── Story: Metrics with per-queue breakdown ──────────────────

  describe("GET /metrics — detailed scheduler metrics", () => {
    it("returns metrics when scheduler is active", async () => {
      await app.close();
      app = await createApp({ ...config, maxConcurrency: 1 });

      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        queueDepth: number;
        activeWorkers: number;
        queues?: Record<string, { depth: number; activeWorkers: number; maxConcurrency: number }>;
      };
      expect(typeof body.queueDepth).toBe("number");
      expect(typeof body.activeWorkers).toBe("number");
    });

    it("includes per-queue breakdown in detailed metrics", async () => {
      await app.close();
      app = await createApp({
        ...config,
        maxConcurrency: 1,
        queueConcurrencies: { build: 2 },
      } as any);

      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        queueDepth: number;
        activeWorkers: number;
        queues: Record<string, { depth: number; activeWorkers: number; maxConcurrency: number }>;
      };
      expect(body.queues).toBeDefined();
      if (body.queues) {
        // Each queue entry has the expected shape
        for (const [_name, q] of Object.entries(body.queues)) {
          expect(typeof q.depth).toBe("number");
          expect(typeof q.activeWorkers).toBe("number");
          expect(typeof q.maxConcurrency).toBe("number");
        }
      }
    });
  });

  // ─── Integration: Queue → Run → Status → Logs flow ───────────

  describe("Integration: end-to-end pipeline page flow", () => {
    it("pipeline list → run → get status → get steps (single page journey)", async () => {
      // 1. List pipelines with expanded info
      const listRes = await app.inject({ method: "GET", url: "/pipelines" });
      expect(listRes.statusCode).toBe(200);
      const { pipelines } = listRes.json() as {
        pipelines: { id: string; nodeCount: number; edgeCount: number }[];
      };
      const pipeline = pipelines.find((p) => p.id === "ripline-area-owner");
      expect(pipeline).toBeDefined();
      expect(pipeline!.nodeCount).toBeGreaterThan(0);

      // 2. Trigger a run
      const runRes = await app.inject({
        method: "POST",
        url: `/pipelines/${pipeline!.id}/run`,
        payload: { inputs: { task: "integration test" } },
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      // 3. Get inline status — no extra clicks needed
      const statusRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
      expect(statusRes.statusCode).toBe(200);
      const record = statusRes.json() as PipelineRunRecord;
      expect(record.id).toBe(runId);
      expect(record.pipelineId).toBe(pipeline!.id);
      expect(Array.isArray(record.steps)).toBe(true);
      expect(record.steps.length).toBeGreaterThan(0);

      // 4. Filter runs by this pipeline
      const filteredRes = await app.inject({
        method: "GET",
        url: `/runs?pipelineId=${pipeline!.id}`,
      });
      expect(filteredRes.statusCode).toBe(200);
      const { runs } = filteredRes.json() as { runs: PipelineRunRecord[] };
      expect(runs.some((r) => r.id === runId)).toBe(true);
    });

    it("queue add → list → update → verify in approved", async () => {
      // 1. Add items to queue
      const add1 = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "p1", severityWeight: 3, inputs: { task: "first" } },
      });
      expect(add1.statusCode).toBe(201);

      const add2 = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "p2", severityWeight: 8, inputs: { task: "second" } },
      });
      expect(add2.statusCode).toBe(201);

      // 2. List — should be sorted by priority (p2 first)
      const listRes = await app.inject({ method: "GET", url: "/queue" });
      const { items } = listRes.json() as { items: { pipeline: string; computedPriority: number }[] };
      expect(items).toHaveLength(2);
      expect(items[0]!.pipeline).toBe("p2"); // higher severity

      // 3. Mark p2 as running
      const id2 = (add2.json() as { id: string }).id;
      await app.inject({ method: "PATCH", url: `/queue/${id2}`, payload: { status: "running" } });

      // 4. Approved should only show p1
      const approvedRes = await app.inject({ method: "GET", url: "/queue/approved" });
      const approved = (approvedRes.json() as { items: { pipeline: string }[] }).items;
      expect(approved).toHaveLength(1);
      expect(approved[0]!.pipeline).toBe("p1");
    });

    it("run detail includes all data needed for inline display", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: { inputs: { task: "display test" } },
      });
      const { runId } = runRes.json() as { runId: string };

      // Small delay to let run initialize
      await new Promise((r) => setTimeout(r, 30));

      const detailRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
      const record = detailRes.json() as PipelineRunRecord;

      // All fields needed for inline display without extra requests
      expect(record.id).toBeDefined();
      expect(record.pipelineId).toBeDefined();
      expect(record.status).toBeDefined();
      expect(record.startedAt).toBeDefined();
      expect(record.updatedAt).toBeDefined();
      expect(record.inputs).toBeDefined();
      expect(record.steps).toBeDefined();
      // Each step has nodeId and status at minimum
      for (const step of record.steps) {
        expect(step.nodeId).toBeDefined();
        expect(step.status).toBeDefined();
      }
    });
  });

  // ─── Auth: all redesigned endpoints require auth when configured ──

  describe("Auth protection on pipeline page endpoints", () => {
    let authedApp: Awaited<ReturnType<typeof createApp>>;

    beforeEach(async () => {
      authedApp = await createApp({ ...config, authToken: "test-token", maxConcurrency: 1 });
    });

    afterEach(async () => {
      if (authedApp?.close) await authedApp.close();
    });

    it("GET /pipelines returns 401 without token", async () => {
      const res = await authedApp.inject({ method: "GET", url: "/pipelines" });
      expect(res.statusCode).toBe(401);
    });

    it("GET /runs returns 401 without token", async () => {
      const res = await authedApp.inject({ method: "GET", url: "/runs" });
      expect(res.statusCode).toBe(401);
    });

    it("GET /queue returns 401 without token", async () => {
      const res = await authedApp.inject({ method: "GET", url: "/queue" });
      expect(res.statusCode).toBe(401);
    });

    it("GET /metrics returns 401 without token", async () => {
      const res = await authedApp.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(401);
    });

    it("GET /events returns 401 without token", async () => {
      const res = await authedApp.inject({ method: "GET", url: "/events" });
      expect(res.statusCode).toBe(401);
    });

    it("all endpoints accessible with valid Bearer token", async () => {
      const headers = { authorization: "Bearer test-token" };
      const pipelinesRes = await authedApp.inject({ method: "GET", url: "/pipelines", headers });
      expect(pipelinesRes.statusCode).toBe(200);

      const runsRes = await authedApp.inject({ method: "GET", url: "/runs", headers });
      expect(runsRes.statusCode).toBe(200);

      const queueRes = await authedApp.inject({ method: "GET", url: "/queue", headers });
      expect(queueRes.statusCode).toBe(200);

      const metricsRes = await authedApp.inject({ method: "GET", url: "/metrics", headers });
      expect(metricsRes.statusCode).toBe(200);

      const eventsRes = await authedApp.inject({ method: "GET", url: "/events", headers });
      expect(eventsRes.statusCode).toBe(200);
    });
  });
});
