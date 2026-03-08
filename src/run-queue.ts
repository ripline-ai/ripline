import type { RunStore } from "./run-store.js";
import type { PipelineRunRecord, QueueMode } from "./types.js";

export type EnqueueOptions = {
  parentRunId?: string;
  taskId?: string;
  queueMode?: QueueMode;
};

export type RunQueue = {
  /** Add a run to the queue (creates run with status pending). Returns runId or runIds. */
  enqueue(
    pipelineId: string,
    inputs: Record<string, unknown>,
    options?: EnqueueOptions
  ): Promise<string | string[]>;
  /** Claim the next pending run (FIFO), set status to running, return record or null. */
  claimNext(): Promise<PipelineRunRecord | null>;
  /** Number of runs with status pending. */
  depth(): Promise<number>;
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
        ...(options?.taskId !== undefined && { taskId: options.taskId }),
        ...(options?.queueMode !== undefined && { queueMode: options.queueMode }),
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

    async claimNext(): Promise<PipelineRunRecord | null> {
      const pending = await store.list({ status: "pending" });
      for (const candidate of pending) {
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
  };
}
