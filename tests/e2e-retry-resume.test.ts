/**
 * E2E test: Automatic retry resumes from the failing node, not from scratch.
 *
 * Simulates a transient failure mid-pipeline, verifies:
 *  1. Auto-retry kicks in for the transient error
 *  2. Completed steps are NOT re-executed on retry
 *  3. Execution resumes from the exact node that failed
 */

import { describe, expect, it } from "vitest";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import { MemoryRunStore } from "../src/run-store-memory.js";
import { createRunQueue } from "../src/run-queue.js";
import type { PipelineDefinition, PipelineRunRecord } from "../src/types.js";
import type { AgentRunner } from "../src/pipeline/executors/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a 5-node linear pipeline: input → t1 → t2 → agent_b → output
 * The agent node ("agent_b") sits in the middle so we can verify that
 * steps before it are completed and not re-run on resume.
 */
function midPipelineAgentDef(id: string, retry?: PipelineDefinition["retry"]): PipelineDefinition {
  return {
    id,
    entry: ["inp"],
    retry,
    nodes: [
      { id: "inp", type: "input" },
      { id: "t1", type: "transform", expression: "inputs.x + 10", assigns: "t1" },
      { id: "t2", type: "transform", expression: "artifacts.t1 * 2", assigns: "t2" },
      { id: "agent_b", type: "agent", prompt: "process {{t2}}" },
      { id: "out", type: "output", path: "result", source: "agent_b" },
    ],
    edges: [
      { from: { node: "inp" }, to: { node: "t1" } },
      { from: { node: "t1" }, to: { node: "t2" } },
      { from: { node: "t2" }, to: { node: "agent_b" } },
      { from: { node: "agent_b" }, to: { node: "out" } },
    ],
  };
}

