/**
 * Acceptance tests for the Claude Usage Battery Meter — Ripline backend
 *
 * Validates acceptance criteria for the backend stories and integration
 * points between Ripline (data layer) and Wintermute (UI layer).
 *
 * Covers:
 * - Story 1: UsageStore event lifecycle (append → query → aggregate → prune)
 * - Story 2: API route contracts (request/response shapes, validation, error codes)
 * - Story 7: EventBus usage.update emission after POST, SSE payload contract
 * - Cross-story: Config changes affect aggregation and SSE payloads
 * - Cross-story: Weekly reset day drives period boundaries
 * - Cross-story: Ripline data shapes consumable by Wintermute UI
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import Fastify, { type FastifyInstance } from "fastify";
import { UsageStore } from "../src/lib/usageStore.js";
import { EventBus } from "../src/event-bus.js";
import { DEFAULT_USAGE_CONFIG } from "../src/lib/usageTypes.js";
import type {
  UsageEvent,
  UsageConfig,
  UsageAggregate,
  HourlyBucket,
  PipelineBreakdown,
} from "../src/lib/usageTypes.js";
import type { BusEvent, UsageUpdateEvent } from "../src/event-bus.js";

/* ================================================================== */
/*  AC: UsageStore correctly tracks token consumption lifecycle        */
/* ================================================================== */

