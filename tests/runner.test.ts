import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { loadPipelineDefinition } from "../src/lib/pipeline/loader.js";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import type { PipelineDefinition } from "../src/types.js";
import type { AgentRunner } from "../src/pipeline/executors/index.js";

const mockAgentRunner: AgentRunner = async () => ({
  text: "Mock agent response",
  tokenUsage: { input: 0, output: 0 },
});

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");
const riplinePath = path.join(fixturesDir, "ripline-area-owner.yaml");

describe("DeterministicRunner", () => {
  describe("topological order", () => {
    it("returns correct execution order for ripline-area-owner", () => {
      const def = loadPipelineDefinition(riplinePath);
      const runner = new DeterministicRunner(def);
      const order = runner.getExecutionOrder();
      expect(order).toEqual([
        "area-owner-intake",
        "break-down",
        "design-spec",
        "engineering-plan",
        "implementation-queue",
      ]);
    });
  });

  describe("cycle and missing edge detection", () => {
    it("throws before any node executes when graph has a cycle", () => {
      const def: PipelineDefinition = {
        id: "cycle-pipeline",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          { id: "b", type: "transform", expression: "x" },
          { id: "c", type: "output" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
          { from: { node: "c" }, to: { node: "b" } },
        ],
      };
      const runner = new DeterministicRunner(def);
      expect(() => runner.getExecutionOrder()).toThrow(/cycle|unreachable/i);
    });

    it("throws when edge references missing node", () => {
      const def: PipelineDefinition = {
        id: "missing-node",
        entry: ["a"],
        nodes: [{ id: "a", type: "input" }],
        edges: [{ from: { node: "a" }, to: { node: "nonexistent" } }],
      };
      const runner = new DeterministicRunner(def);
      expect(() => runner.getExecutionOrder()).toThrow(/nonexistent|missing/i);
    });
  });

  describe("run", () => {
    it("emits ordered node execution and writes run record to .ripline/runs/<runId>/run.json", async () => {
      const def = loadPipelineDefinition(riplinePath);
      const runsDir = path.join(process.cwd(), ".ripline", "runs");
      const runner = new DeterministicRunner(def, { runsDir, agentRunner: mockAgentRunner });

      const runRecord = await runner.run({ inputs: {} });

      expect(runRecord.id).toBeDefined();
      expect(runRecord.pipelineId).toBe("ripline-area-owner");
      expect(runRecord.status).toBe("completed");
      expect(runRecord.steps).toHaveLength(5);
      expect(runRecord.steps.map((s) => s.nodeId)).toEqual([
        "area-owner-intake",
        "break-down",
        "design-spec",
        "engineering-plan",
        "implementation-queue",
      ]);
      for (const step of runRecord.steps) {
        expect(step.status).toBe("completed");
        expect(step.startedAt).toBeDefined();
        expect(step.finishedAt).toBeDefined();
      }

      const runFilePath = path.join(runsDir, runRecord.id, "run.json");
      const raw = await fs.readFile(runFilePath, "utf-8");
      const saved = JSON.parse(raw);
      expect(saved.id).toBe(runRecord.id);
      expect(saved.steps).toHaveLength(5);
    });

    it("emits node.started and node.completed with timestamps", async () => {
      const def = loadPipelineDefinition(riplinePath);
      const runsDir = path.join(process.cwd(), ".ripline", "runs");
      const runner = new DeterministicRunner(def, { runsDir, agentRunner: mockAgentRunner });
      const events: { type: string; nodeId: string; at?: number }[] = [];
      runner.on("node.started", (e) => events.push({ type: "node.started", nodeId: e.nodeId, at: e.at }));
      runner.on("node.completed", (e) => events.push({ type: "node.completed", nodeId: e.nodeId, at: e.at }));

      await runner.run({ inputs: {} });

      const started = events.filter((e) => e.type === "node.started");
      const completed = events.filter((e) => e.type === "node.completed");
      expect(started).toHaveLength(5);
      expect(completed).toHaveLength(5);
      expect(started.map((e) => e.nodeId)).toEqual([
        "area-owner-intake",
        "break-down",
        "design-spec",
        "engineering-plan",
        "implementation-queue",
      ]);
      started.forEach((e) => expect(typeof e.at).toBe("number"));
      completed.forEach((e) => expect(typeof e.at).toBe("number"));
    });

    it("throws on agent node when agentRunner is not provided", async () => {
      const def = loadPipelineDefinition(riplinePath);
      const runsDir = path.join(process.cwd(), ".ripline", "runs");
      const runner = new DeterministicRunner(def, { runsDir });

      await expect(runner.run({ inputs: {} })).rejects.toThrow(/agentRunner|sessions_spawn/);
    });

    it("writes outputs to --out path and record.outputs when outPath is set", async () => {
      const def = loadPipelineDefinition(riplinePath);
      const runsDir = path.join(process.cwd(), ".ripline", "runs");
      const outFile = path.join(runsDir, "backlog.json");
      const runner = new DeterministicRunner(def, {
        runsDir,
        agentRunner: mockAgentRunner,
        outPath: outFile,
      });

      const runRecord = await runner.run({ inputs: {} });

      expect(runRecord.outputs).toBeDefined();
      expect(runRecord.outputs!["ripline/backlog"]).toBeDefined();
      const raw = await fs.readFile(outFile, "utf-8");
      const written = JSON.parse(raw);
      expect(written["ripline/backlog"]).toBeDefined();
      expect(written["ripline/backlog"]).toHaveProperty("text");
    });

    it("resume after mid-run error continues from failing node without redoing prior nodes", async () => {
      const def: PipelineDefinition = {
        id: "resume-test",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          { id: "b", type: "agent", prompt: "Say hi" },
          { id: "c", type: "output", path: "out", source: "b" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
        ],
      };
      const runsDir = path.join(process.cwd(), ".ripline", "runs", "resume-test-" + Date.now());
      const { PipelineRunStore } = await import("../src/run-store.js");
      const store = new PipelineRunStore(runsDir);
      await store.init();
      const runnerNoAgent = new DeterministicRunner(def, { store });
      const runnerWithAgent = new DeterministicRunner(def, { store, agentRunner: mockAgentRunner });

      await expect(runnerNoAgent.run({ inputs: { x: 1 } })).rejects.toThrow(/agentRunner|sessions_spawn/);

      const allRuns = await (store as PipelineRunStore).list();
      const failedRun = allRuns.find((r) => r.status === "errored");
      expect(failedRun).toBeDefined();
      expect(failedRun!.steps[0].status).toBe("completed");
      expect(failedRun!.steps[1].status).toBe("errored");

      const resumed = await runnerWithAgent.run({ resumeRunId: failedRun!.id });
      expect(resumed.status).toBe("completed");
      expect(resumed.steps).toHaveLength(3);
      expect(resumed.steps[0].status).toBe("completed");
      expect(resumed.steps[1].status).toBe("completed");
      expect(resumed.steps[2].status).toBe("completed");

      await fs.rm(runsDir, { recursive: true, force: true });
    });

    it("startRunId executes an existing pending run from start", async () => {
      const def: PipelineDefinition = {
        id: "start-run-id-test",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          { id: "b", type: "transform", expression: "inputs.x + 1" },
          { id: "c", type: "output", path: "out", source: "b" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
        ],
      };
      const { MemoryRunStore } = await import("../src/run-store-memory.js");
      const store = new MemoryRunStore();
      const record = await store.createRun({ pipelineId: def.id, inputs: { x: 10 } });
      expect(record.status).toBe("pending");
      const runner = new DeterministicRunner(def, { store });
      const result = await runner.run({ startRunId: record.id });
      expect(result.id).toBe(record.id);
      expect(result.status).toBe("completed");
      expect(result.steps).toHaveLength(3);
      expect(result.outputs?.out).toBe(11);
    });

    it("retries agent node on transient failure when retry.maxAttempts > 1", async () => {
      const def: PipelineDefinition = {
        id: "retry-test",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          {
            id: "b",
            type: "agent",
            prompt: "Hi",
            retry: { maxAttempts: 3, delayMs: 5 },
          },
          { id: "c", type: "output", path: "out", source: "b" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
        ],
      };
      let attempts = 0;
      const flakyAgent: AgentRunner = async () => {
        attempts++;
        if (attempts < 2) throw new Error("Transient failure");
        return { text: "OK", tokenUsage: { input: 0, output: 0 } };
      };
      const { MemoryRunStore } = await import("../src/run-store-memory.js");
      const store = new MemoryRunStore();
      const runner = new DeterministicRunner(def, { store, agentRunner: flakyAgent });
      const record = await runner.run({ inputs: {} });
      expect(record.status).toBe("completed");
      expect(attempts).toBe(2);
    });

    it("pauses at checkpoint node and sets waitFor with resumeKey", async () => {
      const def: PipelineDefinition = {
        id: "checkpoint-test",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          { id: "b", type: "checkpoint", reason: "Human approval", resumeKey: "approve-1" },
          { id: "c", type: "output", path: "out", source: "a" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
        ],
      };
      const { MemoryRunStore } = await import("../src/run-store-memory.js");
      const store = new MemoryRunStore();
      const runner = new DeterministicRunner(def, { store });

      const record = await runner.run({ inputs: { x: 1 } });

      expect(record.status).toBe("paused");
      expect(record.waitFor).toEqual({ nodeId: "b", reason: "Human approval", resumeKey: "approve-1" });
      expect(record.cursor?.nextNodeIndex).toBe(2);
      expect(record.steps[0].status).toBe("completed");
      expect(record.steps[1].status).toBe("paused");
    });

    it("completes when transform node output conforms to contracts.output", async () => {
      const outputSchema = {
        type: "object" as const,
        required: ["count"],
        properties: { count: { type: "number" } },
      };
      const def: PipelineDefinition = {
        id: "contract-valid",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          {
            id: "b",
            type: "transform",
            expression: "{ count: inputs.n + 1 }",
            assigns: "b",
            contracts: { output: outputSchema },
          },
          { id: "c", type: "output", path: "out", source: "b" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
        ],
      };
      const { MemoryRunStore } = await import("../src/run-store-memory.js");
      const store = new MemoryRunStore();
      const runner = new DeterministicRunner(def, { store });

      const record = await runner.run({ inputs: { n: 10 } });

      expect(record.status).toBe("completed");
      expect(record.outputs?.out).toEqual({ count: 11 });
    });

    it("fails run when transform node output does not conform to contracts.output", async () => {
      const outputSchema = {
        type: "object" as const,
        required: ["count"],
        properties: { count: { type: "number" } },
      };
      const def: PipelineDefinition = {
        id: "contract-invalid",
        entry: ["a"],
        nodes: [
          { id: "a", type: "input" },
          {
            id: "b",
            type: "transform",
            expression: "{ count: \"not-a-number\" }",
            assigns: "b",
            contracts: { output: outputSchema },
          },
          { id: "c", type: "output", path: "out", source: "b" },
        ],
        edges: [
          { from: { node: "a" }, to: { node: "b" } },
          { from: { node: "b" }, to: { node: "c" } },
        ],
      };
      const { MemoryRunStore } = await import("../src/run-store-memory.js");
      const store = new MemoryRunStore();
      const runner = new DeterministicRunner(def, { store });

      await expect(runner.run({ inputs: {} })).rejects.toThrow(/Output contract validation failed for node "b"/);
      const runs = await store.list({});
      const failedRun = runs.find((r) => r.pipelineId === "contract-invalid" && r.status === "errored");
      expect(failedRun?.status).toBe("errored");
      expect(failedRun?.error).toMatch(/contract|schema|valid|count/i);
    });

    it("enqueue node creates child runs and pauses parent until children complete", async () => {
      const parentDef: PipelineDefinition = {
        id: "parent-with-enqueue",
        entry: ["tasks"],
        nodes: [
          {
            id: "tasks",
            type: "transform",
            expression: "[{ id: 't1', title: 'Story 1' }, { id: 't2', title: 'Story 2' }, { id: 't3', title: 'Story 3' }]",
            assigns: "tasks",
          },
          {
            id: "enq",
            type: "enqueue",
            pipelineId: "child-pipeline",
            tasksSource: "tasks",
            mode: "per-item",
          },
          { id: "after", type: "output", path: "done", source: "enq" },
        ],
        edges: [
          { from: { node: "tasks" }, to: { node: "enq" } },
          { from: { node: "enq" }, to: { node: "after" } },
        ],
      };
      const { MemoryRunStore } = await import("../src/run-store-memory.js");
      const { createRunQueue } = await import("../src/run-queue.js");
      const store = new MemoryRunStore();
      const queue = createRunQueue(store);
      const runner = new DeterministicRunner(parentDef, { store, queue });

      const record = await runner.run({ inputs: {} });

      expect(record.status).toBe("paused");
      expect(record.waitFor?.nodeId).toBe("enq");
      expect(record.waitFor?.reason).toBe("children");
      expect(record.childRunIds).toHaveLength(3);

      const pending = await store.list({ status: "pending" });
      expect(pending).toHaveLength(3);
      pending.forEach((r) => {
        expect(r.parentRunId).toBe(record.id);
        expect(r.queueMode).toBe("per-item");
      });
    });
  });
});
