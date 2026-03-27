import { EventBus, type RunEvent } from "./event-bus.js";
import type { RunStore } from "./run-store.js";

/**
 * Subscribes to the global EventBus and delivers webhook POST requests
 * for run.completed and run.errored events when the run has a webhook_url set.
 *
 * Uses exponential retry: 3 attempts at 1s / 5s / 15s backoff.
 * 5-second request timeout per attempt.
 * Errors are logged but never propagated — webhook delivery must never affect pipeline execution.
 */
export class WebhookDispatcher {
  private static readonly RETRY_DELAYS = [1_000, 5_000, 15_000];
  private static readonly REQUEST_TIMEOUT = 5_000;
  private static readonly TARGET_EVENTS: ReadonlySet<string> = new Set([
    "run.completed",
    "run.errored",
  ]);

  private readonly bus: EventBus;
  private readonly store: RunStore;
  private readonly listener: (event: RunEvent) => void;

  constructor(store: RunStore) {
    this.bus = EventBus.getInstance();
    this.store = store;
    this.listener = (event: RunEvent) => this.onEvent(event);
    this.bus.on("run-event", this.listener);
  }

  /** Stop listening (for graceful shutdown / testing). */
  stop(): void {
    this.bus.removeListener("run-event", this.listener);
  }

  private onEvent(event: RunEvent): void {
    if (!WebhookDispatcher.TARGET_EVENTS.has(event.event)) return;

    // Fire-and-forget — never await, never throw
    void this.dispatch(event).catch(() => {
      // swallow — already logged inside dispatch
    });
  }

  private async dispatch(event: RunEvent): Promise<void> {
    let webhookUrl: string | undefined;
    try {
      const record = await this.store.load(event.runId);
      if (!record?.webhook_url) return;
      webhookUrl = record.webhook_url;
    } catch (err) {
      console.error(
        `[webhook] failed to load run ${event.runId}: ${err instanceof Error ? err.message : String(err)}`
      );
      return;
    }

    for (let attempt = 0; attempt < WebhookDispatcher.RETRY_DELAYS.length; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          WebhookDispatcher.REQUEST_TIMEOUT
        );

        const response = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(event),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) return; // success

        console.error(
          `[webhook] POST ${webhookUrl} returned ${response.status} (attempt ${attempt + 1}/${WebhookDispatcher.RETRY_DELAYS.length})`
        );
      } catch (err) {
        console.error(
          `[webhook] POST ${webhookUrl} failed (attempt ${attempt + 1}/${WebhookDispatcher.RETRY_DELAYS.length}): ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Wait before next retry (unless this was the last attempt)
      if (attempt < WebhookDispatcher.RETRY_DELAYS.length - 1) {
        await sleep(WebhookDispatcher.RETRY_DELAYS[attempt]!);
      }
    }

    console.error(
      `[webhook] exhausted all ${WebhookDispatcher.RETRY_DELAYS.length} attempts for ${webhookUrl} (run ${event.runId})`
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
