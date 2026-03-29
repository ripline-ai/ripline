import vm from "node:vm";
import type { LoopNode, PipelineNode, AgentDefinition, SkillsRegistry } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import type { AgentRunner } from "./agent.js";
import { executeAgent } from "./agent.js";
import { executeTransform } from "./transform.js";
import { computeDependencyWaves } from "../../lib/dependency-waves.js";
import type { Story } from "../../lib/dependency-waves.js";
import {
  deriveResultKey,
  mergeWaveResults,
  buildPriorResultsContext,
  safeLargeArtifact,
} from "../../lib/merge-iteration-results.js";

const DEFAULT_TIMEOUT_MS = 5000;

type LoopOptions = {
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
  agentDefinitions?: Record<string, AgentDefinition>;
  skillsRegistry?: SkillsRegistry;
  skillsDir?: string;
};

/**
 * Internal state for a parallel loop, stored in context.artifacts under a
 * private key so it survives pause/resume cycles.
 */
type ParallelLoopState = {
  /** Pre-computed dependency waves (each wave is an array of original collection indices). */
  waves: number[][];
  /** Index of the next wave to dispatch. */
  nextWaveIndex: number;
  /** Accumulated iteration results (in dependency order). */
  iterationResults: unknown[];
  /** Child run IDs from the most recently dispatched wave (for result collection on resume). */
  lastWaveChildRunIds: string[];
  /** Map from child runId → original collection index, for the last dispatched wave. */
  childRunIdToIndex: Record<string, number>;
  /** Output key to extract from child runs to match sequential loop shape. */
  resultKey?: string;
};

/** Artifact key used to persist parallel-loop state across pause/resume cycles. */
function parallelStateKey(nodeId: string): string {
  return `__parallel_loop_state_${nodeId}`;
}

/**
 * Execute a single body node inside a loop iteration.
 * Handles agent and transform types; other types are skipped.
 */
async function executeBodyNode(
  node: PipelineNode,
  context: ExecutorContext,
  options?: LoopOptions
): Promise<NodeResult | null> {
  if (node.type === "agent") {
    const agentNode = node as import("../../types.js").AgentNode;
    return executeAgent(
      agentNode,
      context,
      {
        ...(options?.agentRunner !== undefined && { agentRunner: options.agentRunner }),
        ...(options?.claudeCodeRunner !== undefined && { claudeCodeRunner: options.claudeCodeRunner }),
      },
      options?.agentDefinitions,
      options?.skillsRegistry,
      options?.skillsDir
    );
  }
  if (node.type === "transform") {
    const transformNode = node as import("../../types.js").TransformNode;
    return executeTransform(transformNode, context);
  }
  return null;
}

/**
 * Convert collection items to Story objects for computeDependencyWaves.
 * Each item must have an `id` field. Dependencies are read from the
 * field specified by `dependsOnField` (default: "dependsOn").
 */
function collectionToStories(
  collection: unknown[],
  dependsOnField: string,
): Story[] {
  return collection.map((item, index) => {
    const obj = item as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : String(index);
    const deps = Array.isArray(obj[dependsOnField]) ? (obj[dependsOnField] as string[]) : undefined;
    return { id, dependsOn: deps, order: index };
  });
}

/**
 * Build a map from story ID back to collection index.
 */
function storyIdToIndex(collection: unknown[]): Map<string, number> {
  const map = new Map<string, number>();
  for (let i = 0; i < collection.length; i++) {
    const obj = collection[i] as Record<string, unknown>;
    const id = typeof obj.id === "string" ? obj.id : String(i);
    map.set(id, i);
  }
  return map;
}

/**
 * Execute a parallel loop: dispatch items in dependency waves via the queue,
 * pausing after each wave until all children complete.
 */
