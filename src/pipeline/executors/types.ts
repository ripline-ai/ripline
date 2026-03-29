import type { PipelineNode } from "../../types.js";
import type { RunStore } from "../../run-store.js";
import type { RunQueue } from "../../run-queue.js";
import type { Logger } from "../../log.js";

/** Result of executing a single node. Used for telemetry (artifact id + size). */
export type NodeResult = {
  /** Key under which the artifact was stored (e.g. node id). */
  artifactKey: string;
  /** The value stored; used to compute size for logging. */
  value: unknown;
  /** Set by enqueue node: child run IDs so runner can pause parent until they complete. */
  childRunIds?: string[];
  /** When true, the runner should re-execute this same node after resuming (used for multi-wave parallel loops). */
  rerunOnResume?: boolean;
};

/** Context passed to every node executor. */
export type ExecutorContext = {
  inputs: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  env: Record<string, string>;
  /** Outputs written by output nodes (key = path ?? node.id). */
  outputs: Record<string, unknown>;
  /** If set (e.g. from --out), write final outputs to this path. */
  outPath?: string;
  /** Current run ID (set when running a stored run); required for enqueue node. */
  runId?: string;
  /** Run store (set when queue is available); required for enqueue to update parent. */
  store?: RunStore;
  /** Queue to enqueue child runs; required for enqueue node. */
  queue?: RunQueue;
  /** Run-level session ID for agent nodes with resetSession: false (shared conversation). */
  sessionId?: string;
  /** Run-scoped logger (child with runId/nodeId). When set, agent runners can use it for run log capture. */
  log?: Logger;
};

export type NodeExecutor = (
  node: PipelineNode,
  context: ExecutorContext
) => Promise<NodeResult>;
