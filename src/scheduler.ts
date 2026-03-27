import path from "node:path";
import type { RunStore } from "./run-store.js";
import type { RunQueue } from "./run-queue.js";
import type { AgentDefinition, SkillsRegistry, PipelineRegistryEntry } from "./types.js";
import { createLogger } from "./log.js";
import { createRunScopedFileSink } from "./log.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";

export type SchedulerConfig = {
  store: RunStore;
  queue: RunQueue;
  registry: { get(id: string): Promise<PipelineRegistryEntry | null> };
  maxConcurrency: number;
  /** Per-queue concurrency overrides. Key = queue name, value = concurrency limit. */
  queueConcurrencies?: Record<string, number>;
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
  /** Named agent definitions (from ripline.config.json or profile). */
  agentDefinitions?: Record<string, AgentDefinition>;
  /** Skills registry for resolving agent skill shorthand names to MCP server configs. */
  skillsRegistry?: SkillsRegistry;
  /** Directory containing per-skill markdown files (e.g. ~/.ripline/skills/). */
  skillsDir?: string;
  /** Poll interval when queue is empty (ms). */
  pollIntervalMs?: number;
};

export type SchedulerMetrics = {
  queueDepth: number;
  activeWorkers: number;
  avgDurationMs?: number;
  completedRunsCount?: number;
};

export type QueueMetrics = {
  depth: number;
  activeWorkers: number;
  maxConcurrency: number;
  completedRunsCount: number;
  avgDurationMs?: number;
};

export type DetailedSchedulerMetrics = SchedulerMetrics & {
  queues: Record<string, QueueMetrics>;
};

export type Scheduler = {
  start(): void;
  stop(): void;
  getMetrics(): Promise<SchedulerMetrics>;
  getDetailedMetrics(): Promise<DetailedSchedulerMetrics>;
};

export function createScheduler(config: SchedulerConfig): Scheduler {
  const {
    store,
    queue,
    registry,
    maxConcurrency,
    queueConcurrencies,
    agentRunner,
    claudeCodeRunner,
    agentDefinitions,
    skillsRegistry,
    skillsDir,
    pollIntervalMs = 500,
  } = config;

  let stopped = false;
  // Per-queue metrics tracking
  const activeWorkersPerQueue: Map<string, number> = new Map();
  const durationsPerQueue: Map<string, number[]> = new Map();
  const completedRunsPerQueue: Map<string, number> = new Map();
  // Stored so getDetailedMetrics can read concurrency config
  let effectiveConcurrencies: Map<string, number> = new Map();

  async function worker(queueName: string): Promise<void> {
    while (!stopped) {
      const record = await queue.claimNext(queueName);
      if (!record) {
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        continue;
      }
      activeWorkersPerQueue.set(queueName, (activeWorkersPerQueue.get(queueName) ?? 0) + 1);
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
          ...(skillsRegistry !== undefined && { skillsRegistry }),
          ...(skillsDir !== undefined && { skillsDir }),
        });
        await runner.run(
          record.cursor !== undefined
            ? { resumeRunId: record.id }
            : { startRunId: record.id }
        );
        completedRunsPerQueue.set(queueName, (completedRunsPerQueue.get(queueName) ?? 0) + 1);
        if (!durationsPerQueue.has(queueName)) durationsPerQueue.set(queueName, []);
        durationsPerQueue.get(queueName)!.push(Date.now() - startMs);

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
                  ...(agentDefinitions !== undefined && { agentDefinitions }),
                  ...(skillsRegistry !== undefined && { skillsRegistry }),
                  ...(skillsDir !== undefined && { skillsDir }),
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
                  ...(agentDefinitions !== undefined && { agentDefinitions }),
                  ...(skillsRegistry !== undefined && { skillsRegistry }),
                  ...(skillsDir !== undefined && { skillsDir }),
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
        activeWorkersPerQueue.set(queueName, Math.max(0, (activeWorkersPerQueue.get(queueName) ?? 1) - 1));
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

      // Build the effective per-queue concurrency map.
      // maxConcurrency sets concurrency for the "default" queue (backwards compat).
      // queueConcurrencies allows overriding per named queue.
      effectiveConcurrencies = new Map();
      effectiveConcurrencies.set("default", maxConcurrency);
      if (queueConcurrencies) {
        for (const [name, concurrency] of Object.entries(queueConcurrencies)) {
          effectiveConcurrencies.set(name, concurrency);
        }
      }

      for (const [queueName, concurrency] of effectiveConcurrencies) {
        console.log(`[scheduler] queue "${queueName}": ${concurrency} worker(s)`);
        for (let i = 0; i < concurrency; i++) {
          workers.push(worker(queueName));
        }
      }
    },

    stop() {
      stopped = true;
    },

    async getMetrics(): Promise<SchedulerMetrics> {
      const queueDepth = await queue.depth();
      // Aggregate from per-queue maps for backward compatibility
      let totalActiveWorkers = 0;
      for (const count of activeWorkersPerQueue.values()) totalActiveWorkers += count;
      let totalCompleted = 0;
      for (const count of completedRunsPerQueue.values()) totalCompleted += count;
      const allDurations: number[] = [];
      for (const d of durationsPerQueue.values()) allDurations.push(...d);

      const result: SchedulerMetrics = {
        queueDepth,
        activeWorkers: totalActiveWorkers,
        completedRunsCount: totalCompleted,
      };
      if (allDurations.length > 0) {
        result.avgDurationMs =
          allDurations.reduce((a, b) => a + b, 0) / allDurations.length;
      }
      return result;
    },

    async getDetailedMetrics(): Promise<DetailedSchedulerMetrics> {
      const base = await this.getMetrics();
      const depthMap = await queue.depthByQueue();
      const queues: Record<string, QueueMetrics> = {};

      // Build entries for every known queue (from concurrency config + any queue with depth)
      const allQueueNames = new Set<string>();
      for (const name of effectiveConcurrencies.keys()) allQueueNames.add(name);
      for (const name of depthMap.keys()) allQueueNames.add(name);
      for (const name of activeWorkersPerQueue.keys()) allQueueNames.add(name);
      for (const name of completedRunsPerQueue.keys()) allQueueNames.add(name);

      for (const name of allQueueNames) {
        const qDurations = durationsPerQueue.get(name) ?? [];
        const completed = completedRunsPerQueue.get(name) ?? 0;
        const qm: QueueMetrics = {
          depth: depthMap.get(name) ?? 0,
          activeWorkers: activeWorkersPerQueue.get(name) ?? 0,
          maxConcurrency: effectiveConcurrencies.get(name) ?? 0,
          completedRunsCount: completed,
        };
        if (qDurations.length > 0) {
          qm.avgDurationMs = qDurations.reduce((a, b) => a + b, 0) / qDurations.length;
        }
        queues[name] = qm;
      }

      return { ...base, queues };
    },
  };
}
