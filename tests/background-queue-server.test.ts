import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig } from "../src/types.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

/**
 * Tests for the background queue REST endpoints (Story 3)
 * and the background-queue config toggle (Story 5/7).
 */
describe("Background Queue REST endpoints", () => {
  let config: PipelinePluginConfig;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    const runsDir = path.join(os.tmpdir(), `ripline-bq-server-${Date.now()}`);
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

  // ─── Story 3: POST /queue ──────────────────────────────

  describe("POST /queue", () => {
    it("creates a queue item and returns 201 with the item", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "test-pipeline", inputs: { task: "hello" } },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeDefined();
      expect(body.pipeline).toBe("test-pipeline");
      expect(body.inputs).toEqual({ task: "hello" });
      expect(body.status).toBe("pending");
      expect(body.retries).toBe(0);
    });

    it("returns 400 when pipeline is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { inputs: {} },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("pipeline");
    });

    it("returns 400 when pipeline is empty string", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "  " },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when inputs is not an object", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "p", inputs: "bad" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain("inputs");
    });

    it("returns 400 when severityWeight is not a number", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "p", severityWeight: "high" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("accepts optional severityWeight, manualBoost, and maxRetries", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/queue",
        payload: { pipeline: "p", severityWeight: 5, manualBoost: 3, maxRetries: 2 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.severityWeight).toBe(5);
      expect(body.manualBoost).toBe(3);
      expect(body.maxRetries).toBe(2);
    });
  });

  // ─── Story 3: GET /queue ───────────────────────────────

  describe("GET /queue", () => {
    it("returns all items with computedPriority field", async () => {
      // Add two items
      await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "a" } });
      await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "b" } });

      const res = await app.inject({ method: "GET", url: "/queue" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.items).toHaveLength(2);
      expect(body.items[0]).toHaveProperty("computedPriority");
    });

    it("returns empty array when no items exist", async () => {
      const res = await app.inject({ method: "GET", url: "/queue" });
      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([]);
    });
  });

  // ─── Story 3: GET /queue/approved ──────────────────────

  describe("GET /queue/approved", () => {
    it("returns only pending items", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "a" } });
      const id = created.json().id;

      // Add another and patch it to completed
      const created2 = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "b" } });
      const id2 = created2.json().id;
      await app.inject({ method: "PATCH", url: `/queue/${id2}`, payload: { status: "completed" } });

      const res = await app.inject({ method: "GET", url: "/queue/approved" });
      expect(res.statusCode).toBe(200);
      const items = res.json().items;
      expect(items).toHaveLength(1);
      expect(items[0].id).toBe(id);
    });
  });

  // ─── Story 3: PATCH /queue/:id ─────────────────────────

  describe("PATCH /queue/:id", () => {
    it("updates allowed fields and returns updated item", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "p" } });
      const id = created.json().id;

      const res = await app.inject({
        method: "PATCH",
        url: `/queue/${id}`,
        payload: { manualBoost: 42, status: "running" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.manualBoost).toBe(42);
      expect(body.status).toBe("running");
    });

    it("returns 404 for nonexistent item", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: "/queue/nonexistent-id",
        payload: { manualBoost: 1 },
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 400 for invalid status value", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "p" } });
      const id = created.json().id;

      const res = await app.inject({
        method: "PATCH",
        url: `/queue/${id}`,
        payload: { status: "invalid" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when manualBoost is not a number", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "p" } });
      const id = created.json().id;

      const res = await app.inject({
        method: "PATCH",
        url: `/queue/${id}`,
        payload: { manualBoost: "high" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Story 3: DELETE /queue/:id ────────────────────────

  describe("DELETE /queue/:id", () => {
    it("removes item and returns 204", async () => {
      const created = await app.inject({ method: "POST", url: "/queue", payload: { pipeline: "p" } });
      const id = created.json().id;

      const res = await app.inject({ method: "DELETE", url: `/queue/${id}` });
      expect(res.statusCode).toBe(204);

      // Verify gone
      const list = await app.inject({ method: "GET", url: "/queue" });
      expect(list.json().items).toHaveLength(0);
    });

    it("returns 404 for nonexistent item", async () => {
      const res = await app.inject({ method: "DELETE", url: "/queue/nope" });
      expect(res.statusCode).toBe(404);
    });
  });

  // ─── Story 5/7: GET & PUT /config/background-queue ─────

  describe("GET /config/background-queue", () => {
    it("returns current enabled state", async () => {
      const res = await app.inject({ method: "GET", url: "/config/background-queue" });
      expect(res.statusCode).toBe(200);
      expect(typeof res.json().enabled).toBe("boolean");
    });
  });

  describe("PUT /config/background-queue", () => {
    it("toggles enabled state and returns updated config", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().backgroundQueue.enabled).toBe(true);

      // Verify via GET
      const check = await app.inject({ method: "GET", url: "/config/background-queue" });
      expect(check.json().enabled).toBe(true);

      // Disable
      const off = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: { enabled: false },
      });
      expect(off.json().backgroundQueue.enabled).toBe(false);
    });

    it("returns 400 when enabled is not a boolean", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: { enabled: "yes" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when body is empty", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/background-queue",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Story 1: Run source tagging (integration check) ──

  describe("run source tagging", () => {
    it("POST /pipelines/:id/run creates a run (default source is user)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = res.json();
      expect(body.runId).toBeDefined();
    });
  });
});
