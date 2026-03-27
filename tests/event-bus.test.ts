import { describe, expect, it, beforeEach } from "vitest";
import { EventBus } from "../src/event-bus.js";
import type { RunEvent } from "../src/event-bus.js";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import { MemoryRunStore } from "../src/run-store-memory.js";
import type { PipelineDefinition } from "../src/types.js";

beforeEach(() => {
  EventBus.resetForTesting();
});

describe("EventBus", () => {
  it("getInstance returns the same singleton across calls", () => {
    const a = EventBus.getInstance();
    const b = EventBus.getInstance();
    expect(a).toBe(b);
  });

  it("resetForTesting creates a fresh instance", () => {
    const a = EventBus.getInstance();
    EventBus.resetForTesting();
    const b = EventBus.getInstance();
    expect(a).not.toBe(b);
  });

  it("emitRunEvent delivers typed events to listeners", () => {
    const bus = EventBus.getInstance();
    const received: RunEvent[] = [];
    bus.on("run-event", (e: RunEvent) => received.push(e));

    const event: RunEvent = {
      event: "run.started",
      runId: "r1",
      pipelineId: "p1",
      status: "running",
      timestamp: Date.now(),
    };
    bus.emitRunEvent(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
  });
});

describe("DeterministicRunner → EventBus integration", () => {
  /**
   * 2-node pipeline: input → transform
   * Verifies that the global EventBus receives events in the correct order:
   *   run.started → node.started(input) → node.completed(input)
   *                → node.started(transform) → node.completed(transform) → run.completed
   */
  it("listener on bus receives events in order for a 2-node pipeline run", async () => {
    const definition: PipelineDefinition = {
      id: "test-two-node",
      entry: ["input-node"],
      nodes: [
        { id: "input-node", type: "input", path: "task" },
        {
          id: "transform-node",
          type: "transform",
          expression: "artifacts['input-node.result'] || 'transformed'",
          assigns: "result",
        },
      ],
      edges: [
        { from: { node: "input-node" }, to: { node: "transform-node" } },
      ],
    };

    const store = new MemoryRunStore();
    const bus = EventBus.getInstance();
    const events: RunEvent[] = [];
    bus.on("run-event", (e: RunEvent) => events.push(e));

    const runner = new DeterministicRunner(definition, { store, quiet: true });
    const record = await runner.run({ inputs: { task: "hello" } });

    expect(record.status).toBe("completed");

    // Verify event count: run.started + 2*(node.started + node.completed) + run.completed = 6
    expect(events).toHaveLength(6);

    // Verify order of event types
    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toEqual([
      "run.started",
      "node.started",
      "node.completed",
      "node.started",
      "node.completed",
      "run.completed",
    ]);

    // All events share the same runId and pipelineId
    for (const e of events) {
      expect(e.runId).toBe(record.id);
      expect(e.pipelineId).toBe("test-two-node");
      expect(e.timestamp).toBeGreaterThan(0);
    }

    // Node events carry correct nodeIds
    expect(events[1]!.nodeId).toBe("input-node");
    expect(events[2]!.nodeId).toBe("input-node");
    expect(events[3]!.nodeId).toBe("transform-node");
    expect(events[4]!.nodeId).toBe("transform-node");

    // Run-level events have no nodeId
    expect(events[0]!.nodeId).toBeUndefined();
    expect(events[5]!.nodeId).toBeUndefined();
  });

  it("emits run.errored and node.errored when a node fails", async () => {
    const definition: PipelineDefinition = {
      id: "test-error",
      entry: ["bad-node"],
      nodes: [
        {
          id: "bad-node",
          type: "transform",
          expression: "throw new Error('boom')",
        },
      ],
      edges: [],
    };

    const store = new MemoryRunStore();
    const bus = EventBus.getInstance();
    const events: RunEvent[] = [];
    bus.on("run-event", (e: RunEvent) => events.push(e));

    const runner = new DeterministicRunner(definition, { store, quiet: true });
    await expect(runner.run({ inputs: {} })).rejects.toThrow();

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toEqual([
      "run.started",
      "node.started",
      "node.errored",
      "run.errored",
    ]);

    // The errored events should reference the failing node
    expect(events[2]!.nodeId).toBe("bad-node");
    expect(events[3]!.event).toBe("run.errored");
  });
});