async function executeParallelLoop(
  node: LoopNode,
  context: ExecutorContext,
  collection: unknown[],
): Promise<NodeResult> {
  const { runId, queue, store } = context;
  if (!runId || !queue || !store) {
    throw new Error(
      `Loop node "${node.id}" with mode: 'parallel' requires runId, queue, and store in executor context`,
    );
  }

  if (!node.body.pipelineId) {
    throw new Error(
      `Loop node "${node.id}" with mode: 'parallel' requires body.pipelineId (child pipeline to run per item)`,
    );
  }

  const stateKey = parallelStateKey(node.id);
  const itemVar = node.itemVar ?? "item";
  const dependsOnField = node.dependsOnField ?? "dependsOn";

  // ── Check for existing parallel state (resume path) ────────────
  let state = context.artifacts[stateKey] as ParallelLoopState | undefined;

  if (state && state.nextWaveIndex > 0) {
    // Resuming after a wave completed — collect child results and merge
    // into iterationResults, normalizing to match sequential loop shape.
    const rawResults = await collectWaveResults(
      store,
      state.lastWaveChildRunIds,
      state.childRunIdToIndex,
    );
    mergeWaveResults(state.iterationResults, rawResults, state.resultKey);
  }

  // ── First invocation: compute waves ────────────────────────────
  if (!state) {
    const stories = collectionToStories(collection, dependsOnField);
    const idToIdx = storyIdToIndex(collection);

    // Resolve maxConcurrency: support numeric values and input references.
    // Falls back to maxParallelStories from inputs (default 3) when not set on the node.
    let resolvedMaxConcurrency = node.maxConcurrency;
    if (resolvedMaxConcurrency === undefined) {
      const fromInputs = (context.inputs as Record<string, unknown>)?.maxParallelStories;
      resolvedMaxConcurrency = fromInputs !== undefined ? (Number(fromInputs) || 3) : 3;
    }

    const storyWaves = computeDependencyWaves(stories,
      resolvedMaxConcurrency !== undefined ? { maxPerWave: resolvedMaxConcurrency } : {},
    );
    // Convert story waves to index waves.
    const waves = storyWaves.map((wave) =>
      wave.map((s) => idToIdx.get(s.id)!),
    );

    // Derive resultKey from inline body nodes so child outputs can be
    // normalized to match the sequential loop's per-iteration shape.
    const resultKey = deriveResultKey(node.body.nodes);

    state = {
      waves,
      nextWaveIndex: 0,
      iterationResults: new Array(collection.length).fill(null),
      lastWaveChildRunIds: [],
      childRunIdToIndex: {},
      ...(resultKey !== undefined ? { resultKey } : {}),
    };
  }

  // ── Dispatch next wave ─────────────────────────────────────────
  // After the init block above, state is always defined.
  const st = state!;
  if (st.nextWaveIndex < st.waves.length) {
    const waveIndices = st.waves[st.nextWaveIndex]!;
    const childRunIds: string[] = [];
    const childRunIdToIndex: Record<string, number> = {};

    // Build prior-wave results so child runs in this wave can access
    // outputs from earlier waves via inputs.__loop.priorResults.
    const priorResults = st.nextWaveIndex > 0
      ? buildPriorResultsContext(st.iterationResults, collection)
      : [];

    for (const idx of waveIndices) {
      const item = collection[idx];
      const childRunId = await queue.enqueue(
        node.body.pipelineId!,
        {
          ...context.inputs,
          [itemVar]: item,
          __loop: {
            index: idx,
            item,
            parentNodeId: node.id,
            waveIndex: st.nextWaveIndex,
            priorResults,
          },
        },
        { parentRunId: runId, taskId: String(idx), queueMode: "per-item" },
      );
      const id = Array.isArray(childRunId) ? childRunId[0]! : childRunId;
      childRunIds.push(id);
      childRunIdToIndex[id] = idx;
    }

    st.lastWaveChildRunIds = childRunIds;
    st.childRunIdToIndex = childRunIdToIndex;
    st.nextWaveIndex++;

    // Persist state so it survives the pause/resume cycle.
    context.artifacts[stateKey] = st;

    const isLastWave = st.nextWaveIndex >= st.waves.length;

    // Return childRunIds to trigger runner pause.
    // If more waves remain, set rerunOnResume so the runner re-executes this node.
    return {
      artifactKey: node.id,
      value: st.iterationResults,
      childRunIds,
      ...(!isLastWave && { rerunOnResume: true }),
    };
  }

  // ── All waves complete — finalize ──────────────────────────────
  // Apply safe-large-artifact handling to final results.
  const finalResults = st.iterationResults.map((r) => safeLargeArtifact(r));

  // Expose loop context one final time for downstream consumption.
  context.artifacts["loop"] = {
    [itemVar]: null,
    index: collection.length,
    results: finalResults,
  };

  // Clean up internal state.
  delete context.artifacts[stateKey];
  delete context.artifacts["loop"];

  context.artifacts[node.id] = finalResults;
  return { artifactKey: node.id, value: finalResults };
}

