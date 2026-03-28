/**
 * Tests for: support-branching-decision-logic
 *
 * Covers all acceptance criteria for branching & decision logic features:
 *
 *  1. Switch node — case matching, default port, no-match error
 *  2. Switch port-based edge routing — only the active port's edge fires
 *  3. Conditional edges (when) — truthy/falsy evaluation, expression errors
 *  4. Default edges — fire when all sibling when-conditions are false
 *  5. on_error edge routing — error activates fallback node, stores __error
 *  6. Loop with exit condition — iteration, early exit, maxIterations cap
 *  7. Schema validation — switch port must match case key, single default/on_error per source
 *  8. Branch convergence — multiple branches merge into a single downstream node
 *  9. Integration — switch + when + on_error + loop in a single pipeline
 */

import { describe, expect, it } from "vitest";
import { DeterministicRunner } from "../src/pipeline/runner.js";
import { MemoryRunStore } from "../src/run-store-memory.js";
import { executeSwitch } from "../src/pipeline/executors/switch.js";
import { executeLoop } from "../src/pipeline/executors/loop.js";
import { pipelineDefinitionSchema } from "../src/schema.js";
import type { PipelineDefinition, SwitchNode, LoopNode } from "../src/types.js";
import type { ExecutorContext } from "../src/pipeline/executors/types.js";
import type { AgentRunner } from "../src/pipeline/executors/index.js";

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

const mockAgentRunner: AgentRunner = async () => ({
  text: "Mock agent response",
  tokenUsage: { input: 0, output: 0 },
});

