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
import { createLogger } from "./log.js";

const log = createLogger();

export type AutoExecutorOptions = {
  backgroundQueue: BackgroundQueue;
  runQueue: RunQueue;
  store: RunStore;
  telegram?: TelegramNotifier;
};

export class AutoExecutor {
  private readonly bgQueue: BackgroundQueue;
  private readonly runQueue: RunQueue;
  private readonly store: RunStore;
  private readonly telegram: TelegramNotifier | undefined;
  private enabled = false;
  private dispatching = false;

  /**
   * Maps pipeline runId → background queue item id.
   * Tracks which background queue item a given pipeline run belongs to.
   */
  private activeRunMap = new Map<string, string>();

  private readonly eventHandler: (event: RunEvent) => void;

  constructor(opts: AutoExecutorOptions) {
    this.bgQueue = opts.backgroundQueue;
    this.runQueue = opts.runQueue;
    this.store = opts.store;
    this.telegram = opts.telegram;

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

  // ─── Internal ─────────────────────────────────────────────

  /**
   * Handle a run completion or error event. If the run was dispatched by us,
   * update the background queue item accordingly and dispatch the next item.
   */
  private async handleRunFinished(event: RunEvent): Promise<void> {
    const queueItemId = this.activeRunMap.get(event.runId);
    if (!queueItemId) return; // Not our run

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
   * Check if there's an active background run. If not, pop the next item
   * from the background queue and enqueue it via RunQueue.
   */
  private async tryDispatchNext(): Promise<void> {
    if (!this.enabled) return;

    // Guard against concurrent dispatch
    if (this.dispatching) return;
    this.dispatching = true;

    try {
      // Check if any background run is currently active
      if (this.activeRunMap.size > 0) return;

      // Also check the run store for any running background runs we might not know about
      const runningRuns = await this.store.list({ status: "running" });
      const bgRunning = runningRuns.filter((r) => r.source === "background");
      if (bgRunning.length > 0) return;

      // Pop the highest-priority pending item
      const item = this.bgQueue.pop();
      if (!item) return;

      log.log("info", `[auto-executor] dispatching queue item ${item.id} (pipeline: ${item.pipeline})`);

      // Enqueue into the RunQueue
      const runId = await this.runQueue.enqueue(item.pipeline, item.inputs, {
        source: "background",
      });

      // runId can be string or string[] — normalize to string
      const resolvedRunId = Array.isArray(runId) ? runId[0] : runId;
      if (resolvedRunId) {
        this.activeRunMap.set(resolvedRunId, item.id);
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
