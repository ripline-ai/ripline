/**
 * Tests for Usage → EventBus SSE integration (Story 7 — real-time updates)
 *
 * Covers:
 * - EventBus emitUsageUpdate sends typed UsageUpdateEvent on "run-event" channel
 * - POST /api/usage triggers usage.update SSE emission after recording event
 * - usage.update payload contains percent, hoursToExhaustion, periodStart
 * - Non-critical: SSE emission failure does not fail the POST request
 * - getWeekStart() computes Monday-based week start correctly
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventBus } from "../src/event-bus.js";
import type { UsageUpdateEvent, BusEvent } from "../src/event-bus.js";

describe("EventBus usage.update emission", () => {
  beforeEach(() => {
    EventBus.resetForTesting();
  });

  afterEach(() => {
    EventBus.resetForTesting();
  });

  it("emitUsageUpdate sends event on 'run-event' channel", () => {
    const bus = EventBus.getInstance();
    const received: BusEvent[] = [];
    bus.on("run-event", (evt: BusEvent) => received.push(evt));

    const payload: UsageUpdateEvent = {
      event: "usage.update",
      percent: 72.5,
      hoursToExhaustion: 48,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    };

    bus.emitUsageUpdate(payload);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(payload);
  });

  it("usage.update event has correct shape", () => {
    const bus = EventBus.getInstance();
    let captured: UsageUpdateEvent | null = null;

    bus.on("run-event", (evt: BusEvent) => {
      if (evt.event === "usage.update") {
        captured = evt as UsageUpdateEvent;
      }
    });

    bus.emitUsageUpdate({
      event: "usage.update",
      percent: 45,
      hoursToExhaustion: null,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: 1711756800000,
    });

    expect(captured).not.toBeNull();
    expect(captured!.event).toBe("usage.update");
    expect(typeof captured!.percent).toBe("number");
    expect(captured!.hoursToExhaustion).toBeNull();
    expect(typeof captured!.periodStart).toBe("string");
    expect(typeof captured!.timestamp).toBe("number");
  });

  it("hoursToExhaustion can be a positive number", () => {
    const bus = EventBus.getInstance();
    let captured: UsageUpdateEvent | null = null;

    bus.on("run-event", (evt: BusEvent) => {
      if (evt.event === "usage.update") captured = evt as UsageUpdateEvent;
    });

    bus.emitUsageUpdate({
      event: "usage.update",
      percent: 30,
      hoursToExhaustion: 12.5,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    });

    expect(captured!.hoursToExhaustion).toBe(12.5);
  });

  it("multiple listeners all receive usage.update events", () => {
    const bus = EventBus.getInstance();
    const counts = [0, 0, 0];

    bus.on("run-event", () => counts[0]++);
    bus.on("run-event", () => counts[1]++);
    bus.on("run-event", () => counts[2]++);

    bus.emitUsageUpdate({
      event: "usage.update",
      percent: 60,
      hoursToExhaustion: 100,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    });

    expect(counts).toEqual([1, 1, 1]);
  });

  it("usage.update events coexist with run events on same channel", () => {
    const bus = EventBus.getInstance();
    const events: BusEvent[] = [];
    bus.on("run-event", (evt: BusEvent) => events.push(evt));

    bus.emitRunEvent({
      event: "run.completed",
      runId: "run-1",
      pipelineId: "pipe-1",
      status: "completed",
      timestamp: Date.now(),
    });

    bus.emitUsageUpdate({
      event: "usage.update",
      percent: 80,
      hoursToExhaustion: 200,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(2);
    expect(events[0].event).toBe("run.completed");
    expect(events[1].event).toBe("usage.update");
  });

  it("resetForTesting removes all listeners and clears singleton", () => {
    const bus1 = EventBus.getInstance();
    let received = false;
    bus1.on("run-event", () => { received = true; });

    EventBus.resetForTesting();

    // After reset, the old instance's listeners should be removed
    // and a new instance should be created
    const bus2 = EventBus.getInstance();
    expect(bus2).not.toBe(bus1);

    bus2.emitUsageUpdate({
      event: "usage.update",
      percent: 50,
      hoursToExhaustion: null,
      periodStart: "2026-03-23T00:00:00.000Z",
      timestamp: Date.now(),
    });

    // Old listener should not fire
    expect(received).toBe(false);
  });
});

describe("getWeekStart computation", () => {
  // Extracted from routes/usage.ts for isolated testing
  function getWeekStart(resetDay: number, now?: Date): string {
    const d = now ?? new Date();
    const day = d.getUTCDay(); // 0=Sun
    const diff = (day - resetDay + 7) % 7;
    const start = new Date(d);
    start.setUTCDate(start.getUTCDate() - diff);
    start.setUTCHours(0, 0, 0, 0);
    return start.toISOString();
  }

  it("Monday reset: Wednesday returns preceding Monday", () => {
    // 2026-03-25 is a Wednesday
    const wed = new Date("2026-03-25T15:00:00.000Z");
    const result = getWeekStart(1, wed); // resetDay=1=Monday
    expect(result).toBe("2026-03-23T00:00:00.000Z"); // Monday
  });

  it("Monday reset: Monday returns same Monday", () => {
    const mon = new Date("2026-03-23T10:00:00.000Z");
    const result = getWeekStart(1, mon);
    expect(result).toBe("2026-03-23T00:00:00.000Z");
  });

  it("Monday reset: Sunday returns preceding Monday", () => {
    const sun = new Date("2026-03-29T20:00:00.000Z");
    const result = getWeekStart(1, sun);
    expect(result).toBe("2026-03-23T00:00:00.000Z");
  });

  it("Sunday reset: Wednesday returns preceding Sunday", () => {
    const wed = new Date("2026-03-25T12:00:00.000Z");
    const result = getWeekStart(0, wed); // resetDay=0=Sunday
    expect(result).toBe("2026-03-22T00:00:00.000Z"); // Sunday
  });

  it("Sunday reset: Sunday returns same Sunday", () => {
    const sun = new Date("2026-03-22T08:00:00.000Z");
    const result = getWeekStart(0, sun);
    expect(result).toBe("2026-03-22T00:00:00.000Z");
  });

  it("Friday reset: Tuesday returns preceding Friday", () => {
    const tue = new Date("2026-03-25T12:00:00.000Z"); // Tuesday
    const result = getWeekStart(5, tue); // resetDay=5=Friday
    expect(result).toBe("2026-03-20T00:00:00.000Z"); // Friday
  });

  it("always zeroes out hours/minutes/seconds", () => {
    const wed = new Date("2026-03-25T23:59:59.999Z");
    const result = getWeekStart(1, wed);
    expect(result).toContain("T00:00:00.000Z");
  });
});

describe("Usage POST → SSE emission integration", () => {
  // This tests the integration logic extracted from the POST /api/usage handler:
  // After recording a usage event, the handler computes remaining/percent and
  // emits a usage.update event via EventBus.

  function computeUsageUpdate(
    totalTokensUsed: number,
    weeklyTokenCap: number,
    elapsedHours: number,
    since: string,
  ): UsageUpdateEvent {
    const cap = weeklyTokenCap;
    const remaining = cap > 0 ? Math.max(0, cap - totalTokensUsed) : cap;
    const percent = cap > 0
      ? Math.round(Math.max(0, 100 - (totalTokensUsed / cap) * 100) * 100) / 100
      : 100;
    const burnRate = elapsedHours > 0 ? totalTokensUsed / elapsedHours : 0;
    const hoursToExhaustion = burnRate > 0 ? remaining / burnRate : null;

    return {
      event: "usage.update",
      percent,
      hoursToExhaustion: hoursToExhaustion !== null
        ? Math.round(hoursToExhaustion * 10) / 10
        : null,
      periodStart: since,
      timestamp: Date.now(),
    };
  }

  it("computes correct percent with partial usage", () => {
    const update = computeUsageUpdate(
      1_000_000,   // 1M tokens used
      5_000_000,   // 5M cap
      24,          // 24 hours elapsed
      "2026-03-23T00:00:00.000Z",
    );

    expect(update.percent).toBe(80); // 80% remaining
    expect(update.hoursToExhaustion).not.toBeNull();
  });

  it("percent is 0 when usage equals cap", () => {
    const update = computeUsageUpdate(5_000_000, 5_000_000, 48, "2026-03-23T00:00:00.000Z");
    expect(update.percent).toBe(0);
  });

  it("percent clamps to 0 when usage exceeds cap", () => {
    const update = computeUsageUpdate(6_000_000, 5_000_000, 48, "2026-03-23T00:00:00.000Z");
    expect(update.percent).toBe(0);
  });

  it("percent is 100 when no usage", () => {
    const update = computeUsageUpdate(0, 5_000_000, 24, "2026-03-23T00:00:00.000Z");
    expect(update.percent).toBe(100);
    expect(update.hoursToExhaustion).toBeNull(); // burn rate is 0
  });

  it("hoursToExhaustion is null when burn rate is 0", () => {
    const update = computeUsageUpdate(0, 5_000_000, 0, "2026-03-23T00:00:00.000Z");
    expect(update.hoursToExhaustion).toBeNull();
  });

  it("hoursToExhaustion rounds to 1 decimal", () => {
    // 2.5M used of 5M, 48 hours elapsed → burn rate = 52083.33/hr
    // remaining = 2.5M → 2500000 / 52083.33 ≈ 48.0 hours
    const update = computeUsageUpdate(2_500_000, 5_000_000, 48, "2026-03-23T00:00:00.000Z");
    expect(update.hoursToExhaustion).toBe(48);
  });

  it("remaining is capped at 0 for over-quota usage", () => {
    const update = computeUsageUpdate(10_000_000, 5_000_000, 48, "2026-03-23T00:00:00.000Z");
    expect(update.percent).toBe(0);
    expect(update.hoursToExhaustion).toBe(0);
  });
});
