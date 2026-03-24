import { promises as fs } from "node:fs";
import path from "node:path";
import type { PipelineRegistry } from "../registry.js";
import type { RunQueue } from "../run-queue.js";
import type { RunStore } from "../run-store.js";

export type McpToolContext = {
  registry: PipelineRegistry;
  queue: RunQueue;
  store: RunStore;
  /** Optional: path to the runs directory, used to read log files. */
  runsDir?: string;
};

// ---------------------------------------------------------------------------
// list_pipelines
// ---------------------------------------------------------------------------

export async function handleListPipelines(ctx: McpToolContext): Promise<unknown> {
  const pipelines = await ctx.registry.list();
  return pipelines.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    tags: p.tags ?? [],
    nodeCount: p.nodes.length,
    edgeCount: p.edges.length,
  }));
}

// ---------------------------------------------------------------------------
// run_pipeline
// ---------------------------------------------------------------------------

type RunPipelineArgs = {
  pipeline_id: string;
  inputs?: Record<string, unknown>;
};

export async function handleRunPipeline(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { pipeline_id, inputs = {} } = args as RunPipelineArgs;

  const entry = await ctx.registry.get(pipeline_id);
  if (!entry) {
    return { error: `pipeline not found: ${pipeline_id}` };
  }

  const runIdOrIds = await ctx.queue.enqueue(pipeline_id, inputs);
  const runId = Array.isArray(runIdOrIds) ? runIdOrIds[0] : runIdOrIds;
  if (runId === undefined) {
    return { error: "failed to enqueue pipeline run" };
  }
  return { runId, status: "pending" };
}

// ---------------------------------------------------------------------------
// get_run
// ---------------------------------------------------------------------------

export async function handleGetRun(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { run_id } = args as { run_id: string };
  const record = await ctx.store.load(run_id);
  if (!record) {
    return { error: `run not found: ${run_id}` };
  }
  return record;
}

// ---------------------------------------------------------------------------
// get_run_logs
// ---------------------------------------------------------------------------

export async function handleGetRunLogs(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { run_id } = args as { run_id: string };

  const record = await ctx.store.load(run_id);
  if (!record) {
    return { error: `run not found: ${run_id}` };
  }

  if (!ctx.runsDir) {
    // In-memory store has no log files
    return { logs: "" };
  }

  const logPath = path.join(ctx.runsDir, run_id, "log.txt");
  try {
    const logs = await fs.readFile(logPath, "utf8");
    return { logs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { logs: "" };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// list_runs
// ---------------------------------------------------------------------------

type ListRunsArgs = {
  pipeline_id?: string;
  status?: "pending" | "running" | "paused" | "errored" | "completed";
  limit?: number;
};

export async function handleListRuns(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { pipeline_id, status, limit = 20 } = (args ?? {}) as ListRunsArgs;

  // Store already sorts: pending/running FIFO, others updatedAt desc
  let runs = await ctx.store.list(status !== undefined ? { status } : undefined);

  if (pipeline_id !== undefined) {
    runs = runs.filter((r) => r.pipelineId === pipeline_id);
  }

  return runs.slice(0, limit).map((r) => ({
    id: r.id,
    pipelineId: r.pipelineId,
    status: r.status,
    startedAt: r.startedAt,
  }));
}

// ---------------------------------------------------------------------------
// resume_run
// ---------------------------------------------------------------------------

export async function handleResumeRun(ctx: McpToolContext, args: unknown): Promise<unknown> {
  const { run_id } = args as { run_id: string };

  const record = await ctx.store.load(run_id);
  if (!record) {
    return { error: `run not found: ${run_id}` };
  }

  const NON_RESUMABLE = new Set<string>(["completed", "running", "pending"]);
  if (NON_RESUMABLE.has(record.status)) {
    return { error: `run is not resumable (status: ${record.status})` };
  }

  // Reset to pending so the scheduler picks it up and resumes from cursor
  record.status = "pending";
  await ctx.store.save(record);

  return { runId: run_id, status: "pending" };
}
