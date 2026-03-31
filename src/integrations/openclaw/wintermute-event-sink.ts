import type { EventSink } from "../../interfaces/event-sink.js";

/**
 * EventSink that forwards events to a Wintermute instance.
 *
 * The Wintermute base URL is resolved in this priority order:
 *   1. Constructor `baseUrl` option
 *   2. WINTERMUTE_URL environment variable
 *   3. Provided fallback (defaults to "http://localhost:3000")
 *
 * Events are posted as `{ event, data }` JSON to `<baseUrl>/api/events`.
 * Failures are silently swallowed unless `throwOnError: true` is set.
 */
export class WintermuteEventSink implements EventSink {
  private readonly baseUrl: string;
  private readonly throwOnError: boolean;

  constructor(opts?: { baseUrl?: string; throwOnError?: boolean; fallbackUrl?: string }) {
    const fallback = opts?.fallbackUrl ?? "http://localhost:3000";
    this.baseUrl =
      opts?.baseUrl ??
      process.env.WINTERMUTE_URL ??
      fallback;
    this.throwOnError = opts?.throwOnError ?? false;
  }

  async emit(event: string, data: unknown): Promise<void> {
    const url = `${this.baseUrl}/api/events`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event, data }),
      });
      if (!res.ok && this.throwOnError) {
        throw new Error(`WintermuteEventSink: HTTP ${res.status} from ${url}`);
      }
    } catch (err) {
      if (this.throwOnError) throw err;
    }
  }
}