function makeContext(overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    inputs: {},
    artifacts: {},
    env: {},
    outputs: {},
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/*  1. Switch node executor                                                   */
/* -------------------------------------------------------------------------- */

describe("Switch node executor (executeSwitch)", () => {
  it("matches expression result to case key and sets __activePort", async () => {
    const node: SwitchNode = {
      id: "router",
      type: "switch",
      expression: "inputs.category",
      cases: { billing: {}, support: {}, unknown: {} },
    };
    const ctx = makeContext({ inputs: { category: "billing" } });
    const result = await executeSwitch(node, ctx);

    expect(result.artifactKey).toBe("router");
    expect(result.value).toEqual({ __activePort: "billing" });
    expect(ctx.artifacts["router"]).toEqual({ __activePort: "billing" });
  });

  it("selects a different case when expression evaluates to another key", async () => {
    const node: SwitchNode = {
      id: "router",
      type: "switch",
      expression: "inputs.category",
      cases: { billing: {}, support: {}, unknown: {} },
    };
    const ctx = makeContext({ inputs: { category: "support" } });
    const result = await executeSwitch(node, ctx);

    expect(result.value).toEqual({ __activePort: "support" });
  });

  it("falls back to default port when expression does not match any case", async () => {
    const node: SwitchNode = {
      id: "router",
      type: "switch",
      expression: "inputs.category",
      cases: { billing: {}, support: {} },
      default: "support",
    };
    const ctx = makeContext({ inputs: { category: "shipping" } });
    const result = await executeSwitch(node, ctx);

    expect(result.value).toEqual({ __activePort: "support" });
  });

  it("throws descriptive error when no case matches and no default defined", async () => {
    const node: SwitchNode = {
      id: "router",
      type: "switch",
      expression: "inputs.category",
      cases: { billing: {}, support: {} },
    };
    const ctx = makeContext({ inputs: { category: "shipping" } });

    await expect(executeSwitch(node, ctx)).rejects.toThrow(
      /does not match any case.*billing.*support.*no default/i
    );
  });

  it("coerces non-string expression result to string for matching", async () => {
    const node: SwitchNode = {
      id: "s",
      type: "switch",
      expression: "inputs.code",
      cases: { "42": {}, "0": {} },
    };
    const ctx = makeContext({ inputs: { code: 42 } });
    const result = await executeSwitch(node, ctx);

    expect(result.value).toEqual({ __activePort: "42" });
  });

  it("can reference artifacts in expression", async () => {
    const node: SwitchNode = {
      id: "s",
      type: "switch",
      expression: "artifacts.classify.label",
      cases: { positive: {}, negative: {} },
    };
    const ctx = makeContext({
      artifacts: { classify: { label: "negative" } },
    });
    const result = await executeSwitch(node, ctx);

    expect(result.value).toEqual({ __activePort: "negative" });
  });
});

/* -------------------------------------------------------------------------- */
/*  2. Switch port-based edge routing (full pipeline)                         */
/* -------------------------------------------------------------------------- */

describe("Switch port-based edge routing in pipeline", () => {
  const switchPipelineDef = (category: string): PipelineDefinition => ({
    id: "switch-routing-test",
    entry: ["start"],
    nodes: [
      { id: "start", type: "input" },
      {
        id: "router",
        type: "switch",
        expression: "inputs.category",
        cases: { billing: {}, support: {}, unknown: {} },
        default: "unknown",
      },
      { id: "billing_handler", type: "transform", expression: "({ branch: 'billing' })" },
      { id: "support_handler", type: "transform", expression: "({ branch: 'support' })" },
      { id: "unknown_handler", type: "transform", expression: "({ branch: 'unknown' })" },
      {
        id: "merge",
        type: "transform",
        expression: `
          artifacts.billing_handler
            ? artifacts.billing_handler
            : artifacts.support_handler
              ? artifacts.support_handler
              : artifacts.unknown_handler || ({ branch: 'none' })
        `,
      },
      { id: "out", type: "output", path: "result", source: "merge" },
    ],
    edges: [
      { from: { node: "start" }, to: { node: "router" } },
      { from: { node: "router", port: "billing" }, to: { node: "billing_handler" } },
      { from: { node: "router", port: "support" }, to: { node: "support_handler" } },
      { from: { node: "router", port: "unknown" }, to: { node: "unknown_handler" } },
      { from: { node: "billing_handler" }, to: { node: "merge" } },
      { from: { node: "support_handler" }, to: { node: "merge" } },
      { from: { node: "unknown_handler" }, to: { node: "merge" } },
      { from: { node: "merge" }, to: { node: "out" } },
    ],
  });

  it("routes to billing branch and skips support/unknown", async () => {
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(switchPipelineDef("billing"), { store });
    const record = await runner.run({ inputs: { category: "billing" } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_handler")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "support_handler")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "unknown_handler")?.status).toBe("skipped");
    expect(record.outputs?.result).toEqual({ branch: "billing" });
  });

  it("routes to support branch and skips billing/unknown", async () => {
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(switchPipelineDef("support"), { store });
    const record = await runner.run({ inputs: { category: "support" } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_handler")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "support_handler")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "unknown_handler")?.status).toBe("skipped");
    expect(record.outputs?.result).toEqual({ branch: "support" });
  });

  it("routes unrecognized category to default (unknown) port", async () => {
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(switchPipelineDef("shipping"), { store });
    const record = await runner.run({ inputs: { category: "shipping" } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_handler")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "support_handler")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "unknown_handler")?.status).toBe("completed");
    expect(record.outputs?.result).toEqual({ branch: "unknown" });
  });
});

/* -------------------------------------------------------------------------- */
/*  3. Conditional edges (when expressions)                                   */
/* -------------------------------------------------------------------------- */

describe("Conditional edges (when)", () => {
  it("skips node when all incoming when-conditions are false", async () => {
    const def: PipelineDefinition = {
      id: "when-false-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "({ val: 10 })" },
        { id: "guarded", type: "transform", expression: "({ ran: true })" },
        { id: "out", type: "output", path: "result", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "guarded" }, when: "artifacts.b.val > 100" },
        { from: { node: "b" }, to: { node: "out" } },
        { from: { node: "guarded" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "guarded")?.status).toBe("skipped");
  });

  it("executes node when at least one incoming when-condition is true", async () => {
    const def: PipelineDefinition = {
      id: "when-true-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "({ val: 200 })" },
        { id: "guarded", type: "transform", expression: "({ ran: true })" },
        { id: "out", type: "output", path: "result", source: "guarded" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "guarded" }, when: "artifacts.b.val > 100" },
        { from: { node: "guarded" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "guarded")?.status).toBe("completed");
    expect(record.outputs?.result).toEqual({ ran: true });
  });

  it("treats expression errors in when conditions as falsy", async () => {
    const def: PipelineDefinition = {
      id: "when-error-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "({ val: 1 })" },
        { id: "guarded", type: "transform", expression: "({ ran: true })" },
        { id: "out", type: "output", path: "result", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        // Reference a non-existent deep property — will throw at evaluation
        { from: { node: "b" }, to: { node: "guarded" }, when: "artifacts.nonexistent.deep.path === true" },
        { from: { node: "b" }, to: { node: "out" } },
        { from: { node: "guarded" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "guarded")?.status).toBe("skipped");
  });

  it("can reference inputs in when expressions", async () => {
    const def: PipelineDefinition = {
      id: "when-inputs-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "guarded", type: "transform", expression: "({ ran: true })" },
        { id: "out", type: "output", path: "result", source: "guarded" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "guarded" }, when: "inputs.enabled === true" },
        { from: { node: "guarded" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: { enabled: true } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "guarded")?.status).toBe("completed");
  });

  it("skips downstream nodes when upstream node was skipped", async () => {
    const def: PipelineDefinition = {
      id: "cascade-skip-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "({ flag: false })" },
        { id: "guarded", type: "transform", expression: "({ ran: true })" },
        { id: "downstream", type: "transform", expression: "({ also_ran: true })" },
        { id: "out", type: "output", path: "result", source: "b" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "guarded" }, when: "false" },
        { from: { node: "guarded" }, to: { node: "downstream" } },
        { from: { node: "b" }, to: { node: "out" } },
        { from: { node: "downstream" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "guarded")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "downstream")?.status).toBe("skipped");
  });
});

/* -------------------------------------------------------------------------- */
/*  4. Default edges                                                          */
/* -------------------------------------------------------------------------- */

describe("Default edges", () => {
  it("fires default edge when all sibling when-conditions are false", async () => {
    const def: PipelineDefinition = {
      id: "default-edge-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "({ mode: 'neither' })" },
        { id: "path_x", type: "transform", expression: "({ path: 'x' })" },
        { id: "path_y", type: "transform", expression: "({ path: 'y' })" },
        { id: "fallback", type: "transform", expression: "({ path: 'fallback' })" },
        { id: "out", type: "output", path: "result", source: "fallback" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "path_x" }, when: "artifacts.b.mode === 'x'" },
        { from: { node: "b" }, to: { node: "path_y" }, when: "artifacts.b.mode === 'y'" },
        { from: { node: "b" }, to: { node: "fallback" }, default: true },
        { from: { node: "path_x" }, to: { node: "out" } },
        { from: { node: "path_y" }, to: { node: "out" } },
        { from: { node: "fallback" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "path_x")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "path_y")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "fallback")?.status).toBe("completed");
    expect(record.outputs?.result).toEqual({ path: "fallback" });
  });

  it("does NOT fire default edge when a sibling when-condition is true", async () => {
    const def: PipelineDefinition = {
      id: "default-edge-not-fired",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "({ mode: 'x' })" },
        { id: "path_x", type: "transform", expression: "({ path: 'x' })" },
        { id: "fallback", type: "transform", expression: "({ path: 'fallback' })" },
        { id: "out", type: "output", path: "result", source: "path_x" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" } },
        { from: { node: "b" }, to: { node: "path_x" }, when: "artifacts.b.mode === 'x'" },
        { from: { node: "b" }, to: { node: "fallback" }, default: true },
        { from: { node: "path_x" }, to: { node: "out" } },
        { from: { node: "fallback" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "path_x")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "fallback")?.status).toBe("skipped");
  });
});

/* -------------------------------------------------------------------------- */
/*  5. on_error edge routing                                                  */
/* -------------------------------------------------------------------------- */

describe("on_error edge routing", () => {
  it("routes to fallback node when upstream agent fails", async () => {
    const failingAgent: AgentRunner = async () => {
      throw new Error("Agent timed out");
    };
    const def: PipelineDefinition = {
      id: "on-error-test",
      entry: ["start"],
      nodes: [
        { id: "start", type: "input" },
        { id: "risky_agent", type: "agent", prompt: "Do something risky" },
        { id: "error_fallback", type: "transform", expression: "({ error_handled: true, msg: artifacts.__error.message })" },
        { id: "out", type: "output", path: "result", source: "error_fallback" },
      ],
      edges: [
        { from: { node: "start" }, to: { node: "risky_agent" } },
        { from: { node: "risky_agent" }, to: { node: "error_fallback" }, on_error: true },
        // Guard edge so error_fallback has a non-on_error incoming edge
        { from: { node: "risky_agent" }, to: { node: "error_fallback" }, when: "!!artifacts.__error" },
        { from: { node: "error_fallback" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store, agentRunner: failingAgent });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "risky_agent")?.status).toBe("errored");
    expect(record.steps.find((s) => s.nodeId === "error_fallback")?.status).toBe("completed");
    expect(record.outputs?.result).toMatchObject({
      error_handled: true,
      msg: "Agent timed out",
    });
  });

  it("stores error details in artifacts.__error with message, nodeId, and stack", async () => {
    const failingAgent: AgentRunner = async () => {
      throw new Error("Connection refused");
    };
    const def: PipelineDefinition = {
      id: "error-artifact-test",
      entry: ["start"],
      nodes: [
        { id: "start", type: "input" },
        { id: "agent1", type: "agent", prompt: "Try something" },
        {
          id: "error_check",
          type: "transform",
          expression: "({ hasError: !!artifacts.__error, nodeId: artifacts.__error ? artifacts.__error.nodeId : null })",
        },
        { id: "out", type: "output", path: "result", source: "error_check" },
      ],
      edges: [
        { from: { node: "start" }, to: { node: "agent1" } },
        { from: { node: "agent1" }, to: { node: "error_check" }, on_error: true },
        { from: { node: "agent1" }, to: { node: "error_check" }, when: "!!artifacts.__error" },
        { from: { node: "error_check" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store, agentRunner: failingAgent });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.outputs?.result).toMatchObject({
      hasError: true,
      nodeId: "agent1",
    });
  });

  it("fails the run when node errors and no on_error edge exists", async () => {
    const failingAgent: AgentRunner = async () => {
      throw new Error("Fatal error");
    };
    const def: PipelineDefinition = {
      id: "no-error-edge-test",
      entry: ["start"],
      nodes: [
        { id: "start", type: "input" },
        { id: "agent1", type: "agent", prompt: "Try something" },
        { id: "out", type: "output", path: "result", source: "agent1" },
      ],
      edges: [
        { from: { node: "start" }, to: { node: "agent1" } },
        { from: { node: "agent1" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store, agentRunner: failingAgent });

    await expect(runner.run({ inputs: {} })).rejects.toThrow("Fatal error");
  });
});

/* -------------------------------------------------------------------------- */
/*  6. Loop with exit condition                                               */
/* -------------------------------------------------------------------------- */

describe("Loop node executor (executeLoop)", () => {
  it("iterates over collection and returns results array", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "[1, 2, 3]",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "loop.item * 10" },
        ],
      },
    };
    const ctx = makeContext();
    const result = await executeLoop(node, ctx);

    expect(result.artifactKey).toBe("loop1");
    expect(result.value).toEqual([10, 20, 30]);
  });

  it("exits early when exitCondition evaluates to truthy", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "['a', 'b', 'stop', 'd']",
      itemVar: "step",
      exitCondition: "loop.step === 'stop'",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "({ step: loop.step })" },
        ],
      },
    };
    const ctx = makeContext();
    const result = await executeLoop(node, ctx);

    // Should have processed 'a', 'b', and 'stop' (exit checked AFTER iteration)
    expect((result.value as unknown[]).length).toBeLessThanOrEqual(3);
  });

  it("respects maxIterations cap", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]",
      maxIterations: 3,
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "loop.item" },
        ],
      },
    };
    const ctx = makeContext();
    const result = await executeLoop(node, ctx);

    expect((result.value as unknown[]).length).toBe(3);
  });

  it("exposes custom itemVar and indexVar in loop context", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "['alpha', 'beta']",
      itemVar: "letter",
      indexVar: "pos",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "({ letter: loop.letter, pos: loop.pos })" },
        ],
      },
    };
    const ctx = makeContext();
    const result = await executeLoop(node, ctx);

    expect(result.value).toEqual([
      { letter: "alpha", pos: 0 },
      { letter: "beta", pos: 1 },
    ]);
  });

  it("evaluates collection expression with access to inputs and artifacts", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "inputs.items",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "loop.item.toUpperCase()" },
        ],
      },
    };
    const ctx = makeContext({ inputs: { items: ["foo", "bar"] } });
    const result = await executeLoop(node, ctx);

    expect(result.value).toEqual(["FOO", "BAR"]);
  });

  it("throws when collection expression does not evaluate to array", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "'not-an-array'",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "loop.item" },
        ],
      },
    };
    const ctx = makeContext();

    await expect(executeLoop(node, ctx)).rejects.toThrow(/array/i);
  });

  it("cleans up loop context variable after execution", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "[1]",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "loop.item" },
        ],
      },
    };
    const ctx = makeContext();
    await executeLoop(node, ctx);

    expect(ctx.artifacts["loop"]).toBeUndefined();
    expect(ctx.artifacts["loop1"]).toBeDefined();
  });

  it("makes loop.results available for exit condition evaluation", async () => {
    const node: LoopNode = {
      id: "loop1",
      type: "loop",
      collection: "[1, 2, 3, 4, 5]",
      exitCondition: "loop.results.length >= 3",
      body: {
        entry: ["body"],
        nodes: [
          { id: "body", type: "transform", expression: "loop.item * 2" },
        ],
      },
    };
    const ctx = makeContext();
    const result = await executeLoop(node, ctx);

    // Exit after 3 iterations (checked after each)
    expect((result.value as unknown[]).length).toBe(3);
  });
});

