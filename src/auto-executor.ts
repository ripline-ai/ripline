/**
 * AutoExecutor – drives sequential execution of BackgroundQueue items.
 *
 * When enabled, listens for pipeline run completions via EventBus and
 * automatically dispatches the next highest-priority pending item through
 * the RunQueue with `source: 'background'`.
 */

import { EventBus, type RunEvent } from "./event-bus.js";
import type { BackgroundQueue } from "./background-queue.js";
import type { RunQueue } from "./run-queue.js";
import type { TelegramNotifier } from "./telegram.js";
import type { RunStore } from "./run-store.js";
import type { QueueService } from "./lib/queueService.js";
import { createLogger } from "./log.js";

const log = createLogger();

/** If abs(backlogPriority - queueComputedPriority) exceeds this, sync the priority. */
export const PRIORITY_SYNC_THRESHOLD = 0.5;

/** A dispatchable backlog item with its current priority and source identifier. */
export type BacklogItem = {
  sourceId: string;
  priority: number;
};

/** Summary returned by syncPriorities(). */
export type PrioritySyncSummary = {
  checked: number;
  synced: number;
};

export type AutoExecutorOptions = {
  backgroundQueue: BackgroundQueue;
  runQueue: RunQueue;
  store: RunStore;
  telegram?: TelegramNotifier;
  queueService?: QueueService;
};

export class AutoExecutor {
  private readonly bgQueue: BackgroundQueue;
  private readonly runQueue: RunQueue;
  private readonly store: RunStore;
  private readonly telegram: TelegramNotifier | undefined;
  private readonly queueService: QueueService | undefined;
  private enabled = false;
  private dispatching = false;

  /**
   * Maps pipeline runId → background queue item id.
   * Tracks which background queue item a given pipeline run belongs to.
   */
  private activeRunMap = new Map<string, string>();

  private lastDispatchAt: number | null = null;

  private readonly eventHandler: (event: RunEvent) => void;