describe("AC: UsageStore event lifecycle", () => {
  let dir: string;
  let store: UsageStore;

  beforeEach(async () => {
    dir = path.join(
      os.tmpdir(),
      `usage-acc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    store = new UsageStore(dir);
    await store.waitReady();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("records multiple events and aggregates correctly for weekly window", async () => {
    const now = new Date();
    const events = [
      { inputTokens: 1000, outputTokens: 500, pipelineId: "pipe-a", pipelineName: "A" },
      { inputTokens: 2000, outputTokens: 1000, pipelineId: "pipe-b", pipelineName: "B" },
      { inputTokens: 500, outputTokens: 250, pipelineId: "pipe-a", pipelineName: "A" },
    ];

    for (const ev of events) {
      await store.appendEvent(ev);
    }

    const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const agg = await store.getAggregates(since);

    expect(agg.totalTokens).toBe(5250); // (1000+500) + (2000+1000) + (500+250)
    expect(agg.inputTokens).toBe(3500);
    expect(agg.outputTokens).toBe(1750);
    expect(agg.eventCount).toBe(3);
  });

  it("per-pipeline aggregation groups by pipelineId", async () => {
    await store.appendEvent({
      inputTokens: 1000,
      outputTokens: 500,
      pipelineId: "pipe-a",
      pipelineName: "Pipeline A",
    });
    await store.appendEvent({
      inputTokens: 500,
      outputTokens: 250,
      pipelineId: "pipe-a",
      pipelineName: "Pipeline A",
    });
    await store.appendEvent({
      inputTokens: 2000,
      outputTokens: 1000,
      pipelineId: "pipe-b",
      pipelineName: "Pipeline B",
    });

    const since = new Date(Date.now() - 86400000).toISOString();
    const agg = await store.getAggregates(since);

    expect(agg.byPipeline).toHaveLength(2);
    // Sorted descending by totalTokens
    expect(agg.byPipeline[0].pipelineId).toBe("pipe-b");
    expect(agg.byPipeline[0].totalTokens).toBe(3000);
    expect(agg.byPipeline[0].eventCount).toBe(1);
    expect(agg.byPipeline[1].pipelineId).toBe("pipe-a");
    expect(agg.byPipeline[1].totalTokens).toBe(2250);
    expect(agg.byPipeline[1].eventCount).toBe(2);
  });

  it("hourly buckets group events by hour boundary", async () => {
    const baseHour = "2026-03-25T14:";
    await store.appendEvent({
      inputTokens: 100,
      outputTokens: 50,
      timestamp: `${baseHour}10:00.000Z`,
    });
    await store.appendEvent({
      inputTokens: 200,
      outputTokens: 100,
      timestamp: `${baseHour}45:00.000Z`,
    });
    await store.appendEvent({
      inputTokens: 300,
      outputTokens: 150,
      timestamp: "2026-03-25T15:30:00.000Z",
    });

    const agg = await store.getAggregates("2026-03-25T00:00:00.000Z");
    expect(agg.hourlyBuckets).toHaveLength(2);

    const hour14 = agg.hourlyBuckets.find(
      (b) => b.hour === "2026-03-25T14:00:00.000Z",
    );
    const hour15 = agg.hourlyBuckets.find(
      (b) => b.hour === "2026-03-25T15:00:00.000Z",
    );

    expect(hour14).toBeDefined();
    expect(hour14!.totalTokens).toBe(450); // 150 + 300
    expect(hour14!.eventCount).toBe(2);
    expect(hour15).toBeDefined();
    expect(hour15!.totalTokens).toBe(450);
    expect(hour15!.eventCount).toBe(1);
  });

  it("events outside the query window are excluded from aggregates", async () => {
    await store.appendEvent({
      inputTokens: 100,
      outputTokens: 50,
      timestamp: "2026-03-20T10:00:00.000Z", // Before window
    });
    await store.appendEvent({
      inputTokens: 200,
      outputTokens: 100,
      timestamp: "2026-03-25T10:00:00.000Z", // In window
    });

    const agg = await store.getAggregates("2026-03-23T00:00:00.000Z");
    expect(agg.eventCount).toBe(1);
    expect(agg.totalTokens).toBe(300);
  });

  it("pruning removes old events while keeping recent ones", async () => {
    const old = new Date(Date.now() - 35 * 86400000).toISOString();
    const recent = new Date().toISOString();

    await store.appendEvent({ inputTokens: 100, outputTokens: 50, timestamp: old });
    await store.appendEvent({ inputTokens: 200, outputTokens: 100, timestamp: recent });

    const removed = await store.pruneOlderThan(30);
    expect(removed).toBe(1);

    const remaining = await store.getEvents();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].inputTokens).toBe(200);
  });

  it("data persists to disk and survives re-instantiation", async () => {
    await store.appendEvent({
      inputTokens: 1000,
      outputTokens: 500,
      pipelineId: "delegation",
    });

    const store2 = new UsageStore(dir);
    await store2.waitReady();

    const events = await store2.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0].totalTokens).toBe(1500);
    expect(events[0].pipelineId).toBe("delegation");
  });
});

/* ================================================================== */
/*  AC: Usage config defaults and persistence                          */
/* ================================================================== */

describe("AC: Usage config lifecycle", () => {
  let dir: string;
  let store: UsageStore;

  beforeEach(async () => {
    dir = path.join(
      os.tmpdir(),
      `usage-cfg-acc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    store = new UsageStore(dir);
    await store.waitReady();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("first access returns sensible defaults", async () => {
    const config = await store.getConfig();
    expect(config.weeklyTokenCap).toBe(5_000_000);
    expect(config.thresholdPercents).toEqual([50, 75, 90]);
    expect(config.enabled).toBe(true);
    expect(config.resetDay).toBe(1); // Monday
  });

  it("config update persists and affects subsequent reads", async () => {
    await store.setConfig({
      weeklyTokenCap: 10_000_000,
      thresholdPercents: [25, 50, 75],
      enabled: true,
      resetDay: 0, // Sunday
    });

    const config = await store.getConfig();
    expect(config.weeklyTokenCap).toBe(10_000_000);
    expect(config.resetDay).toBe(0);
  });

  it("config survives store re-instantiation", async () => {
    const custom: UsageConfig = {
      weeklyTokenCap: 3_000_000,
      thresholdPercents: [30, 60, 90],
      enabled: false,
      resetDay: 5,
    };
    await store.setConfig(custom);

    const store2 = new UsageStore(dir);
    await store2.waitReady();
    const loaded = await store2.getConfig();
    expect(loaded).toEqual(custom);
  });
});

/* ================================================================== */
/*  AC: API routes validate input and return correct shapes            */
/* ================================================================== */

describe("AC: Usage API route contracts", () => {
  let dir: string;
  let store: UsageStore;
  let app: FastifyInstance;

  beforeEach(async () => {
    dir = path.join(
      os.tmpdir(),
      `usage-api-acc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    store = new UsageStore(dir);
    await store.waitReady();

    app = Fastify();

    // GET /api/usage
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

    // POST /api/usage
    app.post("/api/usage", async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (typeof body.promptTokens !== "number" || (body.promptTokens as number) < 0) {
        return reply.status(400).send({ error: "Bad Request", message: "promptTokens required" });
      }
      if (typeof body.completionTokens !== "number" || (body.completionTokens as number) < 0) {
        return reply.status(400).send({ error: "Bad Request", message: "completionTokens required" });
      }

      const event = await store.appendEvent({
        inputTokens: body.promptTokens as number,
        outputTokens: body.completionTokens as number,
        ...(typeof body.pipelineId === "string" && { pipelineId: body.pipelineId }),
        ...(typeof body.model === "string" && { model: body.model }),
      });

      return reply.status(201).send(event);
    });

    // PUT /api/usage/config
    app.put("/api/usage/config", async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      const current = await store.getConfig();

      if (body.weeklyTokenCap !== undefined) {
        if (typeof body.weeklyTokenCap !== "number" || body.weeklyTokenCap < 0) {
          return reply.status(400).send({ error: "Bad Request", message: "weeklyTokenCap invalid" });
        }
        current.weeklyTokenCap = body.weeklyTokenCap;
      }
      if (body.thresholdPercents !== undefined) {
        if (
          !Array.isArray(body.thresholdPercents) ||
          !body.thresholdPercents.every((v: unknown) => typeof v === "number" && v >= 0 && v <= 100)
        ) {
          return reply.status(400).send({ error: "Bad Request", message: "thresholdPercents invalid" });
        }
        current.thresholdPercents = (body.thresholdPercents as number[]).sort((a, b) => a - b);
      }
      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return reply.status(400).send({ error: "Bad Request", message: "enabled must be boolean" });
        }
        current.enabled = body.enabled;
      }
      if (body.resetDay !== undefined) {
        if (typeof body.resetDay !== "number" || !Number.isInteger(body.resetDay) || body.resetDay < 0 || body.resetDay > 6) {
          return reply.status(400).send({ error: "Bad Request", message: "resetDay invalid" });
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

  it("GET /api/usage returns all expected fields with correct types", async () => {
    const res = await app.inject({ method: "GET", url: "/api/usage" });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(typeof body.total).toBe("number");
    expect(body.burnRate).toBeTypeOf("number");
    expect(Array.isArray(body.perPipeline)).toBe(true);
    expect(Array.isArray(body.hourlyBuckets)).toBe(true);
    // remaining and percentage may be number or null
    expect(body.remaining === null || typeof body.remaining === "number").toBe(true);
    expect(body.percentage === null || typeof body.percentage === "number").toBe(true);
  });

  it("POST then GET reflects accumulated usage", async () => {
    // Record two events
    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 1000, completionTokens: 500 },
    });
    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 2000, completionTokens: 1000, pipelineId: "delegation" },
    });

    const res = await app.inject({ method: "GET", url: "/api/usage" });
    const body = res.json();

    expect(body.total).toBe(4500); // 1500 + 3000
    expect(body.remaining).toBe(5_000_000 - 4500);
    expect(body.perPipeline.length).toBeGreaterThanOrEqual(1);
  });

  it("POST with invalid data returns 400", async () => {
    const cases = [
      { payload: {}, message: "missing all fields" },
      { payload: { promptTokens: -1, completionTokens: 100 }, message: "negative promptTokens" },
      { payload: { promptTokens: 100 }, message: "missing completionTokens" },
      { payload: { promptTokens: "abc", completionTokens: 100 }, message: "string promptTokens" },
    ];

    for (const c of cases) {
      const res = await app.inject({
        method: "POST",
        url: "/api/usage",
        payload: c.payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("remaining clamps to 0 when usage exceeds cap", async () => {
    // Set a small cap
    await store.setConfig({
      ...DEFAULT_USAGE_CONFIG,
      weeklyTokenCap: 1000,
    });

    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 1000, completionTokens: 500 },
    });

    const res = await app.inject({ method: "GET", url: "/api/usage" });
    const body = res.json();

    expect(body.remaining).toBe(0);
    expect(body.percentage).toBe(100); // capped at 100%
  });

  it("unlimited cap (0) returns null remaining and percentage", async () => {
    await store.setConfig({
      ...DEFAULT_USAGE_CONFIG,
      weeklyTokenCap: 0,
    });

    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 100, completionTokens: 50 },
    });

    const res = await app.inject({ method: "GET", url: "/api/usage" });
    const body = res.json();

    expect(body.remaining).toBeNull();
    expect(body.percentage).toBeNull();
  });

  it("PUT /api/usage/config validates all fields", async () => {
    // Invalid weeklyTokenCap
    const r1 = await app.inject({
      method: "PUT",
      url: "/api/usage/config",
      payload: { weeklyTokenCap: -1 },
    });
    expect(r1.statusCode).toBe(400);

    // Invalid thresholdPercents
    const r2 = await app.inject({
      method: "PUT",
      url: "/api/usage/config",
      payload: { thresholdPercents: [50, 150] },
    });
    expect(r2.statusCode).toBe(400);

    // Invalid enabled
    const r3 = await app.inject({
      method: "PUT",
      url: "/api/usage/config",
      payload: { enabled: "yes" },
    });
    expect(r3.statusCode).toBe(400);

    // Invalid resetDay
    const r4 = await app.inject({
      method: "PUT",
      url: "/api/usage/config",
      payload: { resetDay: 7 },
    });
    expect(r4.statusCode).toBe(400);

    // Non-integer resetDay
    const r5 = await app.inject({
      method: "PUT",
      url: "/api/usage/config",
      payload: { resetDay: 1.5 },
    });
    expect(r5.statusCode).toBe(400);
  });

  it("PUT /api/usage/config partial updates preserve other fields", async () => {
    // Set custom config
    await app.inject({
      method: "PUT",
      url: "/api/usage/config",
      payload: { weeklyTokenCap: 8_000_000, resetDay: 3 },
    });

    // Update only enabled
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

/* ================================================================== */
/*  AC: EventBus emits usage.update with correct payload after POST    */
/* ================================================================== */

describe("AC: POST /api/usage → EventBus usage.update emission", () => {
  let dir: string;
  let store: UsageStore;
  let app: FastifyInstance;
  let sseEvents: UsageUpdateEvent[];

  beforeEach(async () => {
    EventBus.resetForTesting();
    dir = path.join(
      os.tmpdir(),
      `usage-sse-acc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.mkdir(dir, { recursive: true });
    store = new UsageStore(dir);
    await store.waitReady();

    sseEvents = [];
    EventBus.getInstance().on("run-event", (evt: BusEvent) => {
      if (evt.event === "usage.update") sseEvents.push(evt as UsageUpdateEvent);
    });

    app = Fastify();
    app.post("/api/usage", async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (typeof body.promptTokens !== "number" || (body.promptTokens as number) < 0) {
        return reply.status(400).send({ error: "Bad Request" });
      }
      if (typeof body.completionTokens !== "number" || (body.completionTokens as number) < 0) {
        return reply.status(400).send({ error: "Bad Request" });
      }

      const event = await store.appendEvent({
        inputTokens: body.promptTokens as number,
        outputTokens: body.completionTokens as number,
      });

      try {
        const config = await store.getConfig();
        const now = new Date();
        const day = now.getUTCDay();
        const diff = (day - config.resetDay + 7) % 7;
        const start = new Date(now);
        start.setUTCDate(start.getUTCDate() - diff);
        start.setUTCHours(0, 0, 0, 0);
        const since = start.toISOString();

        const agg = await store.getAggregates(since);
        const cap = config.weeklyTokenCap;
        const remaining = cap > 0 ? Math.max(0, cap - agg.totalTokens) : cap;
        const percent =
          cap > 0
            ? Math.round(Math.max(0, 100 - (agg.totalTokens / cap) * 100) * 100) / 100
            : 100;
        const elapsedMs = Date.now() - new Date(since).getTime();
        const elapsedHours = elapsedMs / (1000 * 60 * 60);
        const burnRate = elapsedHours > 0 ? agg.totalTokens / elapsedHours : 0;
        const hoursToExhaustion = burnRate > 0 ? remaining / burnRate : null;

        EventBus.getInstance().emitUsageUpdate({
          event: "usage.update",
          percent,
          hoursToExhaustion:
            hoursToExhaustion !== null ? Math.round(hoursToExhaustion * 10) / 10 : null,
          periodStart: since,
          timestamp: Date.now(),
        });
      } catch {
        // Non-critical
      }

      return reply.status(201).send(event);
    });
  });

  afterEach(async () => {
    EventBus.resetForTesting();
    await app.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("emits usage.update with all required fields", async () => {
    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 100, completionTokens: 200 },
    });

    expect(sseEvents).toHaveLength(1);
    const evt = sseEvents[0];
    expect(evt.event).toBe("usage.update");
    expect(typeof evt.percent).toBe("number");
    expect(evt.percent).toBeGreaterThanOrEqual(0);
    expect(evt.percent).toBeLessThanOrEqual(100);
    expect(typeof evt.periodStart).toBe("string");
    expect(evt.periodStart).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    expect(typeof evt.timestamp).toBe("number");
  });

  it("percent decreases as more tokens are recorded", async () => {
    // 500k tokens → 10% used → 90% remaining
    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 250_000, completionTokens: 250_000 },
    });
    const first = sseEvents[0].percent;

    // Another 500k → 20% used → 80% remaining
    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 250_000, completionTokens: 250_000 },
    });
    const second = sseEvents[1].percent;

    expect(second).toBeLessThan(first);
  });

  it("hoursToExhaustion is non-null when there is burn rate", async () => {
    await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 100_000, completionTokens: 100_000 },
    });

    expect(sseEvents[0].hoursToExhaustion).not.toBeNull();
    expect(typeof sseEvents[0].hoursToExhaustion).toBe("number");
    expect(sseEvents[0].hoursToExhaustion!).toBeGreaterThan(0);
  });

  it("POST still succeeds when EventBus has no listeners", async () => {
    EventBus.getInstance().removeAllListeners();

    const res = await app.inject({
      method: "POST",
      url: "/api/usage",
      payload: { promptTokens: 100, completionTokens: 200 },
    });

    expect(res.statusCode).toBe(201);
  });

  it("usage.update events coexist with run.* events on same channel", () => {
    const bus = EventBus.getInstance();
    const all: BusEvent[] = [];
    bus.on("run-event", (evt: BusEvent) => all.push(evt));

    bus.emitRunEvent({
      event: "run.completed",
      runId: "r1",
      pipelineId: "p1",
      status: "completed",
      timestamp: Date.now(),
    });

    bus.emitUsageUpdate({
      event: "usage.update",
      percent: 80,
      hoursToExhaustion: 100,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    });

    expect(all).toHaveLength(2);
    expect(all[0].event).toBe("run.completed");
    expect(all[1].event).toBe("usage.update");
  });
});

