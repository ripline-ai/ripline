/**
 * Tests for the file-backed UsageStore (Story 1)
 *
 * Covers:
 * - Event append with auto-generated id/timestamp/totalTokens
 * - Event querying by time window
 * - Aggregation: totals, per-pipeline breakdown, hourly buckets
 * - Config CRUD with defaults on first access
 * - Pruning of events older than N days
 * - File persistence (events survive re-instantiation)
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { UsageStore } from "../src/lib/usageStore.js";
import { DEFAULT_USAGE_CONFIG } from "../src/lib/usageTypes.js";
import type { UsageEvent, UsageConfig } from "../src/lib/usageTypes.js";

describe("UsageStore", () => {
  let dir: string;
  let store: UsageStore;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `usage-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(dir, { recursive: true });
    store = new UsageStore(dir);
    await store.waitReady();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  /* ------------------------------------------------------------------ */
  /*  Event append                                                       */
  /* ------------------------------------------------------------------ */

  describe("appendEvent", () => {
    it("auto-generates id, timestamp, and computes totalTokens", async () => {
      const ev = await store.appendEvent({
        inputTokens: 100,
        outputTokens: 200,
      });

      expect(ev.id).toBeDefined();
      expect(typeof ev.id).toBe("string");
      expect(ev.id.length).toBeGreaterThan(0);
      expect(ev.timestamp).toBeDefined();
      expect(new Date(ev.timestamp).getTime()).not.toBeNaN();
      expect(ev.totalTokens).toBe(300);
      expect(ev.inputTokens).toBe(100);
      expect(ev.outputTokens).toBe(200);
    });

    it("preserves optional fields (pipelineId, pipelineName, model, meta)", async () => {
      const ev = await store.appendEvent({
        inputTokens: 50,
        outputTokens: 75,
        pipelineId: "pipe-1",
        pipelineName: "Delegation",
        model: "claude-sonnet-4-20250514",
        meta: { runId: "run-42" },
      });

      expect(ev.pipelineId).toBe("pipe-1");
      expect(ev.pipelineName).toBe("Delegation");
      expect(ev.model).toBe("claude-sonnet-4-20250514");
      expect(ev.meta).toEqual({ runId: "run-42" });
    });

    it("allows caller-supplied id and timestamp", async () => {
      const ev = await store.appendEvent({
        id: "custom-id",
        timestamp: "2026-03-01T00:00:00.000Z",
        inputTokens: 10,
        outputTokens: 20,
      });

      expect(ev.id).toBe("custom-id");
      expect(ev.timestamp).toBe("2026-03-01T00:00:00.000Z");
    });

    it("always recomputes totalTokens as inputTokens + outputTokens", async () => {
      const ev = await store.appendEvent({
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 999, // should be ignored
      });

      expect(ev.totalTokens).toBe(30);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Event querying                                                     */
  /* ------------------------------------------------------------------ */

  describe("getEvents", () => {
    it("returns all events when no time window is specified", async () => {
      await store.appendEvent({ inputTokens: 10, outputTokens: 5 });
      await store.appendEvent({ inputTokens: 20, outputTokens: 10 });

      const events = await store.getEvents();
      expect(events).toHaveLength(2);
    });

    it("filters events by since/until", async () => {
      await store.appendEvent({
        inputTokens: 10,
        outputTokens: 5,
        timestamp: "2026-03-01T00:00:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 20,
        outputTokens: 10,
        timestamp: "2026-03-15T00:00:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 30,
        outputTokens: 15,
        timestamp: "2026-03-28T00:00:00.000Z",
      });

      const filtered = await store.getEvents(
        "2026-03-10T00:00:00.000Z",
        "2026-03-20T00:00:00.000Z",
      );
      expect(filtered).toHaveLength(1);
      expect(filtered[0].inputTokens).toBe(20);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Aggregation                                                        */
  /* ------------------------------------------------------------------ */

  describe("getAggregates", () => {
    it("computes correct totals", async () => {
      await store.appendEvent({
        inputTokens: 100,
        outputTokens: 200,
        timestamp: "2026-03-25T10:00:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 300,
        outputTokens: 400,
        timestamp: "2026-03-25T12:00:00.000Z",
      });

      const agg = await store.getAggregates("2026-03-25T00:00:00.000Z");
      expect(agg.inputTokens).toBe(400);
      expect(agg.outputTokens).toBe(600);
      expect(agg.totalTokens).toBe(1000);
      expect(agg.eventCount).toBe(2);
    });

    it("builds per-pipeline breakdown sorted by totalTokens descending", async () => {
      await store.appendEvent({
        inputTokens: 100,
        outputTokens: 50,
        pipelineId: "pipe-a",
        pipelineName: "Pipeline A",
        timestamp: "2026-03-25T10:00:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 500,
        outputTokens: 300,
        pipelineId: "pipe-b",
        pipelineName: "Pipeline B",
        timestamp: "2026-03-25T11:00:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 200,
        outputTokens: 100,
        pipelineId: "pipe-a",
        pipelineName: "Pipeline A",
        timestamp: "2026-03-25T12:00:00.000Z",
      });

      const agg = await store.getAggregates("2026-03-25T00:00:00.000Z");
      expect(agg.byPipeline).toHaveLength(2);
      // pipe-b (800 total) should be first, pipe-a (450 total) second
      expect(agg.byPipeline[0].pipelineId).toBe("pipe-b");
      expect(agg.byPipeline[0].totalTokens).toBe(800);
      expect(agg.byPipeline[0].eventCount).toBe(1);
      expect(agg.byPipeline[1].pipelineId).toBe("pipe-a");
      expect(agg.byPipeline[1].totalTokens).toBe(450);
      expect(agg.byPipeline[1].eventCount).toBe(2);
    });

    it("builds hourly buckets sorted chronologically", async () => {
      await store.appendEvent({
        inputTokens: 10,
        outputTokens: 5,
        timestamp: "2026-03-25T10:30:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 20,
        outputTokens: 10,
        timestamp: "2026-03-25T10:45:00.000Z",
      });
      await store.appendEvent({
        inputTokens: 40,
        outputTokens: 20,
        timestamp: "2026-03-25T12:15:00.000Z",
      });

      const agg = await store.getAggregates("2026-03-25T00:00:00.000Z");
      expect(agg.hourlyBuckets).toHaveLength(2);
      expect(agg.hourlyBuckets[0].hour).toBe("2026-03-25T10:00:00.000Z");
      expect(agg.hourlyBuckets[0].totalTokens).toBe(45); // 15 + 30
      expect(agg.hourlyBuckets[0].eventCount).toBe(2);
      expect(agg.hourlyBuckets[1].hour).toBe("2026-03-25T12:00:00.000Z");
      expect(agg.hourlyBuckets[1].totalTokens).toBe(60);
    });

    it("returns empty aggregate for windows with no events", async () => {
      const agg = await store.getAggregates("2026-03-25T00:00:00.000Z");
      expect(agg.totalTokens).toBe(0);
      expect(agg.eventCount).toBe(0);
      expect(agg.byPipeline).toEqual([]);
      expect(agg.hourlyBuckets).toEqual([]);
    });

    it("groups events without pipelineId under _none_", async () => {
      await store.appendEvent({
        inputTokens: 100,
        outputTokens: 50,
        timestamp: "2026-03-25T10:00:00.000Z",
      });

      const agg = await store.getAggregates("2026-03-25T00:00:00.000Z");
      expect(agg.byPipeline).toHaveLength(1);
      expect(agg.byPipeline[0].pipelineId).toBe("_none_");
      expect(agg.byPipeline[0].pipelineName).toBe("unknown");
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Pruning                                                            */
  /* ------------------------------------------------------------------ */

  describe("pruneOlderThan", () => {
    it("removes events older than N days", async () => {
      const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date().toISOString();

      await store.appendEvent({ inputTokens: 10, outputTokens: 5, timestamp: old });
      await store.appendEvent({ inputTokens: 20, outputTokens: 10, timestamp: recent });

      const removed = await store.pruneOlderThan(30);
      expect(removed).toBe(1);

      const events = await store.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].inputTokens).toBe(20);
    });

    it("returns 0 when no events need pruning", async () => {
      await store.appendEvent({ inputTokens: 10, outputTokens: 5 });
      const removed = await store.pruneOlderThan(30);
      expect(removed).toBe(0);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  Config                                                             */
  /* ------------------------------------------------------------------ */

  describe("config", () => {
    it("returns default config on first access", async () => {
      const config = await store.getConfig();
      expect(config).toEqual(DEFAULT_USAGE_CONFIG);
      expect(config.weeklyTokenCap).toBe(5_000_000);
      expect(config.thresholdPercents).toEqual([50, 75, 90]);
      expect(config.enabled).toBe(true);
      expect(config.resetDay).toBe(1);
    });

    it("persists and retrieves updated config", async () => {
      const newConfig: UsageConfig = {
        weeklyTokenCap: 10_000_000,
        thresholdPercents: [25, 50, 75],
        enabled: false,
        resetDay: 0,
      };

      await store.setConfig(newConfig);
      const loaded = await store.getConfig();
      expect(loaded).toEqual(newConfig);
    });

    it("config persists across store re-instantiation", async () => {
      const newConfig: UsageConfig = {
        weeklyTokenCap: 3_000_000,
        thresholdPercents: [30, 60, 90],
        enabled: true,
        resetDay: 5,
      };

      await store.setConfig(newConfig);

      // Create a new store pointing at the same directory
      const store2 = new UsageStore(dir);
      await store2.waitReady();
      const loaded = await store2.getConfig();
      expect(loaded).toEqual(newConfig);
    });
  });

  /* ------------------------------------------------------------------ */
  /*  File persistence                                                   */
  /* ------------------------------------------------------------------ */

  describe("persistence", () => {
    it("events persist to disk and survive re-instantiation", async () => {
      await store.appendEvent({
        inputTokens: 100,
        outputTokens: 200,
        pipelineId: "pipe-1",
      });

      const store2 = new UsageStore(dir);
      await store2.waitReady();
      const events = await store2.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].totalTokens).toBe(300);
      expect(events[0].pipelineId).toBe("pipe-1");
    });

    it("auto-prunes events older than 30 days on startup", async () => {
      // Seed with an old event directly on disk
      const oldEvent: UsageEvent = {
        id: "old-1",
        timestamp: new Date(Date.now() - 35 * 24 * 60 * 60 * 1000).toISOString(),
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      };
      const recentEvent: UsageEvent = {
        id: "recent-1",
        timestamp: new Date().toISOString(),
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      };

      await fs.writeFile(
        path.join(dir, "events.json"),
        JSON.stringify([oldEvent, recentEvent]),
      );

      const store2 = new UsageStore(dir);
      await store2.waitReady();
      const events = await store2.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe("recent-1");
    });
  });
});
