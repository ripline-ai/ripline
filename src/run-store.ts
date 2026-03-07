import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomically } from "./lib/atomic-write.js";
import type { PipelineRunRecord, PipelineRunStep, PipelineRunStatus, QueueMode } from "./types.js";

export type RunStoreCreateParams = {
  pipelineId: string;
  inputs: Record<string, unknown>;
  parentRunId?: string;
  taskId?: string;
  queueMode?: QueueMode;
};

export type RunStoreCursor = {
  nextNodeIndex: number;
  context: Record<string, unknown>;
};

export type RunStoreListOptions = {
  status?: PipelineRunStatus;
};

export interface RunStore {
  createRun(params: RunStoreCreateParams): Promise<PipelineRunRecord>;
  load(runId: string): Promise<PipelineRunRecord | null>;
  save(record: PipelineRunRecord): Promise<void>;
  appendStep(record: PipelineRunRecord, step: PipelineRunStep): Promise<void>;
  completeRun(record: PipelineRunRecord, outputs?: Record<string, unknown>): Promise<void>;
  failRun(record: PipelineRunRecord, error: string): Promise<void>;
  updateCursor(record: PipelineRunRecord, cursor: RunStoreCursor): Promise<void>;
  /** List runs, optionally filtered by status. Pending/running returned FIFO (oldest first). */
  list(options?: RunStoreListOptions): Promise<PipelineRunRecord[]>;
}

export class PipelineRunStore implements RunStore {
  constructor(private readonly rootDir: string) {}

  /** Path to run directory: <rootDir>/<runId>/ */
  runDir(runId: string): string {
    return path.join(this.rootDir, runId);
  }

  /** Path to run record file: <rootDir>/<runId>/run.json */
  private resolvePath(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async createRun(params: RunStoreCreateParams): Promise<PipelineRunRecord> {
    const id = randomUUID();
    const now = Date.now();
    const record: PipelineRunRecord = {
      id,
      pipelineId: params.pipelineId,
      ...(params.parentRunId !== undefined && { parentRunId: params.parentRunId }),
      ...(params.taskId !== undefined && { taskId: params.taskId }),
      ...(params.queueMode !== undefined && { queueMode: params.queueMode as QueueMode }),
      childRunIds: [],
      status: "pending",
      startedAt: now,
      updatedAt: now,
      inputs: params.inputs,
      steps: [],
    };
    await this.save(record);
    return record;
  }

  async appendStep(record: PipelineRunRecord, step: PipelineRunStep): Promise<void> {
    record.steps.push(step);
    await this.save(record);
  }

  async completeRun(record: PipelineRunRecord, outputs?: Record<string, unknown>): Promise<void> {
    record.status = "completed";
    if (outputs !== undefined) record.outputs = outputs;
    await this.save(record);
  }

  async failRun(record: PipelineRunRecord, error: string): Promise<void> {
    record.status = "errored";
    record.error = error;
    await this.save(record);
  }

  async updateCursor(record: PipelineRunRecord, cursor: RunStoreCursor): Promise<void> {
    record.cursor = cursor;
    await this.save(record);
  }

  async load(runId: string): Promise<PipelineRunRecord | null> {
    try {
      const data = await fs.readFile(this.resolvePath(runId), "utf8");
      return JSON.parse(data) as PipelineRunRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async save(record: PipelineRunRecord): Promise<void> {
    record.updatedAt = Date.now();
    const dir = this.runDir(record.id);
    await fs.mkdir(dir, { recursive: true });
    await writeJsonAtomically(this.resolvePath(record.id), record);
  }

  async list(options?: RunStoreListOptions): Promise<PipelineRunRecord[]> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const runs: PipelineRunRecord[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const run = await this.load(ent.name);
      if (run) runs.push(run);
    }
    let filtered = options?.status !== undefined ? runs.filter((r) => r.status === options!.status) : runs;
    if (options?.status === "pending" || options?.status === "running") {
      filtered = [...filtered].sort((a, b) => a.startedAt - b.startedAt);
    } else {
      filtered = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    return filtered;
  }
}