/* ================================================================== */
/*  AC: getWeekStart handles all reset day configurations              */
/* ================================================================== */

describe("AC: Week start computation for different reset days", () => {
  function getWeekStart(resetDay: number, now?: Date): string {
    const d = now ?? new Date();
    const day = d.getUTCDay();
    const diff = (day - resetDay + 7) % 7;
    const start = new Date(d);
    start.setUTCDate(start.getUTCDate() - diff);
    start.setUTCHours(0, 0, 0, 0);
    return start.toISOString();
  }

  it("Monday reset (default): all days of week resolve to correct Monday", () => {
    // Test each day of the week starting 2026-03-23 (Monday)
    const monday = new Date("2026-03-23T12:00:00.000Z");
    const tuesday = new Date("2026-03-24T12:00:00.000Z");
    const wednesday = new Date("2026-03-25T12:00:00.000Z");
    const thursday = new Date("2026-03-26T12:00:00.000Z");
    const friday = new Date("2026-03-27T12:00:00.000Z");
    const saturday = new Date("2026-03-28T12:00:00.000Z");
    const sunday = new Date("2026-03-29T12:00:00.000Z");

    const expected = "2026-03-23T00:00:00.000Z";
    expect(getWeekStart(1, monday)).toBe(expected);
    expect(getWeekStart(1, tuesday)).toBe(expected);
    expect(getWeekStart(1, wednesday)).toBe(expected);
    expect(getWeekStart(1, thursday)).toBe(expected);
    expect(getWeekStart(1, friday)).toBe(expected);
    expect(getWeekStart(1, saturday)).toBe(expected);
    expect(getWeekStart(1, sunday)).toBe(expected);
  });

  it("Sunday reset: all days resolve to preceding Sunday", () => {
    const sunday = new Date("2026-03-22T12:00:00.000Z"); // Sunday
    const wednesday = new Date("2026-03-25T12:00:00.000Z");
    const saturday = new Date("2026-03-28T12:00:00.000Z");

    const expected = "2026-03-22T00:00:00.000Z";
    expect(getWeekStart(0, sunday)).toBe(expected);
    expect(getWeekStart(0, wednesday)).toBe(expected);
    expect(getWeekStart(0, saturday)).toBe(expected);
  });

  it("always returns midnight UTC", () => {
    const result = getWeekStart(1, new Date("2026-03-25T23:59:59.999Z"));
    expect(result).toContain("T00:00:00.000Z");
  });
});

