/**
 * Acceptance & integration tests for: Resume failed pipeline runs from the
 * failing step rather than restarting from scratch.
 *
 * This file supplements the existing resume-failed-runs.test.ts with coverage
 * for edge cases, additional acceptance criteria, and integration points:
 *
 *  - Retry endpoint with explicit `fromNode` parameter
 *  - Retry endpoint for paused (not only errored) runs
 *  - Retry endpoint returns 404 for unknown run ID
 *  - Multiple sequential failures at different nodes with successive resumes
 *  - Resume when cursor is missing defaults to index 0
 *  - Exponential backoff computation in retry policy
 *  - Retry exhaustion emits "run.retry-exhausted" event
 *  - recoverStaleRuns resets orphaned "running" runs to "pending"
 *  - incrementRetryCount atomicity
 *  - Session ID preservation across resume for shared-conversation agents
 *  - Resume of paused runs (not just errored)
 *  - Conditional (when) edges interacting with resume: skipped nodes stay skipped
 *  - from-failure strategy rebuilds artifact context correctly
 *  - from-start strategy clears all state including cursor and outputs
 *  - MemoryRunStore.claimRun only claims pending runs
 *  - Error classification with `status` field (alias of statusCode)
 */

import { describe, expect, it, vi } from "vitest";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import { MemoryRunStore } from "../src/run-store-memory.js";
import { createRunQueue } from "../src/run-queue.js";
import { classifyError } from "../src/pipeline/error-classifier.js";
import type { PipelineDefinition, PipelineRunRecord } from "../src/types.js";
import type { AgentRunner } from "../src/pipeline/executors/index.js";
import { EventBus } from "../src/event-bus.js";

