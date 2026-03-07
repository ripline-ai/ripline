import type { RunStore } from "./run-store.js";
import type { RunQueue } from "./run-queue.js";
import type { PipelineRegistryEntry } from "./types.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";

export type SchedulerConfig = {
  store: RunStore;
  queue: RunQueue;
  registry: { get(id: string): Promise<PipelineRegistryEntry | null> };
  maxConcurrency: number;
  agentRunner?: AgentRunner;
  /** Poll interval when queue is empty (ms). */
  pollIntervalMs?: number;
};

export type SchedulerMetrics = {
  queueDepth: number;
  activeWorkers: number;
  avgDurationMs?: number;
  completedRunsCount?: number;
};

export type Scheduler = {
  start(): void;
  stop(): void;
  getMetrics(): Promise<SchedulerMetrics>;
};

export function createScheduler(config: SchedulerConfig): Scheduler {
  const {
    store,
    queue,
    registry,
    maxConcurrency,
    agentRunner,
    pollIntervalMs = 500,
  } = config;

  let stopped = false;
  let activeWorkers = 0;
  const durations: number[] = [];
  let completedRunsCount = 0;

  async function worker(): Promise<void> {
    while (!stopped) {
      const record = await queue.claimNext();
      if (!record) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      activeWorkers++;
      const startMs = Date.now();
      try {
        const entry = await registry.get(record.pipelineId);
        if (!entry) {
          await store.failRun(record, `Pipeline not found: ${record.pipelineId}`);
          continue;
        }
        const runner = new DeterministicRunner(entry.definition, {
          store,
          queue,
          quiet: true,
          ...(agentRunner && { agentRunner }),
        });
        await runner.run({
          startRunId: record.id,
        });
        completedRunsCount++;
        durations.push(Date.now() - startMs);

        const completedRecord = await store.load(record.id);
        if (completedRecord?.parentRunId && completedRecord.status === "completed") {
          const parent = await store.load(completedRecord.parentRunId);
          if (parent?.status === "paused" && parent.childRunIds?.length) {
            const children = await Promise.all(
              parent.childRunIds.map((id) => store.load(id))
            );
            const allCompleted = children.every((r) => r?.status === "completed");
            if (allCompleted) {
              const parentEntry = await registry.get(parent.pipelineId);
              if (parentEntry) {
                const parentRunner = new DeterministicRunner(parentEntry.definition, {
                  store,
                  queue,
                  quiet: true,
                  ...(agentRunner && { agentRunner }),
                });
                try {
                  await parentRunner.run({ resumeRunId: parent.id });
                } catch (resumeErr) {
                  const msg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                  if (!msg.includes("not resumable")) throw resumeErr;
                }
              }
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const loaded = await store.load(record.id);
        if (loaded) await store.failRun(loaded, msg);
      } finally {
        activeWorkers--;
      }
    }
  }

  const workers: Promise<void>[] = [];

  return {
    start() {
      stopped = false;
      for (let i = 0; i < maxConcurrency; i++) {
        workers.push(worker());
      }
    },

    stop() {
      stopped = true;
    },

    async getMetrics(): Promise<SchedulerMetrics> {
      const queueDepth = await queue.depth();
      const result: SchedulerMetrics = {
        queueDepth,
        activeWorkers,
        completedRunsCount,
      };
      if (durations.length > 0) {
        result.avgDurationMs =
          durations.reduce((a, b) => a + b, 0) / durations.length;
      }
      return result;
    },
  };
}