/**
 * Collect results from completed child runs for a wave.
 */
async function collectWaveResults(
  store: import("../../run-store.js").RunStore,
  childRunIds: string[],
  childRunIdToIndex: Record<string, number>,
): Promise<Array<{ index: number; result: unknown }>> {
  const results: Array<{ index: number; result: unknown }> = [];
  for (const childId of childRunIds) {
    const record = await store.load(childId);
    const index = childRunIdToIndex[childId]!;
    if (record?.status === "completed" && record.outputs) {
      // Use the full outputs object as the iteration result.
      results.push({ index, result: record.outputs });
    } else {
      results.push({
        index,
        result: {
          __error: true,
          status: record?.status ?? "unknown",
          error: record?.error ?? "Child run not found or not completed",
        },
      });
    }
  }
  return results;
}

/**
 * Loop node executor: iterates over a collection artifact, running body nodes
 * for each item. The current item is exposed as `loop.{itemVar}` (default: `loop.item`)
 * in the interpolation context (via context.artifacts.loop).
 *
 * When mode is 'parallel', items are grouped into dependency waves using
 * computeDependencyWaves and dispatched as concurrent child runs per wave,
 * pausing between waves.
 */
export async function executeLoop(
  node: LoopNode,
  context: ExecutorContext,
  options?: LoopOptions
): Promise<NodeResult> {
  // Evaluate collection expression in a sandboxed VM
  const sandbox = {
    inputs: context.inputs,
    artifacts: context.artifacts,
    env: context.env,
    JSON,
  };
  vm.createContext(sandbox);

  const code = `(function() { return (${node.collection}); })()`;
  const collection = vm.runInContext(code, sandbox, { timeout: DEFAULT_TIMEOUT_MS });

  if (!Array.isArray(collection)) {
    throw new Error(
      `Loop node "${node.id}": collection expression must evaluate to an array (got ${typeof collection})`
    );
  }

  // ── Parallel mode: dependency-wave execution via child runs ────
  if (node.mode === "parallel") {
    return executeParallelLoop(node, context, collection);
  }

  // ── Sequential mode (default): inline body execution ───────────
  const maxIterations = node.maxIterations ?? collection.length;
  const itemVar = node.itemVar ?? "item";
  const indexVar = node.indexVar;
  const bodyNodes = node.body.nodes ?? [];
  const iterationResults: unknown[] = [];

  for (let i = 0; i < Math.min(collection.length, maxIterations); i++) {
    const item = collection[i];

    // Expose current item as loop.{itemVar} in artifacts so agent prompts can
    // reference {{ loop.idea.title }} etc. via interpolateTemplate's spread of artifacts.
    context.artifacts["loop"] = {
      [itemVar]: item,
      ...(indexVar !== undefined ? { [indexVar]: i } : {}),
      index: i,
      results: iterationResults,
    };

    // Execute body nodes in declaration order (edges ignored for now — simple linear body)
    for (const bodyNode of bodyNodes) {
      const result = await executeBodyNode(bodyNode, context, options);
      if (result) {
        context.artifacts[result.artifactKey] = result.value;
      }
    }

    // Capture last body node's artifact as the iteration result
    const lastBodyNode = bodyNodes[bodyNodes.length - 1];
    iterationResults.push(lastBodyNode ? context.artifacts[lastBodyNode.id] : null);

    // Evaluate exitCondition after each iteration; break early if truthy
    if (node.exitCondition) {
      const exitSandbox = {
        inputs: context.inputs,
        artifacts: context.artifacts,
        env: context.env,
        loop: context.artifacts["loop"],
        JSON,
      };
      vm.createContext(exitSandbox);
      const exitCode = `(function() { return (${node.exitCondition}); })()`;
      const shouldExit = vm.runInContext(exitCode, exitSandbox, { timeout: DEFAULT_TIMEOUT_MS });
      if (shouldExit) {
        break;
      }
    }
  }

  // Clean up loop context variable
  delete context.artifacts["loop"];

  const value = iterationResults;
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
