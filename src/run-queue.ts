import type { RunStore } from "./run-store.js";
import type { PipelineRunRecord, QueueMode, RunSource } from "./types.js";

export type EnqueueOptions = {
  parentRunId?: string;
  /** How this run was initiated. Defaults to 'user'. */
  source?: RunSource;
  taskId?: string;
  queueMode?: QueueMode;
  /** Named queue this run belongs to. Defaults to "default". */
  queueName?: string;
  /** Optional webhook URL to receive push notifications on run completion/error. */
  webhook_url?: string;
};

export type RunQueue = {
  /** Add a run to the queue (creates run with status pending). Returns runId or runIds. */
  enqueue(
    pipelineId: string,
    inputs: Record<string, unknown>,
    options?: EnqueueOptions
  ): Promise<string | string[]>;
  /**
   * Claim the next pending run (FIFO), set status to running, return record or null.
   * When queueName is provided, only claim runs from that queue.
   * Runs whose queueName is undefined or missing fall back to the "default" queue.
   */
  claimNext(queueName?: string): Promise<PipelineRunRecord | null>;
  /** Number of runs with status pending. */
  depth(): Promise<number>;
  /** Pending counts grouped by queue name. */
  depthByQueue(): Promise<Map<string, number>>;
  /** Number of runs with status running, grouped by queue name. */
  runningByQueue(): Promise<Map<string, number>>;
};

export function createRunQueue(store: RunStore): RunQueue {
  return {
    async enqueue(
      pipelineId: string,
      inputs: Record<string, unknown>,
      options?: EnqueueOptions
    ): Promise<string | string[]> {
      const record = await store.createRun({
        pipelineId,
        inputs,
        ...(options?.parentRunId !== undefined && { parentRunId: options.parentRunId }),
        ...(options?.source !== undefined && { source: options.source }),
        ...(options?.taskId !== undefined && { taskId: options.taskId }),
        ...(options?.queueMode !== undefined && { queueMode: options.queueMode }),
        ...(options?.queueName !== undefined && { queueName: options.queueName }),
        ...(options?.webhook_url !== undefined && { webhook_url: options.webhook_url }),
      });
      if (options?.parentRunId) {
        const parent = await store.load(options.parentRunId);
        if (parent) {
          parent.childRunIds = [...(parent.childRunIds ?? []), record.id];
          await store.save(parent);
        }
      }
      return record.id;
    },

    async claimNext(queueName?: string): Promise<PipelineRunRecord | null> {
      const pending = await store.list({ status: "pending" });
      // Filter candidates to this worker's queue.
      // A run with no queueName (or queueName === undefined) is treated as "default".
      const effectiveQueue = queueName ?? "default";
      const candidates = pending.filter((r) => (r.queueName ?? "default") === effectiveQueue);
      for (const candidate of candidates) {
        if (await store.claimRun(candidate.id)) {
          // Re-load to get the saved "running" record with updated timestamp
          return await store.load(candidate.id) ?? candidate;
        }
      }
      return null;
    },

    async depth(): Promise<number> {
      const pending = await store.list({ status: "pending" });
      return pending.length;
    },

    async depthByQueue(): Promise<Map<string, number>> {
      const pending = await store.list({ status: "pending" });
      const counts = new Map<string, number>();
      for (const run of pending) {
        const name = run.queueName ?? "default";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return counts;
    },

    async runningByQueue(): Promise<Map<string, number>> {
      const running = await store.list({ status: "running" });
      const counts = new Map<string, number>();
      for (const run of running) {
        const name = run.queueName ?? "default";
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      return counts;
    },
  };
}
