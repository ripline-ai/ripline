import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomically } from "./lib/atomic-write.js";
import type { PipelineRunRecord, PipelineRunStep, PipelineRunStatus, QueueMode, RunSource } from "./types.js";

export type RunStoreCreateParams = {
  pipelineId: string;
  inputs: Record<string, unknown>;
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

export type RunStoreCursor = {
  nextNodeIndex: number;
  context: Record<string, unknown>;
};

export type RunStoreListOptions = {
  status?: PipelineRunStatus;
  /** Return at most this many runs (applied after sorting). */
  limit?: number;
  /**
   * Sort order for results. Defaults to 'desc' (most recent first by updatedAt/startedAt).
   * 'asc' returns oldest first (FIFO — used internally for pending/running).
   */
  sortOrder?: 'asc' | 'desc';
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
  /**
   * Atomically claim a pending run for execution using an O_EXCL lock file.
   * Returns true if this caller successfully claimed it (status set to running),
   * false if another worker already claimed it. Safe for concurrent callers.
   */
  claimRun(runId: string): Promise<boolean>;
  /**
   * Recover orphaned runs left in "running" state by a previous crashed process.
   * Deletes stale claim lock files and resets all "running" runs back to "pending".
   * Should be called once at scheduler startup before workers begin polling.
   * Returns the number of runs recovered.
   */
  recoverStaleRuns(): Promise<number>;
  /**
   * Atomically increment the retryCount for a run.
   * Returns the new retryCount value.
   */
  incrementRetryCount(runId: string): Promise<number>;
  /**
   * Reset a run for retry: sets status to "pending", removes claim lock,
   * and optionally resets retryCount to 0 (for manual retries).
   */
  resetForRetry(runId: string, options?: { resetCount?: boolean }): Promise<void>;
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
      source: params.source ?? "user",
      ...(params.taskId !== undefined && { taskId: params.taskId }),
      ...(params.queueMode !== undefined && { queueMode: params.queueMode as QueueMode }),
      ...(params.queueName !== undefined && { queueName: params.queueName }),
      ...(params.webhook_url !== undefined && { webhook_url: params.webhook_url }),
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
    const dirs = entries.filter((e) => e.isDirectory());

    // Determine effective sort order:
    // - Explicit sortOrder always wins.
    // - Otherwise, pending/running default to 'asc' (FIFO); everything else defaults to 'desc'.
    const explicitOrder = options?.sortOrder;
    const isAsc = explicitOrder === 'asc' ||
      (explicitOrder === undefined && (options?.status === "pending" || options?.status === "running"));

    // When a limit is requested and we want descending order, sort directories by mtime
    // descending before reading — lets us stop early once we have enough records.
    const wantEarlyStop = options?.limit !== undefined && !isAsc;

    if (wantEarlyStop) {
      const withMtime = await Promise.all(
        dirs.map(async (e) => {
          const mtime = await fs.stat(path.join(this.rootDir, e.name))
            .then((s) => s.mtimeMs)
            .catch(() => 0);
          return { name: e.name, mtime };
        })
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const runs: PipelineRunRecord[] = [];
      for (const { name } of withMtime) {
        if (options!.limit! <= runs.length) break;
        const run = await this.load(name);
        if (!run) continue;
        if (options?.status !== undefined && run.status !== options.status) continue;
        runs.push(run);
      }
      return runs.sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const runs: PipelineRunRecord[] = [];
    for (const ent of dirs) {
      const run = await this.load(ent.name);
      if (run) runs.push(run);
    }
    let filtered = options?.status !== undefined ? runs.filter((r) => r.status === options!.status) : runs;
    if (isAsc) {
      filtered = [...filtered].sort((a, b) => a.startedAt - b.startedAt);
    } else {
      filtered = [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (options?.limit !== undefined) {
      filtered = filtered.slice(0, options.limit);
    }
    return filtered;
  }

  async claimRun(runId: string): Promise<boolean> {
    const lockPath = path.join(this.runDir(runId), "claim.lock");
    let fd: fs.FileHandle | null = null;
    try {
      // O_EXCL | O_CREAT = atomic exclusive create; EEXIST if another worker beat us to it
      fd = await fs.open(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      await fd.close();
      fd = null;
      // We hold the lock — verify still pending before committing
      const record = await this.load(runId);
      if (!record || record.status !== "pending") {
        await fs.unlink(lockPath).catch(() => {});
        return false;
      }
      record.status = "running";
      await this.save(record);
      await fs.unlink(lockPath).catch(() => {});
      return true;
    } catch (err) {
      if (fd) await fd.close().catch(() => {});
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async recoverStaleRuns(): Promise<number> {
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    // Remove any claim lock files left by crashed workers
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const lockPath = path.join(this.runDir(ent.name), "claim.lock");
      await fs.unlink(lockPath).catch(() => {});
    }
    // Reset all "running" runs to "pending" — nothing is actually running on a fresh start.
    // Exception: if a run has exhausted its retry policy, reset to "errored" instead so it
    // doesn't re-enter the queue and cause an infinite crash loop.
    const running = await this.list({ status: "running" });
    for (const record of running) {
      const retryCount = record.retryCount ?? 0;
      const maxAttempts = record.retryPolicy?.maxAttempts;
      if (maxAttempts !== undefined && retryCount >= maxAttempts) {
        record.status = "errored";
      } else {
        record.status = "pending";
      }
      await this.save(record);
    }
    return running.length;
  }

  async incrementRetryCount(runId: string): Promise<number> {
    const lockPath = path.join(this.runDir(runId), "claim.lock");
    let fd: fs.FileHandle | null = null;
    try {
      fd = await fs.open(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL);
      await fd.close();
      fd = null;
      const record = await this.load(runId);
      if (!record) {
        await fs.unlink(lockPath).catch(() => {});
        throw new Error(`Run not found: ${runId}`);
      }
      record.retryCount = (record.retryCount ?? 0) + 1;
      await this.save(record);
      await fs.unlink(lockPath).catch(() => {});
      return record.retryCount;
    } catch (err) {
      if (fd) await fd.close().catch(() => {});
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        // Another process holds the lock — wait briefly and retry
        await new Promise((r) => setTimeout(r, 50));
        return this.incrementRetryCount(runId);
      }
      throw err;
    }
  }

  async resetForRetry(runId: string, options?: { resetCount?: boolean }): Promise<void> {
    const lockPath = path.join(this.runDir(runId), "claim.lock");
    const record = await this.load(runId);
    if (!record) {
      throw new Error(`Run not found: ${runId}`);
    }
    record.status = "pending";
    delete record.error;
    if (options?.resetCount) {
      record.retryCount = 0;
    }
    await this.save(record);
    // Remove claim lock if it exists (from a crashed/errored run)
    await fs.unlink(lockPath).catch(() => {});
  }
}