  constructor(opts: AutoExecutorOptions) {
    this.bgQueue = opts.backgroundQueue;
    this.runQueue = opts.runQueue;
    this.store = opts.store;
    this.telegram = opts.telegram;
    this.queueService = opts.queueService;

    this.eventHandler = (event: RunEvent) => {
      if (event.event === "run.completed" || event.event === "run.errored") {
        this.handleRunFinished(event).catch((err) => {
          log.log("error", `[auto-executor] error handling run finish: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    };
  }

  /** Enable auto-dispatch. Immediately checks queue and dispatches if idle. */
  enable(): void {
    if (this.enabled) return;
    this.enabled = true;
    EventBus.getInstance().on("run-event", this.eventHandler);
    log.log("info", "[auto-executor] enabled");
    // Recover orphaned "running" items that have no runId (e.g. from a previous crash/restart)
    const orphaned = this.bgQueue.list().filter((i) => i.status === "running" && !i.runId);
    for (const item of orphaned) {
      log.log("warn", `[auto-executor] resetting orphaned queue item ${item.id} to pending`);
      this.bgQueue.update(item.id, { status: "pending" });
    }
    // Kick off immediately if nothing is running
    this.tryDispatchNext().catch((err) => {
      log.log("error", `[auto-executor] error on initial dispatch: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Disable auto-dispatch. Current run finishes but no new one starts. */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    EventBus.getInstance().removeListener("run-event", this.eventHandler);
    log.log("info", "[auto-executor] disabled");
  }

  /** Whether auto-dispatch is currently enabled. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Timestamp of the last successful dispatch, or null if none. */
  getLastDispatchAt(): number | null {
    return this.lastDispatchAt;
  }

  // ─── Internal ─────────────────────────────────────────────

  /**
   * Handle a run completion or error event. If the run was dispatched by us,
   * update the background queue item accordingly and dispatch the next item.
   */
  private async handleRunFinished(event: RunEvent): Promise<void> {
    const queueItemId = this.activeRunMap.get(event.runId);
    if (!queueItemId) {
      // Not our run, but still try to dispatch next in case we missed a completion
      if (this.enabled) {
        await this.tryDispatchNext();
      }
      return;
    }

    this.activeRunMap.delete(event.runId);

    const item = this.bgQueue.get(queueItemId);
    if (!item) return;

    if (event.event === "run.completed") {
      // Mark queue item as done
      this.bgQueue.update(queueItemId, { status: "completed" });
      log.log("info", `[auto-executor] queue item ${queueItemId} completed (run ${event.runId})`);

      // Telegram notification
      if (this.telegram) {
        // Try to get a summary from the run outputs
        let summary: string | undefined;
        try {
          const record = await this.store.load(event.runId);
          if (record?.outputs) {
            const result = record.outputs["delegation.result"];
            if (result && typeof result === "object" && "text" in result) {
              summary = String((result as { text: string }).text).slice(0, 200);
            }
          }
        } catch { /* ignore */ }

        await this.telegram.notify({
          type: "run_completed",
          pipelineName: item.pipeline,
          queueItemId,
          ...(summary !== undefined && { summary }),
        });
      }
    } else {
      // run.errored — use circuit breaker
      const updated = this.bgQueue.recordRetry(queueItemId);
      if (updated?.status === "failed") {
        log.log("warn", `[auto-executor] queue item ${queueItemId} circuit-broken after ${updated.retries} retries`);
      } else {
        log.log("info", `[auto-executor] queue item ${queueItemId} errored, retry ${updated?.retries ?? "?"}/${item.maxRetries}`);
      }

      // Telegram notification
      if (this.telegram) {
        let errorMsg: string | undefined;
        try {
          const record = await this.store.load(event.runId);
          errorMsg = record?.error;
        } catch { /* ignore */ }

        await this.telegram.notify({
          type: "run_failed",
          pipelineName: item.pipeline,
          queueItemId,
          ...(errorMsg !== undefined && { error: errorMsg }),
        });
      }
    }

    // Try dispatching the next item
    if (this.enabled) {
      await this.tryDispatchNext();
    }
  }

  /**
   * Compare backlog priorities with queue computed priorities for items already
   * enqueued. If the absolute difference exceeds PRIORITY_SYNC_THRESHOLD,
   * issue a PATCH to update the queue item's severityWeight so the queue
   * execution order stays aligned with the backlog.
   *
   * @param backlogItems  Dispatchable backlog items with their current priority and sourceId.
   * @returns Summary of how many items were checked and how many were synced.
   */
  async syncPriorities(backlogItems: BacklogItem[]): Promise<PrioritySyncSummary> {
    if (!this.queueService) {
      log.log("warn", "[auto-executor] syncPriorities called but no queueService configured");
      return { checked: 0, synced: 0 };
    }

    let checked = 0;
    let synced = 0;

    for (const backlogItem of backlogItems) {
      const queueItem = await this.queueService.findBySourceId(backlogItem.sourceId);
      if (!queueItem) continue;

      checked++;

      const queuePriority = queueItem.computedPriority ?? 0;
      const diff = Math.abs(backlogItem.priority - queuePriority);

      if (diff > PRIORITY_SYNC_THRESHOLD) {
        log.log(
          "info",
          `[auto-executor] priority sync: item ${queueItem.id} (source ${backlogItem.sourceId}) ` +
            `backlog=${backlogItem.priority.toFixed(2)} queue=${queuePriority.toFixed(2)} diff=${diff.toFixed(2)} — patching`,
        );
        await this.queueService.updatePriority(queueItem.id, {
          severityWeight: backlogItem.priority,
        });
        synced++;
      }
    }

    log.log("info", `[auto-executor] priority sync complete: checked=${checked} synced=${synced}`);
    return { checked, synced };
  }

  /**
   * Check if there's an active background run. If not, pop the next item
   * from the background queue and enqueue it via RunQueue.
   */
  private async tryDispatchNext(): Promise<void> {
    if (!this.enabled) return;

    // Guard against concurrent dispatch
    if (this.dispatching) return;
    this.dispatching = true;

    try {
      // Check if any background run is currently active (in-memory fast path)
      if (this.activeRunMap.size > 0) return;

      // Persistent guard: check the YAML queue for any item already marked "running".
      // This catches cases where activeRunMap was cleared (restart, race) but a run
      // is still in progress and has the queue item locked as "running".
      const runningQueueItems = this.bgQueue.list().filter((i) => i.status === "running");
      if (runningQueueItems.length > 0) return;

      // Also check the run store for any running background runs we might not know about
      const runningRuns = await this.store.list({ status: "running" });
      const bgRunning = runningRuns.filter((r) => r.source === "background");
      if (bgRunning.length > 0) return;

      // Pop the highest-priority pending item
      const item = this.bgQueue.pop();
      if (!item) return;

      log.log("info", `[auto-executor] dispatching queue item ${item.id} (pipeline: ${item.pipeline})`);

      // Enqueue into the RunQueue
      let runId: string | string[];
      try {
        runId = await this.runQueue.enqueue(item.pipeline, item.inputs, {
          source: "background",
        });
      } catch (err) {
        // Roll back queue item to pending so it can be retried
        this.bgQueue.update(item.id, { status: "pending" });
        throw err;
      }

      // runId can be string or string[] — normalize to string
      const resolvedRunId = Array.isArray(runId) ? runId[0] : runId;
      if (resolvedRunId) {
        this.activeRunMap.set(resolvedRunId, item.id);
        this.bgQueue.update(item.id, { runId: resolvedRunId });
        this.lastDispatchAt = Date.now();
      }

      // Telegram notification
      if (this.telegram) {
        await this.telegram.notify({
          type: "run_started",
          pipelineName: item.pipeline,
          queueItemId: item.id,
        });
      }
    } finally {
      this.dispatching = false;
    }
  }
}
