import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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

export type RecoverStaleRunsOptions = {
  /**
   * When true, only recover runs that carry an ownerPid and whose owner process
   * is no longer alive. Use this for live recovery while the scheduler/server
   * is running so genuinely active runs are left alone.
   */
  requireOwnerPid?: boolean;
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
  recoverStaleRuns(options?: RecoverStaleRunsOptions): Promise<number>;
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

export type RunIndexEntry = {
  status: PipelineRunStatus;
  pipelineId: string;
  startedAt: number;
  updatedAt: number;
};

const RUN_STATUSES = new Set<PipelineRunStatus>([
  "pending",
  "running",
  "paused",
  "errored",
  "completed",
  "needs-conflict-resolution",
]);

export class PipelineRunStore implements RunStore {
  private readonly runIndex = new Map<string, RunIndexEntry>();
  private initializationPromise: Promise<void> | null = null;
  private indexFlushPromise: Promise<void> = Promise.resolve();

  constructor(private readonly rootDir: string) {
    this.initializationPromise = this.initializeIndex();
  }

  private isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EPERM means the process exists but we lack permission to signal it.
      return code === "EPERM";
    }
  }

  /** Path to run directory: <rootDir>/<runId>/ */
  runDir(runId: string): string {
    return path.join(this.rootDir, runId);
  }

  /** Path to run record file: <rootDir>/<runId>/run.json */
  private resolvePath(runId: string): string {
    return path.join(this.runDir(runId), "run.json");
  }

  private indexPath(): string {
    return path.join(this.rootDir, "_index.json");
  }

  private async readRunRecord(runId: string): Promise<PipelineRunRecord | null> {
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

  private async initializeIndex(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    try {
      const data = await fs.readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(data) as unknown;
      this.loadIndexEntries(parsed);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && !(err instanceof SyntaxError)) {
        try {
          await this.rebuildIndex();
          return;
        } catch {
          throw err;
        }
      }
      await this.rebuildIndex();
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initializationPromise) {
      this.initializationPromise = this.initializeIndex();
    }
    await this.initializationPromise;
  }

  private loadIndexEntries(raw: unknown): void {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new SyntaxError("Run index must be a JSON object.");
    }

    this.runIndex.clear();
    for (const [runId, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (!this.isRunIndexEntry(entry)) {
        throw new SyntaxError(`Invalid run index entry for ${runId}.`);
      }
      this.runIndex.set(runId, entry);
    }
  }

  private isRunIndexEntry(value: unknown): value is RunIndexEntry {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const entry = value as Partial<RunIndexEntry>;
    return (
      typeof entry.pipelineId === "string" &&
      typeof entry.status === "string" &&
      RUN_STATUSES.has(entry.status as PipelineRunStatus) &&
      Number.isFinite(entry.startedAt) &&
      Number.isFinite(entry.updatedAt)
    );
  }

  private setIndexEntry(record: PipelineRunRecord): void {
    this.runIndex.set(record.id, {
      status: record.status,
      pipelineId: record.pipelineId,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
    });
  }

  private async flushIndex(): Promise<void> {
    const targetPath = this.indexPath();
    const flushOperation = this.indexFlushPromise.catch(() => {}).then(async () => {
      const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
      const snapshot = Object.fromEntries(this.runIndex);
      await fs.writeFile(tmpPath, JSON.stringify(snapshot, null, 2), "utf8");
      await fs.rename(tmpPath, targetPath);
    });
    this.indexFlushPromise = flushOperation;
    await flushOperation;
  }

  async init(): Promise<void> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();
    return this.readRunRecord(runId);
  }

  async save(record: PipelineRunRecord): Promise<void> {
    await this.ensureInitialized();
    record.updatedAt = Date.now();
    const dir = this.runDir(record.id);
    await fs.mkdir(dir, { recursive: true });
    const targetPath = this.resolvePath(record.id);
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(record, null, 2), "utf8");
    await fs.rename(tmpPath, targetPath);
    this.setIndexEntry(record);
    await this.flushIndex();
  }

  async updateStatus(runId: string, status: PipelineRunStatus): Promise<PipelineRunRecord | null> {
    await this.ensureInitialized();
    const record = await this.load(runId);
    if (!record) return null;
    record.status = status;
    await this.save(record);
    return record;
  }

  async delete(runId: string): Promise<boolean> {
    await this.ensureInitialized();
    const existed = this.runIndex.has(runId);
    await fs.rm(this.runDir(runId), { recursive: true, force: true });
    this.runIndex.delete(runId);
    await this.flushIndex();
    return existed;
  }

  async rebuildIndex(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
    const entries = await fs.readdir(this.rootDir, { withFileTypes: true }).catch(() => []);
    const nextIndex = new Map<string, RunIndexEntry>();

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const run = await this.readRunRecord(entry.name);
        if (!run) continue;
        nextIndex.set(run.id, {
          status: run.status,
          pipelineId: run.pipelineId,
          startedAt: run.startedAt,
          updatedAt: run.updatedAt,
        });
      } catch {
        continue;
      }
    }

    this.runIndex.clear();
    for (const [runId, runEntry] of nextIndex) {
      this.runIndex.set(runId, runEntry);
    }
    await this.flushIndex();
  }

  async list(options?: RunStoreListOptions): Promise<PipelineRunRecord[]> {
    await this.ensureInitialized();

    // Determine effective sort order:
    // - Explicit sortOrder always wins.
    // - Otherwise, pending/running default to 'asc' (FIFO); everything else defaults to 'desc'.
    const explicitOrder = options?.sortOrder;
    const isAsc = explicitOrder === 'asc' ||
      (explicitOrder === undefined && (options?.status === "pending" || options?.status === "running"));
    let matchingRunIds = [...this.runIndex.entries()]
      .filter(([, entry]) => options?.status === undefined || entry.status === options.status)
      .sort((a, b) => (
        isAsc
          ? a[1].startedAt - b[1].startedAt
          : b[1].updatedAt - a[1].updatedAt
      ))
      .map(([runId]) => runId);

    if (options?.limit !== undefined) {
      matchingRunIds = matchingRunIds.slice(0, options.limit);
    }

    const runs = await Promise.all(
      matchingRunIds.map(async (runId) => {
        try {
          return await this.load(runId);
        } catch {
          return null;
        }
      })
    );

    return runs.filter((run): run is PipelineRunRecord => run !== null);
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

  async recoverStaleRuns(options?: RecoverStaleRunsOptions): Promise<number> {
    await this.ensureInitialized();
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
    let recovered = 0;
    for (const record of running) {
      const hasOwnerPid = Number.isInteger(record.ownerPid) && (record.ownerPid ?? 0) > 0;
      if (options?.requireOwnerPid && !hasOwnerPid) {
        continue;
      }
      if (hasOwnerPid && this.isProcessAlive(record.ownerPid!)) {
        continue;
      }
      const retryCount = record.retryCount ?? 0;
      const maxAttempts = record.retryPolicy?.maxAttempts;
      if (maxAttempts !== undefined && retryCount >= maxAttempts) {
        record.status = "errored";
      } else {
        record.status = "pending";
      }
      delete record.ownerPid;
      await this.save(record);
      recovered++;
    }
    return recovered;
  }

  async incrementRetryCount(runId: string): Promise<number> {
    await this.ensureInitialized();
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
    await this.ensureInitialized();
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

  async pruneOlderThan(days: number): Promise<number> {
    await this.ensureInitialized();
    const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
    let removed = 0;

    for (const [runId, entry] of [...this.runIndex.entries()]) {
      if (entry.status !== "completed" && entry.status !== "errored") continue;
      if (entry.updatedAt > cutoffMs) continue;
      if (await this.delete(runId)) {
        removed++;
      }
    }

    return removed;
  }
}
