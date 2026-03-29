import { describe, expect, it } from "vitest";
import type { LoopNode } from "../../src/types.js";
import { executeLoop } from "../../src/pipeline/executors/loop.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";
import { MemoryRunStore } from "../../src/run-store-memory.js";
import { createRunQueue } from "../../src/run-queue.js";
import { computeDependencyWaves } from "../../src/lib/dependency-waves.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a MemoryRunStore + RunQueue + parent run and return a ready context. */
async function setupContext(
  stories: unknown[],
  overrides?: Partial<ExecutorContext>,
): Promise<{ store: MemoryRunStore; context: ExecutorContext; parentId: string }> {
  const store = new MemoryRunStore();
  const queue = createRunQueue(store);
  const parent = await store.createRun({ pipelineId: "build_from_plan", inputs: {} });
  await store.save({ ...parent, status: "running", steps: [] });

  const context: ExecutorContext = {
    inputs: { maxParallelStories: 100 }, // high default so tests control via maxConcurrency
    artifacts: { stories },
    env: {},
    outputs: {},
    runId: parent.id,
    store,
    queue,
    ...overrides,
  };
  return { store, context, parentId: parent.id };
}

/** Build a parallel loop node for test scenarios. */
function makeLoopNode(overrides?: Partial<LoopNode>): LoopNode {
  return {
    id: "story_loop",
    type: "loop",
    collection: "artifacts.stories",
    itemVar: "story",
    mode: "parallel",
    body: { pipelineId: "implement_story" },
    ...overrides,
  } as LoopNode;
}

/**
 * Simulate what the scheduler does after a wave is dispatched:
 * complete (or fail) child runs, then re-invoke executeLoop to resume.
 */
async function completeChildRuns(
  store: MemoryRunStore,
  childRunIds: string[],
  outcomes?: Map<string, { fail?: string; outputs?: Record<string, unknown> }>,
): Promise<void> {
  for (const id of childRunIds) {
    const record = await store.load(id);
    if (!record) throw new Error(`Child run ${id} not found`);
    const outcome = outcomes?.get(record.taskId ?? "");
    if (outcome?.fail) {
      record.status = "errored";
      record.error = outcome.fail;
      record.steps = [
        { nodeId: "agent", status: "errored", error: outcome.fail, errorCategory: "permanent" },
      ];
      await store.save(record);
    } else {
      const outputs = outcome?.outputs ?? { result: { text: `done-${record.taskId}` } };
      await store.completeRun(record, outputs);
    }
  }
}

// ---------------------------------------------------------------------------
// Test: computeDependencyWaves (unit-level, verifies wave grouping logic)
// ---------------------------------------------------------------------------

