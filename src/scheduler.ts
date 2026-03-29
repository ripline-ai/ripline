import path from "node:path";
import type { RunStore } from "./run-store.js";
import type { RunQueue } from "./run-queue.js";
import type { AgentDefinition, SkillsRegistry, PipelineRegistryEntry, RetryPolicy, ErrorCategory, ContainerResourceLimits } from "./types.js";
import { createLogger } from "./log.js";
import { createRunScopedFileSink } from "./log.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import { EventBus } from "./event-bus.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";
import { runContainerBuild, type ContainerBuildConfig } from "./container-build-runner.js";
import { mapContainerBuildToRunStatus } from "./container-status-map.js";

export type SchedulerConfig = {
  store: RunStore;
  queue: RunQueue;
  registry: {
    get(id: string): Promise<PipelineRegistryEntry | null>;
    /** Optional: list all pipeline definitions (used for queue auto-discovery). */
    list?(): Promise<import("./types.js").PipelineDefinition[]>;
  };
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
  /** Container build configuration. When set, scheduler attempts container-based execution. */
  containerBuild?: ContainerBuildConfig;
  /** Per-queue resource limits for containers. Key = queue name. */
  queueResourceLimits?: Record<string, ContainerResourceLimits>;
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

/**
 * Compute exponential backoff delay for a retry attempt.
 */
function computeRetryBackoff(retryCount: number, backoffMs: number, backoffMultiplier: number): number {
  return backoffMs * Math.pow(backoffMultiplier, retryCount);
}

/**
 * Determine the error category of the most recent failing step in a run record.
 */
function getFailedStepErrorCategory(record: import("./types.js").PipelineRunRecord): ErrorCategory | undefined {
  // Walk steps in reverse to find the most recent errored step
  for (let i = record.steps.length - 1; i >= 0; i--) {
    const step = record.steps[i]!;
    if (step.status === "errored") {
      return step.errorCategory;
    }
  }
  return undefined;
}

/**
 * Attempt to automatically retry a failed run based on its pipeline's retry policy.
 * Returns true if the run was re-enqueued for retry, false otherwise.
 */
async function attemptAutoRetry(
  failedRecord: import("./types.js").PipelineRunRecord,
  registry: { get(id: string): Promise<PipelineRegistryEntry | null> },
  store: RunStore,
): Promise<boolean> {
  const bus = EventBus.getInstance();

  // Load the retry policy: prefer the run-level policy, fall back to pipeline definition
  let retryPolicy: RetryPolicy | undefined = failedRecord.retryPolicy;
  if (!retryPolicy) {
    const entry = await registry.get(failedRecord.pipelineId);
    retryPolicy = entry?.definition.retry;
  }
  if (!retryPolicy) return false;

  const errorCategory = getFailedStepErrorCategory(failedRecord);
  // Only retry if the error category is in the retryable set
  const isRetryable = errorCategory !== undefined &&
    retryPolicy.retryableCategories.includes(errorCategory);

  if (!isRetryable) return false;

  const currentRetryCount = failedRecord.retryCount ?? 0;

  if (currentRetryCount >= retryPolicy.maxAttempts) {
    // Retries exhausted
    bus.emitRunEvent({
      event: "run.retry-exhausted",
      runId: failedRecord.id,
      pipelineId: failedRecord.pipelineId,
      status: "errored",
      retryCount: currentRetryCount,
      timestamp: Date.now(),
    });
    return false;
  }

  // Compute backoff delay and wait
  const backoffDelay = computeRetryBackoff(currentRetryCount, retryPolicy.backoffMs, retryPolicy.backoffMultiplier);
  await new Promise((r) => setTimeout(r, backoffDelay));

  // Re-enqueue: increment retryCount, reset status to pending, preserve cursor
  const freshRecord = await store.load(failedRecord.id);
  if (!freshRecord) return false;

  freshRecord.retryCount = currentRetryCount + 1;
  freshRecord.retryPolicy = retryPolicy;
  freshRecord.status = "pending";
  delete freshRecord.error;
  await store.save(freshRecord);

  // Emit auto-retry event
  bus.emitRunEvent({
    event: "run.auto-retry",
    runId: freshRecord.id,
    pipelineId: freshRecord.pipelineId,
    status: "pending",
    retryCount: freshRecord.retryCount,
    backoffMs: backoffDelay,
    timestamp: Date.now(),
  });

  return true;
}

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
    containerBuild,
    queueResourceLimits,
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

        // --- Container-based execution attempt ---
        // Only attempt for top-level runs (no parentRunId) with no existing cursor (fresh runs).
        const bus = EventBus.getInstance();
        let containerHandled = false;
        if (containerBuild && !record.parentRunId && record.cursor === undefined) {
          // Merge per-queue resource limits into container build config
          const queueLimits = queueResourceLimits?.[queueName];
          const buildResult = await runContainerBuild(
            record.id,
            record.pipelineId,
            { inputs: record.inputs, pipelineId: record.pipelineId },
            {
              ...containerBuild,
              ...(log !== undefined && { logger: log }),
              ...(queueLimits !== undefined && { resourceLimits: queueLimits }),
              ...(runsDir !== undefined && { runsDir }),
            },
          );

          // Use the authoritative status mapping
          const mapping = mapContainerBuildToRunStatus(buildResult);

          if (buildResult.usedContainer) {
            containerHandled = true;

            // Emit container-started event
            bus.emitRunEvent({
              event: "run.container-started",
              runId: record.id,
              pipelineId: record.pipelineId,
              status: "running",
              timestamp: Date.now(),
            });

            // Persist container metadata on the run record
            const metaLoaded = await store.load(record.id);
            if (metaLoaded) {
              if (buildResult.containerResult?.logFile) {
                metaLoaded.containerLogFile = buildResult.containerResult.logFile;
              }
              if (buildResult.featureBranch) {
                metaLoaded.featureBranch = buildResult.featureBranch;
              }
              await store.save(metaLoaded);
            }

            // Apply the mapped status to the run record
            const loaded = await store.load(record.id);
            if (loaded) {
              // Preserve container metadata
              if (buildResult.containerResult?.logFile) {
                loaded.containerLogFile = buildResult.containerResult.logFile;
              }
              if (buildResult.featureBranch) {
                loaded.featureBranch = buildResult.featureBranch;
              }

              if (mapping.status === "completed") {
                await store.completeRun(loaded, {
                  containerExitCode: buildResult.containerResult?.exitCode,
                  promoteStatus: buildResult.promoteResult?.status,
                  mergeCommit: buildResult.promoteResult?.mergeCommit,
                  featureBranch: buildResult.featureBranch,
                });
              } else if (mapping.status === "merge-conflict") {
                loaded.status = "merge-conflict";
                loaded.error = mapping.error ?? mapping.summary;
                loaded.updatedAt = Date.now();
                await store.save(loaded);
              } else if (mapping.status === "errored") {
                await store.failRun(loaded, mapping.error ?? mapping.summary);
              }
            }

            // Emit appropriate completion/failure event
            if (mapping.status === "completed") {
              bus.emitRunEvent({
                event: "run.container-completed",
                runId: record.id,
                pipelineId: record.pipelineId,
                status: "completed",
                timestamp: Date.now(),
              });
            } else {
              bus.emitRunEvent({
                event: "run.container-failed",
                runId: record.id,
                pipelineId: record.pipelineId,
                status: mapping.status ?? "errored",
                timestamp: Date.now(),
              });
              activeWorkersPerQueue.set(queueName, Math.max(0, (activeWorkersPerQueue.get(queueName) ?? 1) - 1));
              continue;
            }
          } else {
            // Docker wasn't available — emit fallback event and fall through to direct execution
            bus.emitRunEvent({
              event: "run.container-fallback",
              runId: record.id,
              pipelineId: record.pipelineId,
              status: "running",
              timestamp: Date.now(),
            });
          }
        }

        if (!containerHandled) {
          // --- Direct on-host execution (original path / fallback) ---
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
        }
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

        // --- Automatic retry logic ---
        const failedRecord = await store.load(record.id);
        if (failedRecord && failedRecord.status === "errored") {
          const retried = await attemptAutoRetry(failedRecord, registry, store);
          if (retried) {
            // Run was re-enqueued; skip parent error propagation
            activeWorkersPerQueue.set(queueName, Math.max(0, (activeWorkersPerQueue.get(queueName) ?? 1) - 1));
            continue;
          }
        }
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
      // Default concurrency is 1 if not specified for safety.
      effectiveConcurrencies = new Map();
      effectiveConcurrencies.set("default", maxConcurrency > 0 ? maxConcurrency : 1);
      if (queueConcurrencies) {
        for (const [name, concurrency] of Object.entries(queueConcurrencies)) {
          effectiveConcurrencies.set(name, concurrency > 0 ? concurrency : 1);
        }
      }

      // Log resource limits per queue (if configured)
      if (queueResourceLimits) {
        for (const [qName, limits] of Object.entries(queueResourceLimits)) {
          const parts: string[] = [];
          if (limits.cpus) parts.push(`cpus=${limits.cpus}`);
          if (limits.memory) parts.push(`memory=${limits.memory}`);
          if (parts.length > 0) {
            console.log(`[scheduler] queue "${qName}" container limits: ${parts.join(", ")}`);
          }
        }
      }

      // Auto-discover named queues from the pipeline registry. Pipelines may
      // declare `queue: "build"` etc. — ensure each referenced queue has at
      // least one worker (default concurrency 1) even if not explicitly
      // configured, so jobs are never orphaned.
      const startWorkers = () => {
        for (const [queueName, concurrency] of effectiveConcurrencies) {
          console.log(`[scheduler] queue "${queueName}": ${concurrency} worker(s)`);
          for (let i = 0; i < concurrency; i++) {
            workers.push(worker(queueName));
          }
        }
      };

      if (typeof registry.list === "function") {
        registry.list().then((pipelines) => {
          for (const def of pipelines) {
            if (def.queue && !effectiveConcurrencies.has(def.queue)) {
              effectiveConcurrencies.set(def.queue, 1);
              console.log(`[scheduler] auto-discovered queue "${def.queue}" from pipeline "${def.id}" (concurrency: 1)`);
            }
          }
          startWorkers();
        }).catch(() => {
          // If listing fails, just start with the configured queues
          startWorkers();
        });
      } else {
        startWorkers();
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
