import path from "node:path";
import type { RunStore } from "./run-store.js";
import type { RunQueue } from "./run-queue.js";
import type { AgentDefinition, PipelineRegistryEntry } from "./types.js";
import { createLogger } from "./log.js";
import { createRunScopedFileSink } from "./log.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";

export type SchedulerConfig = {
  store: RunStore;
  queue: RunQueue;
  registry: { get(id: string): Promise<PipelineRegistryEntry | null> };
  maxConcurrency: number;
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
  /** Named agent definitions (from ripline.config.json or profile). */
  agentDefinitions?: Record<string, AgentDefinition>;
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
    claudeCodeRunner,
    agentDefinitions,
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
        const storeWithRunDir = store as { runDir?: (id: string) => string };
        const runsDir =
          typeof storeWithRunDir.runDir === "function"
            ? path.dirname(storeWithRunDir.runDir(record.id))
            : undefined;
        const log =
          runsDir !== undefined
            ? createLogger({ sink: createRunScopedFileSink(runsDir) })
            : undefined;
        const runner = new DeterministicRunner(entry.definition, {
          store,
          queue,
          quiet: true,
          ...(log !== undefined && { log }),
          ...(agentRunner && { agentRunner }),
          ...(claudeCodeRunner && { claudeCodeRunner }),
          ...(agentDefinitions !== undefined && { agentDefinitions }),
        });
        await runner.run(
          record.cursor !== undefined
            ? { resumeRunId: record.id }
            : { startRunId: record.id }
        );
        completedRunsCount++;
        durations.push(Date.now() - startMs);

        const completedRecord = await store.load(record.id);
        const childFinished = completedRecord?.parentRunId && (completedRecord.status === "completed" || completedRecord.status === "errored");
        if (childFinished) {
          const parent = await store.load(completedRecord!.parentRunId!);
          if (parent?.status === "paused" && parent.childRunIds?.length) {
            const children = await Promise.all(
              parent.childRunIds.map((id) => store.load(id))
            );
            const allTerminal = children.every((r) => r?.status === "completed" || r?.status === "errored");
            if (allTerminal) {
              const parentEntry = await registry.get(parent.pipelineId);
              if (parentEntry) {
                const parentRunsDir =
                  typeof storeWithRunDir.runDir === "function"
                    ? path.dirname(storeWithRunDir.runDir(parent.id))
                    : undefined;
                const parentLog =
                  parentRunsDir !== undefined
                    ? createLogger({ sink: createRunScopedFileSink(parentRunsDir) })
                    : undefined;
                const parentRunner = new DeterministicRunner(parentEntry.definition, {
                  store,
                  queue,
                  quiet: true,
                  ...(parentLog !== undefined && { log: parentLog }),
                  ...(agentRunner && { agentRunner }),
                  ...(claudeCodeRunner && { claudeCodeRunner }),
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
        const failedRecord = await store.load(record.id);
        if (failedRecord?.parentRunId && failedRecord.status === "errored") {
          const parent = await store.load(failedRecord.parentRunId);
          if (parent?.status === "paused" && parent.childRunIds?.length) {
            const children = await Promise.all(
              parent.childRunIds.map((id) => store.load(id))
            );
            const allTerminal = children.every((r) => r?.status === "completed" || r?.status === "errored");
            if (allTerminal) {
              const storeWithRunDir = store as { runDir?: (id: string) => string };
              const parentEntry = await registry.get(parent.pipelineId);
              if (parentEntry) {
                const parentRunsDir =
                  typeof storeWithRunDir.runDir === "function"
                    ? path.dirname(storeWithRunDir.runDir(parent.id))
                    : undefined;
                const parentLog =
                  parentRunsDir !== undefined
                    ? createLogger({ sink: createRunScopedFileSink(parentRunsDir) })
                    : undefined;
                const parentRunner = new DeterministicRunner(parentEntry.definition, {
                  store,
                  queue,
                  quiet: true,
                  ...(parentLog !== undefined && { log: parentLog }),
                  ...(agentRunner && { agentRunner }),
                  ...(claudeCodeRunner && { claudeCodeRunner }),
                });
                try {
                  await parentRunner.run({ resumeRunId: parent.id });
                } catch (resumeErr) {
                  const resumeMsg = resumeErr instanceof Error ? resumeErr.message : String(resumeErr);
                  if (!resumeMsg.includes("not resumable")) throw resumeErr;
                }
              }
            }
          }
        }
      } finally {
        activeWorkers--;
      }
    }
  }

  const workers: Promise<void>[] = [];

  return {
    start() {
      stopped = false;
      // Reset any runs orphaned in "running" state by a previous crash before workers begin
      store.recoverStaleRuns().then((count) => {
        if (count > 0) {
          console.log(`[scheduler] recovered ${count} orphaned running run(s) → pending`);
        }
      }).catch(() => {});
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
