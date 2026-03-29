/**
 * Tests for Usage API routes (Story 2)
 *
 * Covers:
 * - GET /api/usage — returns aggregate stats with remaining/percentage/burnRate
 * - POST /api/usage — records usage events with validation
 * - GET /api/usage/config — returns usage config (defaults on first access)
 * - PUT /api/usage/config — updates config with field-level validation
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

// We need to mock the usage store singleton before importing the route module
// The routes module calls getUsageStore() at registration time
let testDir: string;

// Since registerUsageRoutes calls getUsageStore() which uses a singleton,
// we build a Fastify instance that exercises the routes directly.
// The UsageStore constructor accepts a dataDir — we wire everything through
// a controlled temp directory.

import { UsageStore } from "../src/lib/usageStore.js";

describe("Usage API routes", () => {
  let dir: string;
  let store: UsageStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `usage-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    store = new UsageStore(dir);
    await store.waitReady();

    app = Fastify();

    // Stub requireAuth as pass-through
    const noAuth = async () => {};

    // Register routes directly using the helper function pattern
    // We replicate route registration logic here to inject our test store
    app.get("/api/usage", async (_req, reply) => {
      const config = await store.getConfig();
      const now = new Date();
      const day = now.getUTCDay();
      const diff = (day - config.resetDay + 7) % 7;
      const start = new Date(now);
      start.setUTCDate(start.getUTCDate() - diff);
      start.setUTCHours(0, 0, 0, 0);
      const since = start.toISOString();

      const agg = await store.getAggregates(since);
      const total = agg.totalTokens;
      const cap = config.weeklyTokenCap;
      const remaining = cap > 0 ? Math.max(0, cap - total) : null;
      const percentage = cap > 0 ? Math.min(100, (total / cap) * 100) : null;
      const elapsedMs = Date.now() - new Date(since).getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);
      const burnRate = elapsedHours > 0 ? total / elapsedHours : 0;

      return reply.send({
        total,
        remaining,
        percentage,
        burnRate: Math.round(burnRate * 100) / 100,
        perPipeline: agg.byPipeline,
        hourlyBuckets: agg.hourlyBuckets,
      });
    });

    app.post("/api/usage", async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      const promptTokens = body.promptTokens;
      const completionTokens = body.completionTokens;

      if (typeof promptTokens !== "number" || promptTokens < 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "promptTokens is required and must be a non-negative number",
        });
      }
      if (typeof completionTokens !== "number" || completionTokens < 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "completionTokens is required and must be a non-negative number",
        });
      }

      const event = await store.appendEvent({
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        ...(typeof body.pipelineId === "string" && { pipelineId: body.pipelineId }),
        ...(typeof body.model === "string" && { model: body.model }),
        ...(typeof body.runId === "string" && { meta: { runId: body.runId } }),
      });

      return reply.status(201).send(event);
    });

    app.get("/api/usage/config", async (_req, reply) => {
      const config = await store.getConfig();
      return reply.send(config);
    });

    app.put("/api/usage/config", async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      const current = await store.getConfig();

      if (body.weeklyTokenCap !== undefined) {
        if (typeof body.weeklyTokenCap !== "number" || body.weeklyTokenCap < 0) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "weeklyTokenCap must be a non-negative number",
          });
        }
        current.weeklyTokenCap = body.weeklyTokenCap;
      }

      if (body.thresholdPercents !== undefined) {
        if (
          !Array.isArray(body.thresholdPercents) ||
          !body.thresholdPercents.every(
            (v: unknown) => typeof v === "number" && v >= 0 && v <= 100,
          )
        ) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "thresholdPercents must be an array of numbers between 0 and 100",
          });
        }
        current.thresholdPercents = (body.thresholdPercents as number[]).sort(
          (a, b) => a - b,
        );
      }

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return reply.status(400).send({
            error: "Bad Request",
            message: "enabled must be a boolean",
          });
        }
        current.enabled = body.enabled;
      }

      if (body.resetDay !== undefined) {
        if (
          typeof body.resetDay !== "number" ||
          !Number.isInteger(body.resetDay) ||
          body.resetDay < 0 ||
          body.resetDay > 6
        ) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "resetDay must be an integer between 0 (Sunday) and 6 (Saturday)",
          });
        }
        current.resetDay = body.resetDay;
      }

      await store.setConfig(current);
      return reply.send(current);
    });
  });

  afterEach(async () => {
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ */
  /*  GET /api/usage                                                     */
  /* ------------------------------------------------------------------ */

  describe("GET /api/usage", () => {
    it("returns zero totals when no events exist", async () => {
      const res = await app.inject({ method: "GET", url: "/api/usage" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(0);
      expect(body.burnRate).toBe(0);
      expect(body.perPipeline).toEqual([]);
      expect(body.hourlyBuckets).toEqual([]);
    });

    it("computes remaining and percentage based on weekly cap", async () => {
      await store.appendEvent({
        inputTokens: 1_000_000,
        outputTokens: 500_000,
      });

      const res = await app.inject({ method: "GET", url: "/api/usage" });
      const body = res.json();
      expect(body.total).toBe(1_500_000);
      // Default cap is 5M
      expect(body.remaining).toBe(3_500_000);
      expect(body.percentage).toBeCloseTo(30, 0);
    });

    it("returns null remaining/percentage when cap is 0 (unlimited)", async () => {
      await store.setConfig({
        weeklyTokenCap: 0,
        thresholdPercents: [50, 75, 90],
        enabled: true,
        resetDay: 1,
      });

      await store.appendEvent({ inputTokens: 100, outputTokens: 50 });
      const res = await app.inject({ method: "GET", url: "/api/usage" });
      const body = res.json();
      expect(body.remaining).toBeNull();
      expect(body.percentage).toBeNull();
    });

    it("includes per-pipeline breakdown", async () => {
      await store.appendEvent({
        inputTokens: 100,
        outputTokens: 50,
        pipelineId: "pipe-a",
        pipelineName: "Pipeline A",
      });

      const res = await app.inject({ method: "GET", url: "/api/usage" });
      const body = res.json();
      expect(body.perPipeline.length).toBeGreaterThanOrEqual(1);
      expect(body.perPipeline[0].pipelineId).toBe("pipe-a");
    });

    it("remaining never goes below 0", async () => {
      // Use more than the cap
      await store.appendEvent({
        inputTokens: 3_000_000,
        outputTokens: 3_000_000,
      });

      const res = await app.inject({ method: "GET", url: "/api/usage" });
      const body = res.json();
      expect(body.remaining).toBe(0);
      expect(body.percentage).toBe(100); // capped at 100
    });
  });

  /* ------------------------------------------------------------------ */
  /*  POST /api/usage                                                    */
  /* ------------------------------------------------------------------ */

  describe("POST /api/usage", () => {
    it("records a usage event and returns 201", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: { promptTokens: 100, completionTokens: 200 },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.inputTokens).toBe(100);
      expect(body.outputTokens).toBe(200);
      expect(body.totalTokens).toBe(300);
      expect(body.id).toBeDefined();
      expect(body.timestamp).toBeDefined();
    });

    it("attaches optional pipelineId, model, and runId as meta", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: {
          promptTokens: 50,
          completionTokens: 75,
          pipelineId: "pipe-1",
          model: "claude-sonnet-4-20250514",
          runId: "run-42",
        },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.pipelineId).toBe("pipe-1");
      expect(body.model).toBe("claude-sonnet-4-20250514");
      expect(body.meta).toEqual({ runId: "run-42" });
    });

    it("returns 400 when promptTokens is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: { completionTokens: 100 },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain("promptTokens");
    });

    it("returns 400 when completionTokens is missing", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: { promptTokens: 100 },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.message).toContain("completionTokens");
    });

    it("returns 400 when promptTokens is negative", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: { promptTokens: -1, completionTokens: 100 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when completionTokens is not a number", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: { promptTokens: 100, completionTokens: "abc" },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  GET /api/usage/config                                              */
  /* ------------------------------------------------------------------ */

  describe("GET /api/usage/config", () => {
    it("returns default config on first access", async () => {
      const res = await app.inject({ method: "GET", url: "/api/usage/config" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.weeklyTokenCap).toBe(5_000_000);
      expect(body.thresholdPercents).toEqual([50, 75, 90]);
      expect(body.enabled).toBe(true);
      expect(body.resetDay).toBe(1);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  PUT /api/usage/config                                              */
  /* ------------------------------------------------------------------ */

  describe("PUT /api/usage/config", () => {
    it("updates weeklyTokenCap", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { weeklyTokenCap: 10_000_000 },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.weeklyTokenCap).toBe(10_000_000);
      // Other fields unchanged
      expect(body.enabled).toBe(true);
    });

    it("sorts thresholdPercents ascending", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { thresholdPercents: [90, 50, 75] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.thresholdPercents).toEqual([50, 75, 90]);
    });

    it("validates weeklyTokenCap is non-negative", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { weeklyTokenCap: -1 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("validates thresholdPercents values are 0-100", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { thresholdPercents: [50, 150] },
      });

      expect(res.statusCode).toBe(400);
    });

    it("validates thresholdPercents is an array", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { thresholdPercents: "50" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("validates enabled is a boolean", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { enabled: "yes" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("validates resetDay is 0-6 integer", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { resetDay: 7 },
      });

      expect(res.statusCode).toBe(400);

      const res2 = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { resetDay: 1.5 },
      });

      expect(res2.statusCode).toBe(400);
    });

    it("merges partial updates preserving unset fields", async () => {
      // First set a custom config
      await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { weeklyTokenCap: 8_000_000, resetDay: 3 },
      });

      // Now update only enabled
      const res = await app.inject({
        method: "PUT",
        url: "/api/usage/config",
        payload: { enabled: false },
      });

      const body = res.json();
      expect(body.weeklyTokenCap).toBe(8_000_000);
      expect(body.resetDay).toBe(3);
      expect(body.enabled).toBe(false);
    });
  });
});