describe("computeDependencyWaves", () => {
  it("3 independent stories produce a single wave", () => {
    const stories = [
      { id: "A" },
      { id: "B" },
      { id: "C" },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.map((s) => s.id).sort()).toEqual(["A", "B", "C"]);
  });

  it("diamond pattern (A→C, B→C) produces 2 waves", () => {
    const stories = [
      { id: "A" },
      { id: "B" },
      { id: "C", dependsOn: ["A", "B"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(2);
    expect(waves[0]!.map((s) => s.id).sort()).toEqual(["A", "B"]);
    expect(waves[1]!.map((s) => s.id)).toEqual(["C"]);
  });

  it("linear chain A→B→C produces 3 sequential waves", () => {
    const stories = [
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.map((s) => s.id)).toEqual(["A"]);
    expect(waves[1]!.map((s) => s.id)).toEqual(["B"]);
    expect(waves[2]!.map((s) => s.id)).toEqual(["C"]);
  });

  it("maxPerWave splits large waves into sub-waves", () => {
    const stories = [
      { id: "A" },
      { id: "B" },
      { id: "C" },
      { id: "D" },
    ];
    const waves = computeDependencyWaves(stories, { maxPerWave: 2 });
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(2);
    expect(waves[1]).toHaveLength(2);
  });

  it("rejects cyclic dependencies", () => {
    const stories = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];
    expect(() => computeDependencyWaves(stories)).toThrow(/cycle/i);
  });
});

// ---------------------------------------------------------------------------
// Integration tests: parallel loop executor with MemoryRunStore
// ---------------------------------------------------------------------------

describe("Parallel loop executor – wave execution", () => {
  it("3 independent stories execute in a single wave with all child runs dispatched together", async () => {
    const stories = [
      { id: "s1", title: "Story 1" },
      { id: "s2", title: "Story 2" },
      { id: "s3", title: "Story 3" },
    ];
    const { store, context } = await setupContext(stories);
    const node = makeLoopNode();

    // First invocation: should dispatch all 3 stories in wave 0
    const result = await executeLoop(node, context);

    expect(result.childRunIds).toHaveLength(3);
    // Single wave, so no rerunOnResume — this is the last (only) wave
    expect(result.rerunOnResume).toBeFalsy();

    // All 3 child runs should be pending in the store
    const pending = await store.list({ status: "pending" });
    expect(pending).toHaveLength(3);

    // Complete all children and resume
    await completeChildRuns(store, result.childRunIds!);
    const finalResult = await executeLoop(node, context);

    // Final result should contain all 3 iteration results
    expect(finalResult.childRunIds).toBeUndefined();
    expect(finalResult.value).toHaveLength(3);
  });

  it("diamond pattern A→C, B→C produces wave 1=[A,B] and wave 2=[C]", async () => {
    const stories = [
      { id: "A", title: "Story A" },
      { id: "B", title: "Story B" },
      { id: "C", title: "Story C", dependsOn: ["A", "B"] },
    ];
    const { store, context } = await setupContext(stories);
    const node = makeLoopNode();

    // Wave 0: dispatch A and B
    const wave0 = await executeLoop(node, context);
    expect(wave0.childRunIds).toHaveLength(2);
    expect(wave0.rerunOnResume).toBe(true); // more waves remain

    // Verify child inputs contain the correct stories
    const wave0Runs = await Promise.all(
      wave0.childRunIds!.map((id) => store.load(id)),
    );
    const wave0StoryIds = wave0Runs
      .map((r) => (r!.inputs.story as Record<string, unknown>)?.id)
      .sort();
    expect(wave0StoryIds).toEqual(["A", "B"]);

    // Complete wave 0 children
    await completeChildRuns(store, wave0.childRunIds!);

    // Wave 1: dispatch C
    const wave1 = await executeLoop(node, context);
    expect(wave1.childRunIds).toHaveLength(1);
    expect(wave1.rerunOnResume).toBeFalsy(); // last wave

    const wave1Run = await store.load(wave1.childRunIds![0]!);
    expect((wave1Run!.inputs.story as Record<string, unknown>)?.id).toBe("C");

    // Complete wave 1 and finalize
    await completeChildRuns(store, wave1.childRunIds!);
    const finalResult = await executeLoop(node, context);
    expect(finalResult.childRunIds).toBeUndefined();
    expect(finalResult.value).toHaveLength(3);
  });

  it("linear chain A→B→C produces 3 sequential waves of 1", async () => {
    const stories = [
      { id: "A", title: "Story A" },
      { id: "B", title: "Story B", dependsOn: ["A"] },
      { id: "C", title: "Story C", dependsOn: ["B"] },
    ];
    const { store, context } = await setupContext(stories);
    const node = makeLoopNode();

    // Wave 0: A
    const wave0 = await executeLoop(node, context);
    expect(wave0.childRunIds).toHaveLength(1);
    expect(wave0.rerunOnResume).toBe(true);
    await completeChildRuns(store, wave0.childRunIds!);

    // Wave 1: B
    const wave1 = await executeLoop(node, context);
    expect(wave1.childRunIds).toHaveLength(1);
    expect(wave1.rerunOnResume).toBe(true);
    await completeChildRuns(store, wave1.childRunIds!);

    // Wave 2: C (last wave)
    const wave2 = await executeLoop(node, context);
    expect(wave2.childRunIds).toHaveLength(1);
    expect(wave2.rerunOnResume).toBeFalsy();
    await completeChildRuns(store, wave2.childRunIds!);

    // Finalize
    const finalResult = await executeLoop(node, context);
    expect(finalResult.childRunIds).toBeUndefined();
    expect(finalResult.value).toHaveLength(3);
  });

  it("maxConcurrency=2 with 4 independent stories produces 2 sub-waves of 2", async () => {
    const stories = [
      { id: "s1", title: "Story 1" },
      { id: "s2", title: "Story 2" },
      { id: "s3", title: "Story 3" },
      { id: "s4", title: "Story 4" },
    ];
    const { store, context } = await setupContext(stories, {
      inputs: { maxParallelStories: 2 },
    });
    const node = makeLoopNode();

    // Sub-wave 0: first 2 stories
    const sw0 = await executeLoop(node, context);
    expect(sw0.childRunIds).toHaveLength(2);
    expect(sw0.rerunOnResume).toBe(true);
    await completeChildRuns(store, sw0.childRunIds!);

    // Sub-wave 1: next 2 stories
    const sw1 = await executeLoop(node, context);
    expect(sw1.childRunIds).toHaveLength(2);
    expect(sw1.rerunOnResume).toBeFalsy(); // last sub-wave
    await completeChildRuns(store, sw1.childRunIds!);

    // Finalize
    const finalResult = await executeLoop(node, context);
    expect(finalResult.childRunIds).toBeUndefined();
    expect(finalResult.value).toHaveLength(4);
  });

  it("story failure in wave 2 fails the pipeline, wave 1 results are preserved", async () => {
    const stories = [
      { id: "A", title: "Story A" },
      { id: "B", title: "Story B" },
      { id: "C", title: "Story C", dependsOn: ["A", "B"] },
    ];
    const { store, context } = await setupContext(stories);
    const node = makeLoopNode();

    // Wave 0: dispatch A and B
    const wave0 = await executeLoop(node, context);
    expect(wave0.childRunIds).toHaveLength(2);
    await completeChildRuns(store, wave0.childRunIds!);

    // Wave 1: dispatch C — it will fail
    const wave1 = await executeLoop(node, context);
    expect(wave1.childRunIds).toHaveLength(1);

    // Fail story C
    const outcomes = new Map<string, { fail?: string }>();
    // The taskId is the collection index as a string
    const cRecord = await store.load(wave1.childRunIds![0]!);
    outcomes.set(cRecord!.taskId ?? "", { fail: "Build compilation error" });
    await completeChildRuns(store, wave1.childRunIds!, outcomes);

    // Resume should throw WaveFailureError
    await expect(executeLoop(node, context)).rejects.toThrow(/wave.*failed|failed.*wave/i);

    // Verify wave 1 results (A, B) are preserved in artifacts
    const stateKey = `__parallel_loop_state_${node.id}`;
    const state = context.artifacts[stateKey] as {
      iterationResults: unknown[];
    } | undefined;
    // Results from wave 0 should still exist
    const iterationResults = state?.iterationResults ?? context.artifacts[node.id] as unknown[];
    expect(iterationResults).toBeDefined();
    // A and B (indices 0, 1) should have results
    expect(iterationResults![0]).not.toBeNull();
    expect(iterationResults![1]).not.toBeNull();
  });

  it("cyclic dependsOn is rejected before execution starts (at compute_waves step)", () => {
    const stories = [
      { id: "A", dependsOn: ["C"] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    // The cycle detection happens in computeDependencyWaves
    expect(() => computeDependencyWaves(stories)).toThrow(/cycle/i);
    expect(() => computeDependencyWaves(stories)).toThrow(/A.*B.*C|B.*C.*A|C.*A.*B/);
  });

  it("cycle detection via the loop executor rejects before dispatching any children", async () => {
    const stories = [
      { id: "X", dependsOn: ["Y"] },
      { id: "Y", dependsOn: ["X"] },
    ];
    const { store, context } = await setupContext(stories);
    const node = makeLoopNode();

    await expect(executeLoop(node, context)).rejects.toThrow(/cycle/i);

    // No child runs should have been created
    const all = await store.list();
    // Only the parent run should exist
    const childRuns = all.filter((r) => r.parentRunId !== undefined);
    expect(childRuns).toHaveLength(0);
  });

  it("child runs receive __loop context with waveIndex and priorResults", async () => {
    const stories = [
      { id: "A", title: "Story A" },
      { id: "B", title: "Story B", dependsOn: ["A"] },
    ];
    const { store, context } = await setupContext(stories);
    const node = makeLoopNode();

    // Wave 0: A
    const wave0 = await executeLoop(node, context);
    const wave0Run = await store.load(wave0.childRunIds![0]!);
    const loop0 = wave0Run!.inputs.__loop as Record<string, unknown>;
    expect(loop0.waveIndex).toBe(0);
    expect(loop0.priorResults).toEqual([]);

    await completeChildRuns(store, wave0.childRunIds!, new Map([
      [wave0Run!.taskId ?? "", { outputs: { result: { text: "A-done" } } }],
    ]));

    // Wave 1: B — should have priorResults from A
    const wave1 = await executeLoop(node, context);
    const wave1Run = await store.load(wave1.childRunIds![0]!);
    const loop1 = wave1Run!.inputs.__loop as Record<string, unknown>;
    expect(loop1.waveIndex).toBe(1);
    const priorResults = loop1.priorResults as Array<{ id?: string; result: unknown }>;
    expect(priorResults).toHaveLength(1);
    expect(priorResults[0]!.id).toBe("A");
  });
});
