/**
 * Fire-and-forget activity event emitter.
 *
 * Accepts an EventSink at construction time. Failed emits are buffered to
 * `data/activity-buffer.jsonl` and retried on the next pipeline run start
 * via `flushBuffer()`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ActivityEvent } from "./types/activity.js";
import type { EventSink } from "./interfaces/event-sink.js";
import { NoopEventSink } from "./interfaces/event-sink.js";

const BUFFER_FILE = path.join(
  process.env["RIPLINE_DATA"] ?? path.join(process.cwd(), "data"),
  "activity-buffer.jsonl",
);

/**
 * Append a failed event to the buffer file for later retry.
 */
async function bufferEvent(event: ActivityEvent): Promise<void> {
  try {
    const dir = path.dirname(BUFFER_FILE);
    await fs.mkdir(dir, { recursive: true });
    await fs.appendFile(BUFFER_FILE, JSON.stringify(event) + "\n", "utf-8");
  } catch {
    // Silently ignore buffer write failures — never block pipeline.
  }
}

export class ActivityEmitter {
  private readonly sink: EventSink;

  constructor(sink?: EventSink) {
    this.sink = sink ?? new NoopEventSink();
  }

  /**
   * Emit an activity event (fire-and-forget).
   * If the sink throws or rejects, the event is appended to the buffer file.
   */
  emit(event: ActivityEvent): void {
    Promise.resolve()
      .then(() => this.sink.emit("activity", event))
      .then(
        () => {},
        async () => {
          await bufferEvent(event);
        },
      )
      .catch(() => {
        // Never let emission errors propagate.
      });
  }

  /**
   * Flush buffered events: re-emit each one through the sink.
   * Successfully emitted events are removed from the buffer.
   * Events that still fail remain in the buffer for the next flush.
   *
   * Caps the flush to MAX_FLUSH_BATCH events per call to prevent runaway
   * sequential traffic from stale backlogs stalling the event loop.
   *
   * Should be called at pipeline run start.
   */
  async flushBuffer(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(BUFFER_FILE, "utf-8");
    } catch {
      // No buffer file — nothing to flush.
      return;
    }

    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) return;

    const MAX_FLUSH_BATCH = 50;

    // Cap batch size to prevent stalling on large backlogs
    const batch = lines.slice(0, MAX_FLUSH_BATCH);
    const deferred = lines.slice(MAX_FLUSH_BATCH);

    const stillFailed: ActivityEvent[] = [];

    for (const line of batch) {
      try {
        const event = JSON.parse(line) as ActivityEvent;
        let ok = true;
        try {
          await this.sink.emit("activity", event);
        } catch {
          ok = false;
        }
        if (!ok) {
          stillFailed.push(event);
        }
      } catch {
        // Malformed line — drop it.
      }
    }

    // Remaining buffer = events that failed to emit + events deferred for next batch
    const remaining = [
      ...stillFailed,
      ...deferred
        .map((l) => {
          try {
            return JSON.parse(l) as ActivityEvent;
          } catch {
            return null;
          }
        })
        .filter((e): e is ActivityEvent => e !== null),
    ];

    try {
      if (remaining.length === 0) {
        await fs.unlink(BUFFER_FILE);
      } else {
        const content = remaining.map((e) => JSON.stringify(e)).join("\n") + "\n";
        await fs.writeFile(BUFFER_FILE, content, "utf-8");
      }
    } catch {
      // Ignore cleanup errors.
    }
  }
}
