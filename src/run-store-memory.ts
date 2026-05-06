import { randomUUID } from "node:crypto";
import type { PipelineRunRecord, PipelineRunStep, PipelineRunStatus } from "./types.js";
import type {
  RunStore,
  RunStoreCreateParams,
  RunStoreCursor,
  RunStoreListOptions,
  RecoverStaleRunsOptions,
} from "./run-store.js";

export class MemoryRunStore implements RunStore {
  private readonly records = new Map<string, PipelineRunRecord>();
  // In-process claim set — guards against concurrent async callers within the same process
  private readonly activeClaims = new Set<string>();

  async createRun(params: RunStoreCreateParams): Promise<PipelineRunRecord> {
    const id = randomUUID();
    const now = Date.now();
    const record: PipelineRunRecord = {
      id,
      pipelineId: params.pipelineId,
      ...(params.parentRunId !== undefined && { parentRunId: params.parentRunId }),
      source: params.source ?? "user",
      ...(params.taskId !== undefined && { taskId: params.taskId }),
      ...(params.queueMode !== undefined && { queueMode: params.queueMode }),
      ...(params.queueName !== undefined && { queueName: params.queueName }),
      childRunIds: [],
      status: "pending",
      startedAt: now,
      updatedAt: now,
      inputs: params.inputs,
      steps: [],
    };
    this.records.set(id, record);
    return record;
  }

  async load(runId: string): Promise<PipelineRunRecord | null> {
    const record = this.records.get(runId);
    if (!record) return null;
    return JSON.parse(JSON.stringify(record)) as PipelineRunRecord;
  }

  async save(record: PipelineRunRecord): Promise<void> {
    record.updatedAt = Date.now();
    this.records.set(record.id, JSON.parse(JSON.stringify(record)) as PipelineRunRecord);
  }

  async appendStep(record: PipelineRunRecord, step: PipelineRunStep): Promise<void> {
    record.steps.push(step);
    await this.save(record);
  }

  async completeRun(record: PipelineRunRecord, outputs?: Record<string, unknown>, verdict?: 'approved' | 'request_changes'): Promise<void> {
    record.status = "completed";
    if (outputs !== undefined) record.outputs = outputs;
    if (verdict !== undefined) record.verdict = verdict;
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

  async list(options?: RunStoreListOptions): Promise<PipelineRunRecord[]> {
    let runs = Array.from(this.records.values()).map((r) => JSON.parse(JSON.stringify(r)) as PipelineRunRecord);
    if (options?.status !== undefined) {
      runs = runs.filter((r) => r.status === options!.status);
    }
    const explicitOrder = options?.sortOrder;
    const isAsc = explicitOrder === 'asc' ||
      (explicitOrder === undefined && (options?.status === "pending" || options?.status === "running"));
    if (isAsc) {
      runs = [...runs].sort((a, b) => a.startedAt - b.startedAt);
    } else {
      runs = [...runs].sort((a, b) => b.updatedAt - a.updatedAt);
    }
    if (options?.limit !== undefined) {
      runs = runs.slice(0, options.limit);
    }
    return runs;
  }

  async claimRun(runId: string): Promise<boolean> {
    // activeClaims guards the async gap; record mutation is synchronous so effectively atomic
    if (this.activeClaims.has(runId)) return false;
    const record = this.records.get(runId);
    if (!record || record.status !== "pending") return false;
    this.activeClaims.add(runId);
    record.status = "running";
    record.updatedAt = Date.now();
    this.activeClaims.delete(runId);
    return true;
  }

  async recoverStaleRuns(options?: RecoverStaleRunsOptions): Promise<number> {
    let recovered = 0;
    let runningRecords = [...this.records.values()].filter((record) => record.status === "running");
    if (options?.limit !== undefined) {
      runningRecords = runningRecords
        .sort((a, b) => a.startedAt - b.startedAt)
        .slice(0, options.limit);
    }
    for (const record of runningRecords) {
      if (record.status === "running") {
        if (options?.requireOwnerPid && record.ownerPid === undefined) {
          continue;
        }
        record.status = "pending";
        delete record.ownerPid;
        record.updatedAt = Date.now();
        recovered++;
      }
    }
    return recovered;
  }

  async incrementRetryCount(runId: string): Promise<number> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Run not found: ${runId}`);
    record.retryCount = (record.retryCount ?? 0) + 1;
    record.updatedAt = Date.now();
    return record.retryCount;
  }

  async resetForRetry(runId: string, options?: { resetCount?: boolean }): Promise<void> {
    const record = this.records.get(runId);
    if (!record) throw new Error(`Run not found: ${runId}`);
    record.status = "pending";
    delete record.error;
    if (options?.resetCount) {
      record.retryCount = 0;
    }
    record.updatedAt = Date.now();
  }
}