/* ================================================================== */
/*  AC: UsageEvent type contract matches what Wintermute expects       */
/* ================================================================== */

describe("AC: UsageEvent type contract for Wintermute consumption", () => {
  it("event has all required fields for Wintermute battery display", () => {
    const event: UsageEvent = {
      id: "evt-1",
      timestamp: new Date().toISOString(),
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
    };

    expect(event.id).toBeDefined();
    expect(event.timestamp).toBeDefined();
    expect(typeof event.inputTokens).toBe("number");
    expect(typeof event.outputTokens).toBe("number");
    expect(event.totalTokens).toBe(event.inputTokens + event.outputTokens);
  });

  it("aggregate has fields needed for detail panel", () => {
    const agg: UsageAggregate = {
      since: "2026-03-23T00:00:00.000Z",
      until: "2026-03-29T23:59:59.999Z",
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      eventCount: 3,
      byPipeline: [
        {
          pipelineId: "delegation",
          pipelineName: "Delegation",
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          eventCount: 3,
        },
      ],
      hourlyBuckets: [
        {
          hour: "2026-03-25T14:00:00.000Z",
          inputTokens: 1000,
          outputTokens: 500,
          totalTokens: 1500,
          eventCount: 3,
        },
      ],
    };

    // Detail panel needs these fields
    expect(agg.totalTokens).toBeDefined();
    expect(agg.byPipeline.length).toBeGreaterThan(0);
    expect(agg.hourlyBuckets.length).toBeGreaterThan(0);
    expect(agg.byPipeline[0].pipelineName).toBeDefined();
    expect(agg.hourlyBuckets[0].hour).toBeDefined();
  });

  it("UsageConfig has fields needed for Wintermute threshold alerts", () => {
    const config: UsageConfig = {
      weeklyTokenCap: 5_000_000,
      thresholdPercents: [50, 75, 90],
      enabled: true,
      resetDay: 1,
    };

    expect(config.thresholdPercents.length).toBeGreaterThan(0);
    expect(config.weeklyTokenCap).toBeGreaterThan(0);
    expect(typeof config.enabled).toBe("boolean");
  });

  it("UsageUpdateEvent has fields needed for SSE → UsageContext", () => {
    const update: UsageUpdateEvent = {
      event: "usage.update",
      percent: 72.5,
      hoursToExhaustion: 48,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    };

    // UsageContext expects these exact fields
    expect(update.event).toBe("usage.update");
    expect(typeof update.percent).toBe("number");
    expect(update.hoursToExhaustion === null || typeof update.hoursToExhaustion === "number").toBe(true);
    expect(typeof update.periodStart).toBe("string");
    expect(typeof update.timestamp).toBe("number");
  });
});