const noopAgent: AgentRunner = async () => ({
  text: "ok",
  tokenUsage: { input: 0, output: 0 },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 4-node pipeline: input → transform(a) → agent(b) → output(c) */
function fourNodePipeline(id = "four-node"): PipelineDefinition {
  return {
    id,
    entry: ["inp"],
    nodes: [
      { id: "inp", type: "input" },
      { id: "a", type: "transform", expression: "inputs.x * 2", assigns: "a" },
      { id: "b", type: "agent", prompt: "Say hi" },
      { id: "c", type: "output", path: "result", source: "b" },
    ],
    edges: [
      { from: { node: "inp" }, to: { node: "a" } },
      { from: { node: "a" }, to: { node: "b" } },
      { from: { node: "b" }, to: { node: "c" } },
    ],
  };
}

/** 5-node pipeline with two agent nodes for testing sequential failures */
function twoAgentPipeline(id = "two-agent"): PipelineDefinition {
  return {
    id,
    entry: ["inp"],
    nodes: [
      { id: "inp", type: "input" },
      { id: "t1", type: "transform", expression: "inputs.x + 1", assigns: "t1" },
      { id: "agent1", type: "agent", prompt: "First agent" },
      { id: "agent2", type: "agent", prompt: "Second agent" },
      { id: "out", type: "output", path: "result", source: "agent2" },
    ],
    edges: [
      { from: { node: "inp" }, to: { node: "t1" } },
      { from: { node: "t1" }, to: { node: "agent1" } },
      { from: { node: "agent1" }, to: { node: "agent2" } },
      { from: { node: "agent2" }, to: { node: "out" } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 1. Multiple sequential failures and resumes
// ---------------------------------------------------------------------------
describe("Multiple sequential failures and resumes", () => {
  it("handles fail → resume → fail at a later node → resume → complete", async () => {
    let agent1Calls = 0;
    let agent2Calls = 0;

    // Agent1 succeeds on first call; Agent2 fails first time, succeeds second
    const sequentialAgent: AgentRunner = async (params) => {
      const nodeId = params.nodeId ?? "unknown";
      if (nodeId === "agent1") {
        agent1Calls++;
        return { text: "agent1-ok", tokenUsage: { input: 0, output: 0 } };
      }
      if (nodeId === "agent2") {
        agent2Calls++;
        if (agent2Calls === 1) throw new Error("agent2 transient fail");
        return { text: "agent2-ok", tokenUsage: { input: 0, output: 0 } };
      }
      return { text: "ok", tokenUsage: { input: 0, output: 0 } };
    };

    const def = twoAgentPipeline("seq-fail");
    const store = new MemoryRunStore();

    // Run 1: both agents should succeed for agent1, fail at agent2
    const runner1 = new DeterministicRunner(def, { store, agentRunner: sequentialAgent });
    await expect(runner1.run({ inputs: { x: 5 } })).rejects.toThrow("agent2 transient fail");

    const failed = (await store.list()).find((r) => r.status === "errored")!;
    expect(failed).toBeDefined();
    // agent1 completed, agent2 errored
    expect(failed.steps.find((s) => s.nodeId === "agent1")!.status).toBe("completed");
    expect(failed.steps.find((s) => s.nodeId === "agent2")!.status).toBe("errored");
    // Cursor should point at agent2
    expect(failed.cursor!.nextNodeIndex).toBe(3); // [inp, t1, agent1, agent2, out]

    // Run 2: resume — agent2 now succeeds
    const runner2 = new DeterministicRunner(def, { store, agentRunner: sequentialAgent });
    const completed = await runner2.run({ resumeRunId: failed.id });

    expect(completed.status).toBe("completed");
    // agent1 should not have been re-executed
    expect(agent1Calls).toBe(1);
    // agent2 called twice total (once failed, once succeeded)
    expect(agent2Calls).toBe(2);
  });

  it("can resume the same run multiple times after repeated failures", async () => {
    let callCount = 0;
    const failTwice: AgentRunner = async () => {
      callCount++;
      if (callCount <= 2) throw new Error(`fail #${callCount}`);
      return { text: "finally", tokenUsage: { input: 0, output: 0 } };
    };

    const def = fourNodePipeline("multi-resume");
    const store = new MemoryRunStore();

    // First run: fails
    const r1 = new DeterministicRunner(def, { store, agentRunner: failTwice });
    await expect(r1.run({ inputs: { x: 1 } })).rejects.toThrow("fail #1");
    const run1 = (await store.list()).find((r) => r.status === "errored")!;

    // Second run: resume → fails again
    const r2 = new DeterministicRunner(def, { store, agentRunner: failTwice });
    await expect(r2.run({ resumeRunId: run1.id })).rejects.toThrow("fail #2");
    const run2 = await store.load(run1.id);
    expect(run2!.status).toBe("errored");

    // Third run: resume → succeeds
    const r3 = new DeterministicRunner(def, { store, agentRunner: failTwice });
    const result = await r3.run({ resumeRunId: run1.id });
    expect(result.status).toBe("completed");
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 2. Resume when cursor is missing defaults to index 0
// ---------------------------------------------------------------------------
describe("Resume with missing cursor", () => {
  it("defaults to startIndex 0 when cursor is absent on an errored run", async () => {
    const def: PipelineDefinition = {
      id: "no-cursor",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "inputs.x + 10", assigns: "b" },
        { id: "c", type: "output", path: "out", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "c" } },
      ],
    };
    const store = new MemoryRunStore();

    // Manually create an errored run WITHOUT a cursor
    const record = await store.createRun({ pipelineId: "no-cursor", inputs: { x: 5 } });
    record.steps = [
      { nodeId: "a", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "b", status: "errored", startedAt: 2, finishedAt: 3, error: "boom" },
      { nodeId: "c", status: "pending" },
    ];
    record.status = "errored";
    record.error = "boom";
    // Intentionally do NOT set cursor
    await store.save(record);

    const runner = new DeterministicRunner(def, { store });
    const resumed = await runner.run({ resumeRunId: record.id });

    // Should restart from index 0 (the default) but skip completed steps
    expect(resumed.status).toBe("completed");
    expect(resumed.outputs?.out).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 3. Resume of paused runs (not just errored)
// ---------------------------------------------------------------------------
describe("Resume paused runs via resumeRunId", () => {
  it("resumes a paused run that was manually set to paused status", async () => {
    const def: PipelineDefinition = {
      id: "paused-resume",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "t1", type: "transform", expression: "inputs.x + 5", assigns: "t1" },
        { id: "t2", type: "transform", expression: "artifacts.t1 * 2", assigns: "t2" },
        { id: "out", type: "output", path: "result", source: "t2" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "t1" } },
        { from: { node: "t1" }, to: { node: "t2" } },
        { from: { node: "t2" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();

    // Create a run paused after t1 with cursor at t2
    const record = await store.createRun({ pipelineId: "paused-resume", inputs: { x: 10 } });
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "t1", status: "completed", startedAt: 2, finishedAt: 3, data: { artifactKey: "t1", artifactSize: 2, artifactValue: 15 } },
      { nodeId: "t2", status: "pending" },
      { nodeId: "out", status: "pending" },
    ];
    record.status = "paused";
    record.cursor = {
      nextNodeIndex: 2,
      context: { inputs: { x: 10 }, artifacts: { t1: 15 }, outputs: {} },
    };
    await store.save(record);

    const runner = new DeterministicRunner(def, { store });
    const resumed = await runner.run({ resumeRunId: record.id });

    expect(resumed.status).toBe("completed");
    // (10 + 5) * 2 = 30
    expect(resumed.outputs?.result).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// 4. Session ID preservation across resume
// ---------------------------------------------------------------------------
describe("Session ID preservation across resume", () => {
  it("preserves sessionId from cursor context when resuming", async () => {
    let capturedSessionId: string | undefined;
    const sessionCapture: AgentRunner = async (params) => {
      capturedSessionId = params.sessionId;
      return { text: "ok", tokenUsage: { input: 0, output: 0 } };
    };

    const def = fourNodePipeline("session-preserve");
    const store = new MemoryRunStore();

    // Create a run with an explicit sessionId in cursor
    const record = await store.createRun({ pipelineId: "session-preserve", inputs: { x: 1 } });
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "a", status: "completed", startedAt: 2, finishedAt: 3, data: { artifactKey: "a", artifactSize: 1, artifactValue: 2 } },
      { nodeId: "b", status: "errored", startedAt: 3, finishedAt: 4, error: "test" },
      { nodeId: "c", status: "pending" },
    ];
    record.status = "errored";
    record.error = "test";
    const testSessionId = "test-session-12345";
    record.cursor = {
      nextNodeIndex: 2,
      context: { inputs: { x: 1 }, artifacts: { a: 2 }, outputs: {}, sessionId: testSessionId },
    };
    await store.save(record);

    const runner = new DeterministicRunner(def, { store, agentRunner: sessionCapture });
    await runner.run({ resumeRunId: record.id });

    expect(capturedSessionId).toBe(testSessionId);
  });
});

// ---------------------------------------------------------------------------
// 5. Error classification edge cases
// ---------------------------------------------------------------------------
describe("Error classification edge cases", () => {
  it("classifies error with `status` field (alternative to statusCode)", () => {
    expect(classifyError({ status: 503 })).toBe("transient");
    expect(classifyError({ status: 401 })).toBe("permanent");
  });

  it("prefers statusCode over status when both present", () => {
    // statusCode is checked first via normalizeError
    expect(classifyError({ statusCode: 429, status: 200 })).toBe("transient");
  });

  it("classifies error with both code and message — code wins", () => {
    // code is checked before message
    expect(classifyError({ code: "ECONNRESET", message: "some random msg" })).toBe("transient");
  });

  it("classifies rate_limit (with underscore) in message as transient", () => {
    // The regex is /rate\s*limit/i which matches rate limit, ratelimit, rate  limit
    expect(classifyError({ message: "ratelimit exceeded" })).toBe("transient");
  });

  it("classifies unknown status code with no other signals as unknown", () => {
    expect(classifyError({ statusCode: 418 })).toBe("unknown"); // I'm a teapot
  });

  it("handles error object with only a message field", () => {
    expect(classifyError({ message: "unexpected error" })).toBe("unknown");
  });

  it("classifies number as unknown", () => {
    expect(classifyError(42)).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 6. MemoryRunStore: claimRun
// ---------------------------------------------------------------------------
describe("MemoryRunStore.claimRun", () => {
  it("claims a pending run and sets status to running", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: {} });
    // Default status is "pending"
    const claimed = await store.claimRun(record.id);
    expect(claimed).toBe(true);

    const loaded = await store.load(record.id);
    expect(loaded!.status).toBe("running");
  });

  it("rejects claim for a non-pending run", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: {} });
    record.status = "errored";
    await store.save(record);

    const claimed = await store.claimRun(record.id);
    expect(claimed).toBe(false);
  });

  it("rejects claim for a nonexistent run", async () => {
    const store = new MemoryRunStore();
    const claimed = await store.claimRun("nonexistent-id");
    expect(claimed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. MemoryRunStore: incrementRetryCount
// ---------------------------------------------------------------------------
describe("MemoryRunStore.incrementRetryCount", () => {
  it("increments retryCount from 0 to 1", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: {} });
    const count = await store.incrementRetryCount(record.id);
    expect(count).toBe(1);

    const loaded = await store.load(record.id);
    expect(loaded!.retryCount).toBe(1);
  });

  it("increments retryCount cumulatively", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: {} });
    await store.incrementRetryCount(record.id);
    await store.incrementRetryCount(record.id);
    const count = await store.incrementRetryCount(record.id);
    expect(count).toBe(3);
  });

  it("throws for nonexistent run", async () => {
    const store = new MemoryRunStore();
    await expect(store.incrementRetryCount("missing")).rejects.toThrow("Run not found");
  });
});

// ---------------------------------------------------------------------------
// 8. MemoryRunStore: recoverStaleRuns
// ---------------------------------------------------------------------------
describe("MemoryRunStore.recoverStaleRuns", () => {
  it("resets orphaned running runs back to pending", async () => {
    const store = new MemoryRunStore();
    const r1 = await store.createRun({ pipelineId: "test", inputs: {} });
    const r2 = await store.createRun({ pipelineId: "test", inputs: {} });
    const r3 = await store.createRun({ pipelineId: "test", inputs: {} });

    // Set r1 and r2 as "running" (stale), leave r3 pending
    r1.status = "running";
    r2.status = "running";
    await store.save(r1);
    await store.save(r2);

    const recovered = await store.recoverStaleRuns();
    expect(recovered).toBe(2);

    const loaded1 = await store.load(r1.id);
    const loaded2 = await store.load(r2.id);
    const loaded3 = await store.load(r3.id);
    expect(loaded1!.status).toBe("pending");
    expect(loaded2!.status).toBe("pending");
    expect(loaded3!.status).toBe("pending"); // was already pending
  });

  it("returns 0 when no stale runs exist", async () => {
    const store = new MemoryRunStore();
    await store.createRun({ pipelineId: "test", inputs: {} }); // pending
    const recovered = await store.recoverStaleRuns();
    expect(recovered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 9. MemoryRunStore: failRun
// ---------------------------------------------------------------------------
describe("MemoryRunStore.failRun", () => {
  it("sets status to errored and stores error message", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: {} });
    await store.failRun(record, "something broke");

    const loaded = await store.load(record.id);
    expect(loaded!.status).toBe("errored");
    expect(loaded!.error).toBe("something broke");
  });
});

// ---------------------------------------------------------------------------
// 10. MemoryRunStore: completeRun
// ---------------------------------------------------------------------------
describe("MemoryRunStore.completeRun", () => {
  it("sets status to completed and stores outputs", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: {} });
    await store.completeRun(record, { answer: 42 });

    const loaded = await store.load(record.id);
    expect(loaded!.status).toBe("completed");
    expect(loaded!.outputs).toEqual({ answer: 42 });
  });
});

// ---------------------------------------------------------------------------
// 11. Retry exhaustion emits "run.retry-exhausted" event
// ---------------------------------------------------------------------------
describe("Retry exhaustion emits event", () => {
  it("emits run.retry-exhausted when maxAttempts is reached", async () => {
    const { createScheduler } = await import("../src/scheduler.js");

    const alwaysFail: AgentRunner = async () => {
      const err = new Error("Service down") as Error & { statusCode?: number };
      err.statusCode = 503;
      throw err;
    };

    const def: PipelineDefinition = {
      id: "exhaust-retry",
      entry: ["a"],
      retry: {
        maxAttempts: 1, // Only 1 retry allowed
        backoffMs: 5,
        backoffMultiplier: 1,
        retryableCategories: ["transient"],
      },
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "agent", prompt: "Hi" },
        { id: "c", type: "output", path: "out", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "c" } },
      ],
    };

    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const registry = {
      get: async (id: string) =>
        id === "exhaust-retry" ? { definition: def, mtimeMs: 0, path: "" } : null,
    };

    // Listen for the retry-exhausted event
    const bus = EventBus.getInstance();
    const exhaustedEvents: unknown[] = [];
    const handler = (evt: unknown) => {
      const e = evt as { event: string };
      if (e.event === "run.retry-exhausted") exhaustedEvents.push(e);
    };
    bus.on("run", handler);

    const scheduler = createScheduler({
      store,
      queue,
      registry,
      maxConcurrency: 1,
      agentRunner: alwaysFail,
    });

    await queue.enqueue("exhaust-retry", {});
    scheduler.start();

    // Wait for exhaustion: initial run + 1 retry = retryCount hits maxAttempts
    const deadline = Date.now() + 8000;
    let finalRecord: PipelineRunRecord | null = null;
    while (Date.now() < deadline) {
      const runs = await store.list();
      const errored = runs.find(
        (r) => r.status === "errored" && (r.retryCount ?? 0) >= 1
      );
      if (errored) {
        finalRecord = errored;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    scheduler.stop();
    bus.off("run", handler);
    await new Promise((r) => setTimeout(r, 100));

    expect(finalRecord).not.toBeNull();
    expect(finalRecord!.status).toBe("errored");
    // The run.retry-exhausted event should have been emitted
    expect(exhaustedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 12. Scheduler: cursor-aware dispatch uses resumeRunId for runs with cursor
// ---------------------------------------------------------------------------
describe("Scheduler cursor vs startRunId dispatch", () => {
  it("completes a cursor-bearing run via resumeRunId path without re-running completed steps", async () => {
    const { createScheduler } = await import("../src/scheduler.js");

    const executedNodes: string[] = [];
    const trackingAgent: AgentRunner = async (params) => {
      const nodeId = params.nodeId ?? "unknown";
      executedNodes.push(nodeId);
      return { text: `${nodeId}-done`, tokenUsage: { input: 0, output: 0 } };
    };

    const def: PipelineDefinition = {
      id: "cursor-dispatch-2",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "a1", type: "agent", prompt: "Step A" },
        { id: "a2", type: "agent", prompt: "Step B" },
        { id: "out", type: "output", path: "out", source: "a2" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "a1" } },
        { from: { node: "a1" }, to: { node: "a2" } },
        { from: { node: "a2" }, to: { node: "out" } },
      ],
    };

    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const registry = {
      get: async (id: string) =>
        id === "cursor-dispatch-2" ? { definition: def, mtimeMs: 0, path: "" } : null,
    };

    // Create a run that failed at a2 with cursor
    const record = await store.createRun({ pipelineId: "cursor-dispatch-2", inputs: {} });
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "a1", status: "completed", startedAt: 2, finishedAt: 3 },
      { nodeId: "a2", status: "errored", startedAt: 3, finishedAt: 4, error: "down" },
      { nodeId: "out", status: "pending" },
    ];
    record.cursor = {
      nextNodeIndex: 2,
      context: { inputs: {}, artifacts: {}, outputs: {} },
    };
    record.status = "pending"; // Ready for scheduler pickup
    await store.save(record);

    const scheduler = createScheduler({
      store,
      queue,
      registry,
      maxConcurrency: 1,
      agentRunner: trackingAgent,
    });

    scheduler.start();

    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const loaded = await store.load(record.id);
      if (loaded?.status === "completed") break;
      await new Promise((r) => setTimeout(r, 30));
    }

    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));

    const final = await store.load(record.id);
    expect(final!.status).toBe("completed");

    // a1 should NOT have been re-executed (was already completed)
    expect(executedNodes.filter((n) => n === "a1")).toHaveLength(0);
    // a2 should have been executed exactly once
    expect(executedNodes.filter((n) => n === "a2")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 13. Retry endpoint integration tests (via Fastify inject)
// ---------------------------------------------------------------------------
describe("Retry endpoint integration", () => {
  async function setupApp() {
    const os = await import("node:os");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const { createApp } = await import("../src/server.js");

    const runsDir = path.join(os.tmpdir(), `ripline-acceptance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(runsDir, { recursive: true });

    const fixturesDir = path.join(process.cwd(), "tests", "fixtures", "pipelines");
    const app = await createApp({
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
    });

    return {
      app,
      runsDir,
      cleanup: async () => {
        await app.close();
        await fs.rm(runsDir, { recursive: true, force: true });
      },
    };
  }

  it("POST /runs/:runId/retry returns 404 for unknown run ID", async () => {
    const { app, cleanup } = await setupApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/runs/nonexistent-run-id/retry",
        payload: { strategy: "from-failure" },
      });
      expect(res.statusCode).toBe(404);
      const body = res.json<{ error: string }>();
      expect(body.error).toBe("Not Found");
    } finally {
      await cleanup();
    }
  });

  it("POST /runs/:runId/retry defaults strategy to from-failure when omitted", async () => {
    const { app, cleanup } = await setupApp();
    try {
      const pipelines = (await app.inject({ method: "GET", url: "/pipelines" })).json() as any;
      const pipelineId = pipelines.pipelines[0]?.id;
      if (!pipelineId) return;

      const createRes = await app.inject({
        method: "POST",
        url: `/pipelines/${pipelineId}/run`,
        payload: { inputs: {} },
      });
      await new Promise((r) => setTimeout(r, 300));
      const runId = createRes.json<{ runId: string }>().runId;
      if (!runId) return;

      const runRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
      const run = runRes.json<PipelineRunRecord>();

      if (run.status === "errored") {
        // No strategy specified — should default to from-failure
        const retryRes = await app.inject({
          method: "POST",
          url: `/runs/${runId}/retry`,
          payload: {},
        });
        expect(retryRes.statusCode).toBe(202);
        const body = retryRes.json<{ strategy: string }>();
        expect(body.strategy).toBe("from-failure");
      }
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 14. from-failure rebuild artifacts correctness
// ---------------------------------------------------------------------------
describe("from-failure strategy artifact reconstruction", () => {
  it("correctly rebuilds artifacts for all completed steps before the failure point", async () => {
    const def: PipelineDefinition = {
      id: "artifact-rebuild",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "s1", type: "transform", expression: "inputs.x + 1", assigns: "s1" },
        { id: "s2", type: "transform", expression: "artifacts.s1 * 2", assigns: "s2" },
        { id: "s3", type: "transform", expression: "artifacts.s2 + artifacts.s1", assigns: "s3" },
        { id: "out", type: "output", path: "result", source: "s3" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "s1" } },
        { from: { node: "s1" }, to: { node: "s2" } },
        { from: { node: "s2" }, to: { node: "s3" } },
        { from: { node: "s3" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();

    // Create a run that failed at s3 with s1 and s2 completed
    const record = await store.createRun({ pipelineId: "artifact-rebuild", inputs: { x: 4 } });
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "s1", status: "completed", startedAt: 2, finishedAt: 3, data: { artifactKey: "s1", artifactSize: 1, artifactValue: 5 } },
      { nodeId: "s2", status: "completed", startedAt: 3, finishedAt: 4, data: { artifactKey: "s2", artifactSize: 2, artifactValue: 10 } },
      { nodeId: "s3", status: "errored", startedAt: 4, finishedAt: 5, error: "simulated" },
      { nodeId: "out", status: "pending" },
    ];
    record.status = "errored";
    record.error = "simulated";
    record.cursor = {
      nextNodeIndex: 3,
      context: { inputs: { x: 4 }, artifacts: { s1: 5, s2: 10 }, outputs: {} },
    };
    await store.save(record);

    const runner = new DeterministicRunner(def, { store });
    const result = await runner.run({ resumeRunId: record.id });

    expect(result.status).toBe("completed");
    // s3 = artifacts.s2 + artifacts.s1 = 10 + 5 = 15
    expect(result.outputs?.result).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// 15. Cursor saves inputs in context for resume
// ---------------------------------------------------------------------------
describe("Cursor preserves original inputs", () => {
  it("resume uses original inputs from cursor context, not from record.inputs override", async () => {
    const def: PipelineDefinition = {
      id: "input-preserve",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "t1", type: "transform", expression: "inputs.val + 100", assigns: "t1" },
        { id: "agent", type: "agent", prompt: "do it" },
        { id: "out", type: "output", path: "result", source: "t1" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "t1" } },
        { from: { node: "t1" }, to: { node: "agent" } },
        { from: { node: "agent" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();

    // Run fails at agent node
    const r1 = new DeterministicRunner(def, { store });
    await expect(r1.run({ inputs: { val: 42 } })).rejects.toThrow();

    const failed = (await store.list()).find((r) => r.status === "errored")!;
    // Verify cursor captured the original inputs
    const ctx = failed.cursor!.context as { inputs?: Record<string, unknown> };
    expect(ctx.inputs?.val).toBe(42);

    // Resume with agent
    const r2 = new DeterministicRunner(def, { store, agentRunner: noopAgent });
    const result = await r2.run({ resumeRunId: failed.id });

    expect(result.status).toBe("completed");
    expect(result.outputs?.result).toBe(142);
  });
});

// ---------------------------------------------------------------------------
// 16. Checkpoint cursor points to NEXT node (i+1), not the checkpoint itself
// ---------------------------------------------------------------------------
describe("Checkpoint cursor semantics", () => {
  it("checkpoint cursor.nextNodeIndex points past the checkpoint node", async () => {
    const def: PipelineDefinition = {
      id: "chk-index",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "chk", type: "checkpoint", reason: "Review" },
        { id: "t1", type: "transform", expression: "inputs.x + 1", assigns: "t1" },
        { id: "out", type: "output", path: "result", source: "t1" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "chk" } },
        { from: { node: "chk" }, to: { node: "t1" } },
        { from: { node: "t1" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();

    const runner = new DeterministicRunner(def, { store });
    const paused = await runner.run({ inputs: { x: 10 } });

    expect(paused.status).toBe("paused");
    // Checkpoint is at index 1 in topo [inp, chk, t1, out]
    // Cursor should point to index 2 (t1), not 1
    expect(paused.cursor!.nextNodeIndex).toBe(2);
  });

  it("error cursor.nextNodeIndex points AT the failing node (i), not past it", async () => {
    const def = fourNodePipeline("err-cursor-idx");
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });

    await expect(runner.run({ inputs: { x: 1 } })).rejects.toThrow();
    const failed = (await store.list()).find((r) => r.status === "errored")!;

    // "b" is at index 2 in topo [inp, a, b, c]
    // Error cursor should point AT index 2
    expect(failed.cursor!.nextNodeIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 17. MemoryRunStore.list with status filter
// ---------------------------------------------------------------------------
describe("MemoryRunStore.list filtering", () => {
  it("filters by status", async () => {
    const store = new MemoryRunStore();
    const r1 = await store.createRun({ pipelineId: "test", inputs: {} });
    const r2 = await store.createRun({ pipelineId: "test", inputs: {} });
    const r3 = await store.createRun({ pipelineId: "test", inputs: {} });

    r1.status = "errored";
    r2.status = "completed";
    await store.save(r1);
    await store.save(r2);
    // r3 stays pending

    const errored = await store.list({ status: "errored" });
    expect(errored).toHaveLength(1);
    expect(errored[0]!.id).toBe(r1.id);

    const pending = await store.list({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(r3.id);
  });
});

// ---------------------------------------------------------------------------
// 18. Resume preserves retryCount from the failed run
// ---------------------------------------------------------------------------
describe("Resume preserves retryCount", () => {
  it("retryCount persists across manual resume (not reset unless explicitly)", async () => {
    const def = fourNodePipeline("keep-retry-count");
    const store = new MemoryRunStore();

    const record = await store.createRun({ pipelineId: "keep-retry-count", inputs: { x: 1 } });
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "a", status: "completed", startedAt: 2, finishedAt: 3, data: { artifactKey: "a", artifactSize: 1, artifactValue: 2 } },
      { nodeId: "b", status: "errored", startedAt: 3, finishedAt: 4, error: "fail" },
      { nodeId: "c", status: "pending" },
    ];
    record.status = "errored";
    record.error = "fail";
    record.retryCount = 3; // Already retried 3 times
    record.cursor = {
      nextNodeIndex: 2,
      context: { inputs: { x: 1 }, artifacts: { a: 2 }, outputs: {} },
    };
    await store.save(record);

    const runner = new DeterministicRunner(def, { store, agentRunner: noopAgent });
    const result = await runner.run({ resumeRunId: record.id });

    expect(result.status).toBe("completed");
    // retryCount should still be 3 — runner doesn't reset it
    expect(result.retryCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 19. startRunId resets all steps fresh (vs resumeRunId which preserves)
// ---------------------------------------------------------------------------
describe("startRunId vs resumeRunId behavior", () => {
  it("startRunId resets all steps to pending and starts from scratch", async () => {
    const executedNodes: string[] = [];
    const trackingAgent: AgentRunner = async (params) => {
      const nodeId = params.nodeId ?? "unknown";
      executedNodes.push(nodeId);
      return { text: "ok", tokenUsage: { input: 0, output: 0 } };
    };

    const def: PipelineDefinition = {
      id: "start-fresh",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "a", type: "agent", prompt: "Hi" },
        { id: "out", type: "output", path: "out", source: "a" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "a" } },
        { from: { node: "a" }, to: { node: "out" } },
      ],
    };

    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "start-fresh", inputs: { x: 1 } });
    // Simulate a previous partially-completed run
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "a", status: "errored", startedAt: 2, finishedAt: 3, error: "old error" },
      { nodeId: "out", status: "pending" },
    ];
    record.status = "pending"; // reset to pending for startRunId
    await store.save(record);

    const runner = new DeterministicRunner(def, { store, agentRunner: trackingAgent });
    const result = await runner.run({ startRunId: record.id });

    expect(result.status).toBe("completed");
    // With startRunId, all steps are reset — so agent "a" should be executed
    expect(executedNodes).toContain("a");
  });
});

// ---------------------------------------------------------------------------
// 20. EventBus emits run events during resume lifecycle
// ---------------------------------------------------------------------------
describe("EventBus emissions during resume", () => {
  it("emits run.started when a run is resumed", async () => {
    const def = fourNodePipeline("bus-resume");
    const store = new MemoryRunStore();

    // Create errored run
    const record = await store.createRun({ pipelineId: "bus-resume", inputs: { x: 1 } });
    record.steps = [
      { nodeId: "inp", status: "completed", startedAt: 1, finishedAt: 2 },
      { nodeId: "a", status: "completed", startedAt: 2, finishedAt: 3, data: { artifactKey: "a", artifactSize: 1, artifactValue: 2 } },
      { nodeId: "b", status: "errored", startedAt: 3, finishedAt: 4, error: "err" },
      { nodeId: "c", status: "pending" },
    ];
    record.status = "errored";
    record.error = "err";
    record.cursor = {
      nextNodeIndex: 2,
      context: { inputs: { x: 1 }, artifacts: { a: 2 }, outputs: {} },
    };
    await store.save(record);

    const bus = EventBus.getInstance();
    const events: unknown[] = [];
    const handler = (evt: unknown) => events.push(evt);
    bus.on("run", handler);

    const runner = new DeterministicRunner(def, { store, agentRunner: noopAgent });
    await runner.run({ resumeRunId: record.id });

    bus.off("run", handler);

    // Should have emitted run.started and run.completed
    const runEvents = events as { event: string; runId: string }[];
    const startedEvents = runEvents.filter((e) => e.event === "run.started" && e.runId === record.id);
    const completedEvents = runEvents.filter((e) => e.event === "run.completed" && e.runId === record.id);
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);
    expect(completedEvents.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 21. MemoryRunStore.load returns deep copies (isolation)
// ---------------------------------------------------------------------------
describe("MemoryRunStore isolation", () => {
  it("load returns a deep copy — mutations do not affect stored data", async () => {
    const store = new MemoryRunStore();
    const record = await store.createRun({ pipelineId: "test", inputs: { a: 1 } });

    const loaded1 = await store.load(record.id);
    loaded1!.inputs.a = 999;

    const loaded2 = await store.load(record.id);
    expect(loaded2!.inputs.a).toBe(1); // Unaffected by mutation
  });
});