/* -------------------------------------------------------------------------- */
/*  6b. Loop in pipeline integration                                          */
/* -------------------------------------------------------------------------- */

describe("Loop node in pipeline", () => {
  it("executes loop within pipeline and produces array artifact", async () => {
    const def: PipelineDefinition = {
      id: "loop-pipeline-test",
      entry: ["start"],
      nodes: [
        { id: "start", type: "input" },
        {
          id: "loop1",
          type: "loop",
          collection: "inputs.items",
          body: {
            entry: ["process"],
            nodes: [
              { id: "process", type: "transform", expression: "({ value: loop.item + '_processed' })" },
            ],
          },
        },
        { id: "out", type: "output", path: "result", source: "loop1" },
      ],
      edges: [
        { from: { node: "start" }, to: { node: "loop1" } },
        { from: { node: "loop1" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: { items: ["a", "b", "c"] } });

    expect(record.status).toBe("completed");
    expect(record.outputs?.result).toEqual([
      { value: "a_processed" },
      { value: "b_processed" },
      { value: "c_processed" },
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/*  7. Schema validation                                                      */
/* -------------------------------------------------------------------------- */

describe("Schema validation for branching constructs", () => {
  it("validates switch node with valid cases and expression", () => {
    const def = {
      id: "valid-switch",
      entry: ["s"],
      nodes: [
        { id: "s", type: "switch", expression: "inputs.x", cases: { a: {}, b: {} }, default: "a" },
        { id: "ha", type: "transform", expression: "'a'" },
        { id: "hb", type: "transform", expression: "'b'" },
      ],
      edges: [
        { from: { node: "s", port: "a" }, to: { node: "ha" } },
        { from: { node: "s", port: "b" }, to: { node: "hb" } },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });

  it("rejects edge from switch with port not matching any case key", () => {
    const def = {
      id: "bad-switch-port",
      entry: ["s"],
      nodes: [
        { id: "s", type: "switch", expression: "inputs.x", cases: { a: {}, b: {} } },
        { id: "h", type: "transform", expression: "'x'" },
      ],
      edges: [
        { from: { node: "s", port: "nonexistent" }, to: { node: "h" } },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("nonexistent"))).toBe(true);
    }
  });

  it("rejects multiple default edges from the same source node", () => {
    const def = {
      id: "multi-default",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "'b'" },
        { id: "c", type: "transform", expression: "'c'" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" }, default: true },
        { from: { node: "a" }, to: { node: "c" }, default: true },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("multiple default"))).toBe(true);
    }
  });

  it("rejects multiple on_error edges from the same source node", () => {
    const def = {
      id: "multi-on-error",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "'b'" },
        { id: "c", type: "transform", expression: "'c'" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" }, on_error: true },
        { from: { node: "a" }, to: { node: "c" }, on_error: true },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("multiple on_error"))).toBe(true);
    }
  });

  it("rejects switch node with empty expression", () => {
    const def = {
      id: "empty-expr",
      entry: ["s"],
      nodes: [
        { id: "s", type: "switch", expression: "", cases: { a: {} } },
        { id: "a", type: "transform", expression: "'a'" },
      ],
      edges: [
        { from: { node: "s", port: "a" }, to: { node: "a" } },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(false);
  });

  it("accepts when, default, and on_error fields on edges", () => {
    const def = {
      id: "edge-fields",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "b", type: "transform", expression: "'b'" },
        { id: "c", type: "transform", expression: "'c'" },
        { id: "d", type: "transform", expression: "'d'" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "b" }, when: "inputs.x === 1" },
        { from: { node: "a" }, to: { node: "c" }, default: true },
        { from: { node: "a" }, to: { node: "d" }, on_error: true },
      ],
    };
    const result = pipelineDefinitionSchema.safeParse(def);
    expect(result.success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  8. Branch convergence                                                     */
/* -------------------------------------------------------------------------- */

describe("Branch convergence", () => {
  it("merge node executes when any one branch completes (others skipped)", async () => {
    const def: PipelineDefinition = {
      id: "convergence-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "check", type: "transform", expression: "({ route: inputs.route })" },
        { id: "path_a", type: "transform", expression: "({ from: 'a' })" },
        { id: "path_b", type: "transform", expression: "({ from: 'b' })" },
        {
          id: "merge",
          type: "transform",
          expression: "artifacts.path_a ? artifacts.path_a : artifacts.path_b || { from: 'none' }",
        },
        { id: "out", type: "output", path: "result", source: "merge" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "check" } },
        { from: { node: "check" }, to: { node: "path_a" }, when: "artifacts.check.route === 'a'" },
        { from: { node: "check" }, to: { node: "path_b" }, when: "artifacts.check.route === 'b'" },
        { from: { node: "path_a" }, to: { node: "merge" } },
        { from: { node: "path_b" }, to: { node: "merge" } },
        { from: { node: "merge" }, to: { node: "out" } },
      ],
    };

    // Route A
    const storeA = new MemoryRunStore();
    const runnerA = new DeterministicRunner(def, { store: storeA });
    const recordA = await runnerA.run({ inputs: { route: "a" } });
    expect(recordA.status).toBe("completed");
    expect(recordA.steps.find((s) => s.nodeId === "path_a")?.status).toBe("completed");
    expect(recordA.steps.find((s) => s.nodeId === "path_b")?.status).toBe("skipped");
    expect(recordA.outputs?.result).toEqual({ from: "a" });

    // Route B
    const storeB = new MemoryRunStore();
    const runnerB = new DeterministicRunner(def, { store: storeB });
    const recordB = await runnerB.run({ inputs: { route: "b" } });
    expect(recordB.status).toBe("completed");
    expect(recordB.steps.find((s) => s.nodeId === "path_a")?.status).toBe("skipped");
    expect(recordB.steps.find((s) => s.nodeId === "path_b")?.status).toBe("completed");
    expect(recordB.outputs?.result).toEqual({ from: "b" });
  });
});

/* -------------------------------------------------------------------------- */
/*  9. Integration: full branching pipeline                                   */
/* -------------------------------------------------------------------------- */

describe("Integration: switch + when + on_error + loop in single pipeline", () => {
  // Mirrors the branching.yaml example pipeline structure
  const fullBranchingDef: PipelineDefinition = {
    id: "full-branching-integration",
    entry: ["intake"],
    nodes: [
      { id: "intake", type: "input" },
      {
        id: "router",
        type: "switch",
        expression: "inputs.category",
        cases: { billing: {}, support: {}, unknown: {} },
        default: "unknown",
      },
      { id: "billing_agent", type: "agent", prompt: "Handle billing: {{inputs.task}}" },
      {
        id: "error_fallback",
        type: "transform",
        expression: `({ text: 'Billing error: ' + (artifacts.__error ? artifacts.__error.message : 'unknown') })`,
      },
      {
        id: "support_loop",
        type: "loop",
        collection: "inputs.items || ['check', 'verify', 'resolve']",
        itemVar: "step",
        exitCondition: "loop.step === 'resolved' || (loop.results.length > 0 && loop.results.some(function(r) { return r && r.done; }))",
        maxIterations: 10,
        body: {
          entry: ["process_step"],
          nodes: [
            {
              id: "process_step",
              type: "transform",
              expression: "({ step: loop.step, done: loop.step === 'resolve', message: 'Processed: ' + loop.step })",
            },
          ],
        },
      },
      {
        id: "unknown_handler",
        type: "transform",
        expression: `({ text: 'Unknown category: ' + inputs.category })`,
      },
      {
        id: "format_response",
        type: "transform",
        expression: `
          artifacts.billing_agent
            ? ({ source: 'billing', response: artifacts.billing_agent.text })
            : artifacts.error_fallback
              ? ({ source: 'billing_error', response: artifacts.error_fallback.text })
              : artifacts.support_loop
                ? ({ source: 'support', steps: artifacts.support_loop.length })
                : artifacts.unknown_handler
                  ? ({ source: 'unknown', response: artifacts.unknown_handler.text })
                  : ({ source: 'none' })
        `,
      },
      { id: "final_output", type: "output", source: "format_response", path: "result" },
    ],
    edges: [
      { from: { node: "intake" }, to: { node: "router" } },
      { from: { node: "router", port: "billing" }, to: { node: "billing_agent" } },
      { from: { node: "router", port: "support" }, to: { node: "support_loop" } },
      { from: { node: "router", port: "unknown" }, to: { node: "unknown_handler" } },
      { from: { node: "billing_agent" }, to: { node: "format_response" } },
      { from: { node: "billing_agent" }, to: { node: "error_fallback" }, on_error: true },
      { from: { node: "billing_agent" }, to: { node: "error_fallback" }, when: "!!artifacts.__error" },
      { from: { node: "error_fallback" }, to: { node: "format_response" } },
      { from: { node: "support_loop" }, to: { node: "format_response" } },
      { from: { node: "unknown_handler" }, to: { node: "format_response" } },
      { from: { node: "format_response" }, to: { node: "final_output" } },
    ],
  };

  it("billing happy path — agent succeeds, other branches skipped", async () => {
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(fullBranchingDef, { store, agentRunner: mockAgentRunner });
    const record = await runner.run({ inputs: { category: "billing", task: "refund" } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_agent")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "support_loop")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "unknown_handler")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "error_fallback")?.status).toBe("skipped");
    expect(record.outputs?.result).toMatchObject({ source: "billing" });
  });

  it("billing error path — agent fails, on_error routes to fallback", async () => {
    const failingAgent: AgentRunner = async () => {
      throw new Error("API timeout");
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(fullBranchingDef, { store, agentRunner: failingAgent });
    const record = await runner.run({ inputs: { category: "billing", task: "refund" } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_agent")?.status).toBe("errored");
    expect(record.steps.find((s) => s.nodeId === "error_fallback")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "support_loop")?.status).toBe("skipped");
    expect(record.outputs?.result).toMatchObject({ source: "billing_error" });
  });

  it("support path — loop iterates over items", async () => {
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(fullBranchingDef, { store });
    const record = await runner.run({
      inputs: { category: "support", items: ["check", "verify", "resolve"] },
    });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "support_loop")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_agent")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "unknown_handler")?.status).toBe("skipped");
    expect(record.outputs?.result).toMatchObject({ source: "support" });
  });

  it("unknown category — defaults to unknown handler via switch default port", async () => {
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(fullBranchingDef, { store });
    const record = await runner.run({ inputs: { category: "shipping" } });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "unknown_handler")?.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "billing_agent")?.status).toBe("skipped");
    expect(record.steps.find((s) => s.nodeId === "support_loop")?.status).toBe("skipped");
    expect(record.outputs?.result).toMatchObject({ source: "unknown" });
  });

  it("topological order is valid with branching graph", () => {
    const runner = new DeterministicRunner(fullBranchingDef);
    const order = runner.getExecutionOrder();

    // All nodes should be present
    const nodeIds = fullBranchingDef.nodes.map((n) => n.id);
    expect(order).toHaveLength(nodeIds.length);
    for (const id of nodeIds) {
      expect(order).toContain(id);
    }

    // Topological constraints: intake before router, router before branches
    expect(order.indexOf("intake")).toBeLessThan(order.indexOf("router"));
    expect(order.indexOf("router")).toBeLessThan(order.indexOf("billing_agent"));
    expect(order.indexOf("router")).toBeLessThan(order.indexOf("support_loop"));
    expect(order.indexOf("router")).toBeLessThan(order.indexOf("unknown_handler"));
    // format_response after all branches
    expect(order.indexOf("format_response")).toBeGreaterThan(order.indexOf("billing_agent"));
    expect(order.indexOf("format_response")).toBeGreaterThan(order.indexOf("support_loop"));
    expect(order.indexOf("format_response")).toBeGreaterThan(order.indexOf("unknown_handler"));
  });
});

/* -------------------------------------------------------------------------- */
/*  10. Expression evaluation in branching context                            */
/* -------------------------------------------------------------------------- */

describe("Expression evaluation in branching context", () => {
  it("switch expression can use complex JS expressions", async () => {
    const node: SwitchNode = {
      id: "s",
      type: "switch",
      expression: "inputs.score >= 80 ? 'high' : inputs.score >= 50 ? 'medium' : 'low'",
      cases: { high: {}, medium: {}, low: {} },
    };
    const ctx = makeContext({ inputs: { score: 75 } });
    const result = await executeSwitch(node, ctx);
    expect(result.value).toEqual({ __activePort: "medium" });
  });

  it("when conditions can use compound boolean logic", async () => {
    const def: PipelineDefinition = {
      id: "compound-when-test",
      entry: ["a"],
      nodes: [
        { id: "a", type: "input" },
        { id: "check", type: "transform", expression: "({ score: 85, verified: true })" },
        { id: "approved", type: "transform", expression: "({ status: 'approved' })" },
        { id: "out", type: "output", path: "result", source: "approved" },
      ],
      edges: [
        { from: { node: "a" }, to: { node: "check" } },
        {
          from: { node: "check" },
          to: { node: "approved" },
          when: "artifacts.check.score >= 80 && artifacts.check.verified === true",
        },
        { from: { node: "approved" }, to: { node: "out" } },
      ],
    };
    const store = new MemoryRunStore();
    const runner = new DeterministicRunner(def, { store });
    const record = await runner.run({ inputs: {} });

    expect(record.status).toBe("completed");
    expect(record.steps.find((s) => s.nodeId === "approved")?.status).toBe("completed");
  });
});