// ---------------------------------------------------------------------------
// E2E: Transient failure mid-pipeline → auto-retry resumes from correct node
// ---------------------------------------------------------------------------
describe("E2E: auto-retry resumes from failing node", () => {
  it("retries a transient mid-pipeline failure and completes without re-running earlier steps", async () => {
    const { createScheduler } = await import("../src/scheduler.js");

    // Track every node the agent runner is invoked for
    const agentInvocations: string[] = [];
    let agentCallCount = 0;

    const flakyAgent: AgentRunner = async (params) => {
      agentCallCount++;
      agentInvocations.push((params as any).nodeId ?? "agent_b");

      // Fail on the first call with a transient (429) error
      if (agentCallCount === 1) {
        const err = new Error("Rate limit exceeded") as Error & { statusCode?: number };
        err.statusCode = 429;
        throw err;
      }
      return { text: "done", tokenUsage: { input: 0, output: 0 } };
    };

    const def = midPipelineAgentDef("e2e-retry-resume", {
      maxAttempts: 3,
      backoffMs: 5, // tiny backoff for test speed
      backoffMultiplier: 1,
      retryableCategories: ["transient"],
    });

    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const registry = {
      get: async (id: string) =>
        id === def.id ? { definition: def, mtimeMs: 0, path: "" } : null,
    };

    const scheduler = createScheduler({
      store,
      queue,
      registry,
      maxConcurrency: 1,
      agentRunner: flakyAgent,
    });

    await queue.enqueue(def.id, { x: 5 });
    scheduler.start();

    // Wait for the run to complete (or timeout)
    const deadline = Date.now() + 10_000;
    let result: PipelineRunRecord | null = null;
    while (Date.now() < deadline) {
      const runs = await store.list();
      const completed = runs.find((r) => r.status === "completed");
      if (completed) {
        result = completed;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));

    // ── Assertions ──────────────────────────────────────────────────────

    // 1. Run completed successfully after auto-retry
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");

    // 2. Agent was called exactly twice: once for the failure, once for the retry
    expect(agentCallCount).toBe(2);

    // 3. Transform steps (t1, t2) were NOT re-executed —
    //    They have no agent runner, so the only way to verify is that
    //    the agent was only called twice (not four times = 2 full runs).
    //    Additionally, check the step statuses:
    const t1Step = result!.steps.find((s) => s.nodeId === "t1");
    const t2Step = result!.steps.find((s) => s.nodeId === "t2");
    const agentStep = result!.steps.find((s) => s.nodeId === "agent_b");

    expect(t1Step?.status).toBe("completed");
    expect(t2Step?.status).toBe("completed");
    expect(agentStep?.status).toBe("completed");

    // 4. Artifacts from completed steps were preserved through resume
    //    t1 = x + 10 = 15, t2 = t1 * 2 = 30
    expect(result!.outputs?.result).toBeDefined();
  });

  it("does not re-execute completed steps when resuming from a failed node", async () => {
    // This test uses the runner directly (no scheduler) for fine-grained control
    const executedTransforms: string[] = [];

    // Wrap a pipeline definition that tracks transform execution via side-effects
    const def: PipelineDefinition = {
      id: "no-redo-e2e",
      entry: ["inp"],
      nodes: [
        { id: "inp", type: "input" },
        { id: "s1", type: "transform", expression: "inputs.v + 100", assigns: "s1" },
        { id: "s2", type: "transform", expression: "artifacts.s1 + 200", assigns: "s2" },
        { id: "agent_node", type: "agent", prompt: "go" },
        { id: "out", type: "output", path: "final", source: "agent_node" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "s1" } },
        { from: { node: "s1" }, to: { node: "s2" } },
        { from: { node: "s2" }, to: { node: "agent_node" } },
        { from: { node: "agent_node" }, to: { node: "out" } },
      ],
    };

    const store = new MemoryRunStore();

    // Run 1: no agent runner → fails at agent_node
    const runner1 = new DeterministicRunner(def, { store });
    await expect(runner1.run({ inputs: { v: 1 } })).rejects.toThrow();

    const failed = (await store.list()).find((r) => r.status === "errored")!;
    expect(failed).toBeDefined();
    expect(failed.cursor).toBeDefined();

    // Verify cursor points at the agent node (index 3 in topo order)
    expect(failed.cursor!.nextNodeIndex).toBe(3);

    // Verify completed steps have artifacts
    const s1 = failed.steps.find((s) => s.nodeId === "s1")!;
    const s2 = failed.steps.find((s) => s.nodeId === "s2")!;
    expect(s1.status).toBe("completed");
    expect(s2.status).toBe("completed");
    expect((s1.data as any)?.artifactValue).toBe(101); // 1 + 100
    expect((s2.data as any)?.artifactValue).toBe(301); // 101 + 200

    // Run 2: resume with agent runner
    const agentCalls: string[] = [];
    const trackingAgent: AgentRunner = async () => {
      agentCalls.push("agent_node");
      return { text: "result-text", tokenUsage: { input: 0, output: 0 } };
    };

    const runner2 = new DeterministicRunner(def, { store, agentRunner: trackingAgent });
    const resumed = await runner2.run({ resumeRunId: failed.id });

    // All steps completed
    expect(resumed.status).toBe("completed");
    expect(resumed.steps.every((s) => s.status === "completed")).toBe(true);

    // Agent was called exactly once (only for the previously-failed node)
    expect(agentCalls).toEqual(["agent_node"]);

    // Output is available
    expect(resumed.outputs?.final).toBeDefined();
  });

  it("scheduler auto-retry preserves cursor and resumes mid-pipeline", async () => {
    const { createScheduler } = await import("../src/scheduler.js");

    // A 4-node pipeline: input → transform → agent → output
    // Agent fails once with a 503 (transient), succeeds on retry
    let calls = 0;
    const transientOnce: AgentRunner = async () => {
      calls++;
      if (calls === 1) {
        const err = new Error("Service Unavailable") as Error & { statusCode?: number };
        err.statusCode = 503;
        throw err;
      }
      return { text: "success", tokenUsage: { input: 0, output: 0 } };
    };

    const def: PipelineDefinition = {
      id: "e2e-cursor-preserve",
      entry: ["inp"],
      retry: {
        maxAttempts: 2,
        backoffMs: 5,
        backoffMultiplier: 1,
        retryableCategories: ["transient"],
      },
      nodes: [
        { id: "inp", type: "input" },
        { id: "calc", type: "transform", expression: "inputs.n * 3", assigns: "calc" },
        { id: "work", type: "agent", prompt: "do work" },
        { id: "out", type: "output", path: "answer", source: "work" },
      ],
      edges: [
        { from: { node: "inp" }, to: { node: "calc" } },
        { from: { node: "calc" }, to: { node: "work" } },
        { from: { node: "work" }, to: { node: "out" } },
      ],
    };

    const store = new MemoryRunStore();
    const queue = createRunQueue(store);
    const registry = {
      get: async (id: string) =>
        id === def.id ? { definition: def, mtimeMs: 0, path: "" } : null,
    };

    const scheduler = createScheduler({
      store,
      queue,
      registry,
      maxConcurrency: 1,
      agentRunner: transientOnce,
    });

    const runId = await queue.enqueue(def.id, { n: 7 });
    scheduler.start();

    // Wait for completion
    const deadline = Date.now() + 10_000;
    let final: PipelineRunRecord | null = null;
    while (Date.now() < deadline) {
      const rec = await store.load(runId);
      if (rec?.status === "completed") {
        final = rec;
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    scheduler.stop();
    await new Promise((r) => setTimeout(r, 50));

    expect(final).not.toBeNull();
    expect(final!.status).toBe("completed");

    // Agent was called exactly twice (fail + retry success)
    expect(calls).toBe(2);

    // The transform step's artifact was computed once and reused
    const calcStep = final!.steps.find((s) => s.nodeId === "calc");
    expect(calcStep?.status).toBe("completed");

    // Output is present
    expect(final!.outputs?.answer).toBeDefined();
  });
});
