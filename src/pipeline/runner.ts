import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import path from "node:path";
import fs from "node:fs/promises";
import type {
  AgentDefinition,
  SkillsRegistry,
  PipelineDefinition,
  PipelineEdge,
  PipelineNode,
  PipelineRunRecord,
  PipelineRunStep,
} from "../types.js";
import type { RunStore } from "../run-store.js";
import { PipelineRunStore } from "../run-store.js";
import type { RunQueue } from "../run-queue.js";
import type { Logger } from "../log.js";
import { validateOutputContract } from "../lib/contract-validate.js";
import { EventBus } from "../event-bus.js";
import type { RunEvent } from "../event-bus.js";
import { executeNode } from "./executors/index.js";
import type { AgentRunner } from "./executors/index.js";
import { ActivityEmitter } from "../activity-emitter.js";
import type { ActivityEvent } from "../types/activity.js";
import type { EventSink } from "../interfaces/event-sink.js";
import { resolveConfig } from "../config.js";
import { evaluateExpression } from "../expression.js";
import { HttpResponseError, computeBackoffMs } from "../lib/http-response-guard.js";
import { classifyError } from "./error-classifier.js";
import type { RunContainerPool } from "../run-container-pool.js";
import {
  normalizeContainerConfig,
  DEFAULT_BUILD_IMAGE,
} from "../run-container-pool.js";

export type RunContext = {
  inputs: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  env: Record<string, string>;
  outputs: Record<string, unknown>;
  outPath?: string;
  /** Run-level session ID for agent nodes with resetSession: false (shared conversation). */
  sessionId?: string;
};

export type NodeRunContext = {
  inputs: Record<string, unknown>;
  artifacts: Record<string, unknown>;
  env: Record<string, string>;
};

export type RunnerOptions = {
  runsDir?: string;
  /** Optional RunStore; defaults to file-based PipelineRunStore in runsDir. */
  store?: RunStore;
  /** Optional queue for enqueue node (required when pipeline may enqueue child runs). */
  queue?: RunQueue;
  verbose?: boolean;
  /** When true, do not log node.started/completed/errored to console (caller handles logging). */
  quiet?: boolean;
  /** Required for agent nodes unless node uses runner: claude-code (then claudeCodeRunner required). */
  agentRunner?: AgentRunner;
  /** For agent nodes with runner: claude-code. Not set when an external agent runner is used. */
  claudeCodeRunner?: AgentRunner;
  /** For agent nodes with runner: codex. Not set when an external agent runner is used. */
  codexRunner?: AgentRunner;
  /** Global named agent definitions. Merged with pipeline-level agents (pipeline wins). */
  agentDefinitions?: Record<string, AgentDefinition>;
  /** Skills registry for resolving agent skill shorthand names to MCP server configs. */
  skillsRegistry?: SkillsRegistry;
  /** Directory containing per-skill markdown files (e.g. ~/.ripline/skills/). */
  skillsDir?: string;
  /** If set, write final outputs to this path as JSON. */
  outPath?: string;
  /** Optional run-scoped logger; when set, a child logger (runId/nodeId) is passed to executors for log capture. */
  log?: Logger;
  /**
   * Run-level container pool.  When provided and the pipeline definition has a `container`
   * field, the runner will acquire a persistent container before executing nodes and release
   * it when the run completes or errors.
   */
  containerPool?: RunContainerPool;
  /**
   * Default Docker image for container nodes that don't specify one (from containerBuild.buildImage).
   */
  defaultContainerImage?: string;
  /** EventSink for activity events. Defaults to NoopEventSink when not provided. */
  eventSink?: EventSink;
};

export type NodeStartedEvent = { nodeId: string; nodeType: string; at: number };
export type NodeCompletedEvent = {
  nodeId: string;
  nodeType: string;
  at: number;
  artifactSummary?: string;
};
export type NodeErroredEvent = {
  nodeId: string;
  nodeType: string;
  at: number;
  error: string;
};

const DEFAULT_RUNS_DIR = ".ripline/runs";

export class DeterministicRunner extends EventEmitter {
  private readonly store: RunStore;
  private readonly nodeById: Map<string, PipelineNode>;
  private readonly runnerOptions: RunnerOptions;
  private readonly activityEmitter: ActivityEmitter;

