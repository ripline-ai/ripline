/**
 * EventSink — pluggable interface for emitting pipeline events.
 *
 * Implementations decide where events go: a webhook endpoint, the console,
 * or nowhere at all (Noop).
 */
export interface EventSink {
  emit(event: string, data: unknown): void | Promise<void>;
}

/** Discards all events. Useful as a default no-op implementation. */
export class NoopEventSink implements EventSink {
  emit(_event: string, _data: unknown): void {
    // intentionally empty
  }
}

/** Logs all events to the console. */
export class ConsoleEventSink implements EventSink {
  emit(event: string, data: unknown): void {
    console.log(`[event:${event}]`, data);
  }
}

/**
 * Sends events as JSON POST requests to a webhook URL.
 *
 * Fires-and-forgets by default. Construct with `throwOnError: true` to
 * surface HTTP/network failures to the caller.
 */
export class WebhookEventSink implements EventSink {
  private readonly url: string;
  private readonly throwOnError: boolean;

  constructor(url: string, opts?: { throwOnError?: boolean }) {
    this.url = url;
    this.throwOnError = opts?.throwOnError ?? false;
  }

  async emit(event: string, data: unknown): Promise<void> {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, data }),
      });
      if (!res.ok && this.throwOnError) {
        throw new Error(`WebhookEventSink: HTTP ${res.status} from ${this.url}`);
      }
    } catch (err) {
      if (this.throwOnError) throw err;
    }
  }
}