  constructor(
    private readonly definition: PipelineDefinition,
    options: RunnerOptions = {}
  ) {
    super();
    this.runnerOptions = options;
    const runsDir = path.resolve(options.runsDir ?? DEFAULT_RUNS_DIR);
    this.store = options.store ?? new PipelineRunStore(runsDir);
    this.nodeById = new Map(definition.nodes.map((n) => [n.id, n]));
    this.activityEmitter = new ActivityEmitter(options.eventSink);
  }

  /** Build and fire-and-forget an activity event via the configured EventSink. */
  private emitActivityEvent(
    runId: string,
    nodeId: string,
    nodeName: string | undefined,
    action: string,
    status: ActivityEvent["status"],
    summary: string,
    extra?: { durationMs?: number; error?: string },
  ): void {
    const event: ActivityEvent = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      source: "ripline",
      sourceId: runId,
      project: this.definition.name ?? this.definition.id,
      action,
      status,
      summary,
      ...(extra?.durationMs !== undefined && { details: `duration_ms=${extra.durationMs}` }),
      ...(extra?.error !== undefined && { details: extra.error }),
    };
    this.activityEmitter.emit(event);
  }

  /**
   * Build adjacency (from -> [to]) and indegree maps, then Kahn-style sort from entry.
   * Throws if any edge references a missing node or if graph has a cycle / unreachable nodes.
   */
  getExecutionOrder(): string[] {
    const nodeIds = new Set(this.definition.nodes.map((n) => n.id));

    for (const edge of this.definition.edges) {
      if (!nodeIds.has(edge.from.node)) {
        throw new Error(`Edge references missing node: ${edge.from.node}`);
      }
      if (!nodeIds.has(edge.to.node)) {
        throw new Error(`Edge references missing node: ${edge.to.node}`);
      }
    }

    const adjacency = new Map<string, string[]>();
    const indegree = new Map<string, number>();

    for (const node of this.definition.nodes) {
      adjacency.set(node.id, []);
      indegree.set(node.id, 0);
    }

    for (const edge of this.definition.edges) {
      const from = edge.from.node;
      const to = edge.to.node;
      adjacency.get(from)?.push(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }

    const entrySet = new Set(this.definition.entry);
    for (const e of entrySet) {
      indegree.set(e, 0);
    }

    const queue = [...this.definition.entry];
    const order: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const next of adjacency.get(current) ?? []) {
        const d = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, d);
        if (d === 0) {
          queue.push(next);
        }
      }
    }

    if (order.length < this.definition.nodes.length) {
      const missing = this.definition.nodes.filter((n) => !order.includes(n.id));
      const ids = missing.map((n) => n.id).join(", ");
      throw new Error(
        `Pipeline has a cycle or unreachable nodes. Not reached: ${ids}`
      );
    }

    return order;
  }

  async run(options: {
    inputs?: Record<string, unknown>;
    resumeRunId?: string;
    /** Execute an existing pending run (e.g. claimed from queue). Run must be pending and pipelineId must match. */
    startRunId?: string;
    /** Env key=value overrides merged into context.env (after process.env). */
    env?: Record<string, string>;
  }): Promise<PipelineRunRecord> {
    const order = this.getExecutionOrder();

    if ("init" in this.store && typeof this.store.init === "function") {
      await (this.store as { init(): Promise<void> }).init();
    }

    // Inject stage-aware URL so pipeline templates can reference {{env.RIPLINE_URL}}
    // without hardcoding localhost ports.
    // Caller-supplied env values always win (e.g. for tests or manual overrides).
    const { riplineUrl } = resolveConfig();
    const stageEnv: Record<string, string> = {
      RIPLINE_URL: riplineUrl,
    };

    let record: PipelineRunRecord;
    let context: RunContext;
    let startIndex: number;

    if (options.startRunId) {
      const loaded = await this.store.load(options.startRunId);
      if (!loaded) throw new Error(`Run not found: ${options.startRunId}`);
      if (loaded.pipelineId !== this.definition.id) {
        throw new Error(`Run pipeline ${loaded.pipelineId} does not match definition ${this.definition.id}`);
      }
      if (loaded.status !== "pending" && loaded.status !== "running") {
        throw new Error(`Run ${options.startRunId} is not startable (status: ${loaded.status})`);
      }
      record = loaded;
      const steps: PipelineRunStep[] = order.map((nodeId) => ({ nodeId, status: "pending" }));
      record.steps = steps;
      record.status = "running";
      record.ownerPid = process.pid;
      const baseEnv = { ...process.env, ...stageEnv, ...options.env } as Record<string, string>;
      context = {
        inputs: record.inputs,
        artifacts: {},
        env: baseEnv,
        outputs: {},
        sessionId: randomUUID(),
        ...(this.runnerOptions.outPath !== undefined && { outPath: this.runnerOptions.outPath }),
      };
      await this.store.save(record);
      startIndex = 0;
      this.emit("run.started", record);
      this.emitBusEvent("run.started", record);
    } else if (options.resumeRunId) {
      const loaded = await this.store.load(options.resumeRunId);
      if (!loaded) throw new Error(`Run not found: ${options.resumeRunId}`);
      if (loaded.pipelineId !== this.definition.id) {
        throw new Error(`Run pipeline ${loaded.pipelineId} does not match definition ${this.definition.id}`);
      }
      if (!["errored", "paused", "pending", "running"].includes(loaded.status)) {
        throw new Error(`Run ${options.resumeRunId} is not resumable (status: ${loaded.status})`);
      }
      record = loaded;
      const cursor = record.cursor ?? { nextNodeIndex: 0, context: {} };
      startIndex = cursor.nextNodeIndex;
      const ctx = (cursor.context || {}) as {
        inputs?: Record<string, unknown>;
        artifacts?: Record<string, unknown>;
        outputs?: Record<string, unknown>;
        sessionId?: string;
      };
      const baseEnv = { ...process.env, ...stageEnv, ...options.env } as Record<string, string>;
      context = {
        inputs: ctx.inputs ?? record.inputs,
        artifacts: { ...ctx.artifacts },
        env: baseEnv,
        outputs: { ...(ctx.outputs ?? record.outputs ?? {}) },
        ...(ctx.sessionId !== undefined && { sessionId: ctx.sessionId }),
        ...(this.runnerOptions.outPath !== undefined && { outPath: this.runnerOptions.outPath }),
      };
      for (let k = 0; k < startIndex; k++) {
        const s = record.steps[k];
        if (s?.status === "completed" && s.data && typeof s.data === "object" && "artifactKey" in s.data && "artifactValue" in s.data) {
          const d = s.data as { artifactKey: string; artifactValue: unknown };
          context.artifacts[d.artifactKey] = d.artifactValue;
        }
      }
      record.status = "running";
      record.ownerPid = process.pid;
      delete record.error;
      await this.store.save(record);
      this.emit("run.started", record);
      this.emitBusEvent("run.started", record);
    } else {
      record = await this.store.createRun({
        pipelineId: this.definition.id,
        inputs: options.inputs ?? {},
      });
      const baseEnv = { ...process.env, ...stageEnv, ...options.env } as Record<string, string>;
      context = {
        inputs: record.inputs,
        artifacts: {},
        env: baseEnv,
        outputs: {},
        sessionId: randomUUID(),
        ...(this.runnerOptions.outPath !== undefined && { outPath: this.runnerOptions.outPath }),
      };
      const steps: PipelineRunStep[] = order.map((nodeId) => ({ nodeId, status: "pending" }));
      record.steps = steps;
      record.status = "running";
      await this.store.save(record);
      startIndex = 0;
      this.emit("run.started", record);
      this.emitBusEvent("run.started", record);
    }

    // Flush any buffered activity events from previous runs (fire-and-forget).
    this.activityEmitter.flushBuffer().catch(() => {});

    // --- Run-level container lifecycle ---
    // When the pipeline definition has a `container` field AND a containerPool is provided,
    // acquire a persistent container before executing nodes so steps can share the filesystem.
    // The container is released in a finally block below.
    if (
      this.definition.container &&
      this.runnerOptions.containerPool &&
      record.id
    ) {
      try {
        const containerDef = this.definition.container;
        const normalized = normalizeContainerConfig(containerDef, {
          image: this.runnerOptions.defaultContainerImage ?? DEFAULT_BUILD_IMAGE,
        });
        const runsDir = path.resolve(this.runnerOptions.runsDir ?? DEFAULT_RUNS_DIR);
        const logFile = path.join(runsDir, record.id, "container.log");
        const acquireOpts: import("../run-container-pool.js").PoolContainerOptions = {
          image: normalized.image ?? DEFAULT_BUILD_IMAGE,
          logFile,
        };
        if (normalized.env !== undefined) acquireOpts.env = normalized.env;

        // Create a per-run workspace directory on the host and inject it as the
        // /workspace volume mount.  The container image's /workspace is owned by the
        // image-internal builder user, which does not match the host UID that the
        // container runs as (--user hostUid:hostGid).  Without this override, any
        // step that tries to write to /workspace (e.g. git clone → /workspace/repo)
        // fails with "Permission denied" and silently leaves /workspace empty,
        // causing later steps that specify cwd=/workspace/repo to crash with
        // "chdir failed: no such file or directory" during docker exec.
        const hostWorkspaceDir = path.join(runsDir, record.id, "workspace");
        await fs.mkdir(hostWorkspaceDir, { recursive: true });
        acquireOpts.volumes = {
          ...(normalized.volumes ?? {}),
          [hostWorkspaceDir]: "/workspace",
        };

        if (normalized.workdir !== undefined) acquireOpts.workdir = normalized.workdir;
        if (normalized.resourceLimits !== undefined) acquireOpts.resourceLimits = normalized.resourceLimits;
        await this.runnerOptions.containerPool.acquire(record.id, acquireOpts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.runnerOptions.containerPool.release(record.id);
        await this.store.failRun(record, `Failed to start run-level container: ${msg}`);
        this.emitBusEvent("run.errored", record);
        throw err;
      }
    }

    const steps = record.steps;
    const skippedNodes = new Set<string>();
    /** Nodes activated via on_error edge routing (execute even if only on_error edges point to them). */
    const errorActivatedNodes = new Set<string>();

    try {
    for (let i = startIndex; i < order.length; i++) {
      const nodeId = order[i]!;
      const node = this.nodeById.get(nodeId)!;
      const step = steps[i]!;
      const startedAt = Date.now();

      if (step.status === "completed" || step.status === "skipped") {
        if (step.status === "skipped") skippedNodes.add(nodeId);
        continue;
      }

      // Evaluate `when` conditions on incoming edges; skip if none are truthy.
      if (!this.shouldExecuteNode(nodeId, context, skippedNodes, errorActivatedNodes)) {
        step.status = "skipped";
        step.startedAt = startedAt;
        step.finishedAt = startedAt;
        skippedNodes.add(nodeId);
        record.updatedAt = Date.now();
        await this.store.save(record);
        if (!this.runnerOptions.quiet) {
          console.log(`[${new Date(startedAt).toISOString()}] node.skipped ${nodeId} (${node.type}) — when condition not met`);
        }
        continue;
      }

      step.status = "running";
      step.startedAt = startedAt;
      record.updatedAt = Date.now();
      await this.store.save(record);

      const startedEvent = { nodeId, nodeType: node.type, at: startedAt } as NodeStartedEvent;
      this.emit("node.started", startedEvent);
      this.emitBusEvent("node.started", record, nodeId);
      this.emitActivityEvent(
        record.id, nodeId, node.name, "node_start", "started",
        `Node ${node.name ?? nodeId} (${node.type}) started`,
      );
      if (!this.runnerOptions.quiet) {
        console.log(`[${new Date(startedAt).toISOString()}] node.started ${nodeId} (${node.type})`);
      }

      if (node.type === "checkpoint") {
        const checkpointNode = node as import("../types.js").CheckpointNode;
        record.waitFor = {
          nodeId,
          ...(checkpointNode.reason !== undefined && { reason: checkpointNode.reason }),
          ...(checkpointNode.resumeKey !== undefined && { resumeKey: checkpointNode.resumeKey }),
        };
        record.status = "paused";
        step.status = "paused";
        step.finishedAt = Date.now();
        await this.store.updateCursor(record, {
          nextNodeIndex: i + 1,
          context: {
            inputs: context.inputs,
            artifacts: context.artifacts,
            outputs: context.outputs,
            ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
          },
        });
        record.updatedAt = Date.now();
        await this.store.save(record);
        return record;
      }

      // AC2: Rate-limit (429) and server errors (5xx) get automatic retry with
      // exponential backoff, even if the node has no explicit retry config.
      // Default: 3 attempts for retryable HTTP errors, 1 for everything else.
      const HTTP_RETRY_DEFAULT = 3;
      const configuredMax = node.retry?.maxAttempts ?? 1;
      const retryDelayMs = node.retry?.delayMs ?? 0;
      let lastErr: unknown;
      let nodeResult: Awaited<ReturnType<typeof executeNode>> = null;
      // Effective max attempts can grow if we hit a retryable HTTP error
      let effectiveMaxAttempts = configuredMax;

      for (let attempt = 1; attempt <= effectiveMaxAttempts; attempt++) {
        try {
          const executorContext = this.getExecutorContext(node, context, record);
          const execOptions: { agentRunner?: AgentRunner; claudeCodeRunner?: AgentRunner; codexRunner?: AgentRunner; agentDefinitions?: Record<string, AgentDefinition>; skillsRegistry?: SkillsRegistry; skillsDir?: string } = {};
          if (this.runnerOptions.agentRunner !== undefined) execOptions.agentRunner = this.runnerOptions.agentRunner;
          if (this.runnerOptions.claudeCodeRunner !== undefined) execOptions.claudeCodeRunner = this.runnerOptions.claudeCodeRunner;
          if (this.runnerOptions.codexRunner !== undefined) execOptions.codexRunner = this.runnerOptions.codexRunner;
          if (this.runnerOptions.agentDefinitions !== undefined) execOptions.agentDefinitions = this.runnerOptions.agentDefinitions;
          if (this.runnerOptions.skillsRegistry !== undefined) execOptions.skillsRegistry = this.runnerOptions.skillsRegistry;
          if (this.runnerOptions.skillsDir !== undefined) execOptions.skillsDir = this.runnerOptions.skillsDir;
          nodeResult = await executeNode(
              node,
              executorContext,
              Object.keys(execOptions).length > 0 ? execOptions : undefined
            );
          if (nodeResult && node.contracts?.output) {
            validateOutputContract(
              node.id,
              node.type,
              node.contracts.output,
              nodeResult.value
            );
          }
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;

          // AC2: For retryable HTTP errors (429, 5xx), use exponential backoff
          // and ensure at least HTTP_RETRY_DEFAULT attempts even if node.retry
          // is not configured.
          if (err instanceof HttpResponseError && err.retryable) {
            effectiveMaxAttempts = Math.max(effectiveMaxAttempts, HTTP_RETRY_DEFAULT);
            if (attempt < effectiveMaxAttempts) {
              const backoffMs = computeBackoffMs(attempt, err.retryAfterSeconds);
              console.warn(
                `[runner] Retryable HTTP ${err.statusCode} on node "${node.id}" ` +
                `(attempt ${attempt}/${effectiveMaxAttempts}), backoff ${backoffMs}ms` +
                (record ? ` [run=${record.id}]` : "")
              );
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
          }

          // Non-HTTP error or non-retryable HTTP error: use configured delay
          if (attempt < effectiveMaxAttempts && retryDelayMs > 0) {
            await new Promise((r) => setTimeout(r, retryDelayMs));
          }
        }
      }

      if (lastErr === undefined) {
        if (nodeResult) {
          step.data = {
            artifactKey: nodeResult.artifactKey,
            artifactSize: this.artifactSize(nodeResult.value),
            artifactValue: nodeResult.value,
          };
          if (nodeResult.childRunIds?.length) {
            record.childRunIds = [...(record.childRunIds ?? []), ...nodeResult.childRunIds];
            record.waitFor = {
              nodeId,
              reason: "children",
            };
            record.status = "paused";
            // When rerunOnResume is set, re-execute this same node on resume
            // (used by multi-wave parallel loops to process the next wave).
            const rerun = !!nodeResult.rerunOnResume;
            step.status = rerun ? "pending" : "completed";
            if (!rerun) step.finishedAt = Date.now();
            const nextIndex = rerun ? i : i + 1;
            await this.store.updateCursor(record, {
              nextNodeIndex: nextIndex,
              context: {
                inputs: context.inputs,
                artifacts: context.artifacts,
                outputs: context.outputs,
                ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
              },
            });
            record.updatedAt = Date.now();
            await this.store.save(record);
            this.emit("node.completed", {
              nodeId,
              nodeType: node.type,
              at: step.finishedAt,
              artifactSummary: `${nodeResult.childRunIds.length} child run(s) enqueued`,
            } as NodeCompletedEvent);
            this.emitBusEvent("node.completed", record, nodeId);
            this.emitActivityEvent(
              record.id, nodeId, node.name, "node_complete", "success",
              `Node ${node.name ?? nodeId} (${node.type}) completed — ${nodeResult.childRunIds.length} child run(s) enqueued`,
              { durationMs: step.finishedAt! - startedAt },
            );
            if (!this.runnerOptions.quiet) {
              console.log(
                `[${new Date(step.finishedAt!).toISOString()}] node.completed ${nodeId} (${node.type}) ${nodeResult.childRunIds.length} child run(s) enqueued; paused until complete`
              );
            }
            return record;
          }
        }
        const finishedAt = Date.now();
        step.status = "completed";
        step.finishedAt = finishedAt;

        const stepData = step.data as { artifactKey?: string; artifactSize?: number } | undefined;
        const artifactSummary = this.summarizeArtifacts(context.artifacts, stepData);
        const completedEvent = {
          nodeId,
          nodeType: node.type,
          at: finishedAt,
          artifactSummary,
        } as NodeCompletedEvent;
        this.emit("node.completed", completedEvent);
        this.emitBusEvent("node.completed", record, nodeId);
        this.emitActivityEvent(
          record.id, nodeId, node.name, "node_complete", "success",
          `Node ${node.name ?? nodeId} (${node.type}) completed`,
          { durationMs: finishedAt - startedAt },
        );
        if (!this.runnerOptions.quiet) {
          const summary = artifactSummary ? ` ${artifactSummary}` : "";
          console.log(`[${new Date(finishedAt).toISOString()}] node.completed ${nodeId} (${node.type})${summary}`);
        }
      } else {
        const err = lastErr;
        const finishedAt = Date.now();
        step.status = "errored";
        step.finishedAt = finishedAt;
        step.error = err instanceof Error ? err.message : String(err);
        step.errorCategory = classifyError(err);

        // Check for outgoing on_error edge from this node.
        const onErrorEdge = this.definition.edges.find(
          (e) => e.from.node === nodeId && e.on_error === true,
        );

        if (onErrorEdge) {
          // Error edge routing: store error details in artifacts and continue
          // execution to the error edge target instead of failing the run.
          context.artifacts.__error = {
            message: err instanceof Error ? err.message : String(err),
            nodeId,
            stack: err instanceof Error ? err.stack : undefined,
          };
          errorActivatedNodes.add(onErrorEdge.to.node);

          const erroredEvent = {
            nodeId,
            nodeType: node.type,
            at: finishedAt,
            error: step.error,
          } as NodeErroredEvent;
          this.emit("node.errored", erroredEvent);
          this.emitBusEvent("node.errored", record, nodeId);
          this.emitActivityEvent(
            record.id, nodeId, node.name, "node_error", "error",
            `Node ${node.name ?? nodeId} (${node.type}) errored — routing to ${onErrorEdge.to.node}`,
            { error: step.error },
          );
          if (!this.runnerOptions.quiet) {
            console.error(`[${new Date(finishedAt).toISOString()}] node.errored ${nodeId} (${node.type}) ${step.error} — on_error → ${onErrorEdge.to.node}`);
          }
          // Continue execution; do NOT throw or fail the run.
        } else {
          // No on_error edge: preserve original fail-fast behavior.
          await this.store.updateCursor(record, {
            nextNodeIndex: i,
            context: {
              inputs: context.inputs,
              artifacts: context.artifacts,
              outputs: context.outputs,
              ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
            },
          });
          await this.store.failRun(record, step.error);
          const erroredEvent = {
            nodeId,
            nodeType: node.type,
            at: finishedAt,
            error: step.error,
          } as NodeErroredEvent;
          this.emit("node.errored", erroredEvent);
          this.emitBusEvent("node.errored", record, nodeId);
          this.emitBusEvent("run.errored", record);
          this.emitActivityEvent(
            record.id, nodeId, node.name, "node_error", "error",
            `Node ${node.name ?? nodeId} (${node.type}) errored`,
            { error: step.error },
          );
          if (!this.runnerOptions.quiet) {
            console.error(`[${new Date(finishedAt).toISOString()}] node.errored ${nodeId} (${node.type}) ${step.error}`);
          }
          throw err;
        }
      }

      record.updatedAt = Date.now();
      await this.store.save(record);
    }

    delete record.cursor;
    delete record.ownerPid;
    await this.store.completeRun(record, context.outputs);
    this.emitBusEvent("run.completed", record);

    if (context.outPath) {
      await fs.mkdir(path.dirname(context.outPath), { recursive: true });
      await fs.writeFile(context.outPath, JSON.stringify(context.outputs, null, 2), "utf8");
    }

    return record;
    } finally {
      // Release run-level container if one was acquired
      if (this.definition.container && this.runnerOptions.containerPool && record?.id) {
        this.runnerOptions.containerPool.release(record.id);
      }
    }
  }

  private getExecutorContext(
    node: PipelineNode,
    context: RunContext,
    record?: PipelineRunRecord
  ): import("./executors/types.js").ExecutorContext {
    const base = this.getNodeContext(node, context);
    return {
      ...base,
      outputs: context.outputs,
      ...(context.outPath !== undefined && { outPath: context.outPath }),
      ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
      ...(record && {
        runId: record.id,
        store: this.store,
        queue: this.runnerOptions.queue,
        ...(this.runnerOptions.log && {
          log: this.runnerOptions.log.child({ runId: record.id, nodeId: node.id }),
        }),
        ...(this.runnerOptions.containerPool !== undefined && {
          containerPool: this.runnerOptions.containerPool,
        }),
        ...(this.runnerOptions.defaultContainerImage !== undefined && {
          defaultContainerImage: this.runnerOptions.defaultContainerImage,
        }),
      }),
    };
  }

  private getNodeContext(node: PipelineNode, context: RunContext): NodeRunContext {
    const requested = node.contracts?.input;
    if (!requested || typeof requested !== "object") {
      return { inputs: context.inputs, artifacts: context.artifacts, env: context.env };
    }
    const artifacts =
      typeof requested.properties === "object"
        ? Object.fromEntries(
            Object.keys(requested.properties).filter((k) => k in context.artifacts).map((k) => [k, context.artifacts[k]])
          )
        : context.artifacts;
    return { inputs: context.inputs, artifacts, env: context.env };
  }

  private emitBusEvent(
    event: RunEvent["event"],
    record: PipelineRunRecord,
    nodeId?: string
  ): void {
    const busEvent: RunEvent = {
      event,
      runId: record.id,
      pipelineId: record.pipelineId,
      status: record.status,
      timestamp: Date.now(),
      ...(nodeId !== undefined && { nodeId }),
    };
    EventBus.getInstance().emitRunEvent(busEvent);
  }

  /**
   * Evaluate whether a node should be executed based on `when` conditions and
   * port-based routing on its incoming edges.  Rules:
   *   - Edges whose source node was skipped are ignored (treated as non-existent).
   *   - Port-based routing: if an edge has a `from.port` and the source node is
   *     a switch node, the edge is only active when the source node's __activePort
   *     artifact matches the edge's from.port.  Inactive port edges are filtered out.
   *   - If NO incoming edge has a `when` clause, the node is reachable (return true).
   *   - If at least one incoming edge has a truthy `when`, the node is reachable.
   *   - If ALL incoming edges carry `when` clauses and none are truthy, skip (return false).
   */
  private shouldExecuteNode(
    nodeId: string,
    context: RunContext,
    skippedNodes: Set<string>,
    errorActivatedNodes?: Set<string>,
  ): boolean {
    // If this node was explicitly activated via an on_error edge, execute it.
    if (errorActivatedNodes?.has(nodeId)) return true;

    // Start with edges from non-skipped sources, excluding on_error edges
    // (those only fire when explicitly activated above).
    let incomingEdges: PipelineEdge[] = this.definition.edges.filter(
      (e) => e.to.node === nodeId && !skippedNodes.has(e.from.node) && !e.on_error,
    );

    // Port-based routing: filter out edges from switch nodes where the port
    // does not match the switch's __activePort artifact.
    incomingEdges = incomingEdges.filter((edge) => {
      if (!edge.from.port) return true; // No port — always active.
      const sourceNode = this.nodeById.get(edge.from.node);
      if (!sourceNode || sourceNode.type !== "switch") return true; // Non-switch — pass through.
      const artifact = context.artifacts[edge.from.node];
      if (artifact && typeof artifact === "object" && "__activePort" in artifact) {
        return (artifact as { __activePort: string }).__activePort === edge.from.port;
      }
      return false; // Switch has no artifact yet — edge inactive.
    });

    // No incoming edges (entry node or all filtered out) — check if the node
    // has *any* defined incoming edges at all; if none, it's an entry node.
    if (incomingEdges.length === 0) {
      // If there were edges before filtering but none survived, the node should
      // only execute if it also has at least one non-port-based active edge.
      const allEdgesToNode = this.definition.edges.filter(
        (e) => e.to.node === nodeId && !e.on_error,
      );
      // True entry node (no incoming edges defined at all) — always execute.
      if (allEdgesToNode.length === 0) return true;
      // All incoming edges were filtered out (skipped sources + inactive ports) — skip.
      return false;
    }

    const conditionalEdges = incomingEdges.filter(
      (e) => !e.default && e.when != null && e.when.trim() !== "",
    );
    const unconditionalEdges = incomingEdges.filter(
      (e) => !e.default && (e.when == null || e.when.trim() === ""),
    );
    const defaultEdges = incomingEdges.filter((e) => e.default === true);

    // If there are any unconditional edges from non-skipped sources, always execute.
    if (unconditionalEdges.length > 0) return true;
    // No conditional or default edges at all — always execute.
    if (conditionalEdges.length === 0 && defaultEdges.length === 0) return true;

    const evalContext: Record<string, unknown> = {
      inputs: context.inputs,
      artifacts: context.artifacts,
      env: context.env,
      ...context.artifacts,
    };

    for (const edge of conditionalEdges) {
      try {
        const result = evaluateExpression(edge.when!, evalContext);
        if (result) return true;
      } catch {
        // Expression error → treat as falsy.
      }
    }

    // Default edge fallback: a default edge fires when ALL sibling when-conditional
    // edges from the same source node evaluate to false.
    for (const defEdge of defaultEdges) {
      const sourceId = defEdge.from.node;
      // Gather all when-conditional sibling edges from the same source (not just
      // those targeting this node).
      const siblingConditionals = this.definition.edges.filter(
        (e) =>
          e.from.node === sourceId &&
          !e.default &&
          e.when != null &&
          e.when.trim() !== "",
      );
      const anyTrue = siblingConditionals.some((e) => {
        try {
          return !!evaluateExpression(e.when!, evalContext);
        } catch {
          return false;
        }
      });
      if (!anyTrue) return true; // Default edge fires.
    }

    return false;
  }

  private artifactSize(value: unknown): number {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 0;
    }
  }

  private summarizeArtifacts(
    artifacts: Record<string, unknown>,
    stepData?: { artifactKey?: string; artifactSize?: number }
  ): string {
    const parts: string[] = [];
    if (stepData?.artifactKey != null) {
      parts.push(`${stepData.artifactKey}:${stepData.artifactSize ?? 0}B`);
    }
    const keys = Object.keys(artifacts);
    if (keys.length > 0) {
      parts.push(keys.map((k) => `${k}:${typeof artifacts[k]}`).join(", "));
    }
    return parts.filter(Boolean).join("; ");
  }
}
