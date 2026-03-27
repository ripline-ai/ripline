import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type {
  ActivityEvent,
  ActivityQuery,
  ActivitySource,
  ActivityStatus,
} from "./types/activity.js";

/** Re-export types for convenience. */
export type { ActivityEvent, ActivityQuery } from "./types/activity.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * JSONL-backed activity store with an in-memory index for fast queries.
 *
 * - Appends events as newline-delimited JSON to `data/activity.jsonl`.
 * - Keeps an in-memory array sorted by timestamp (descending) for queries.
 * - Prunes entries older than 30 days on initialization and rewrites the file.
 */
export class ActivityStore {
  private events: ActivityEvent[] = [];
  private filePath: string;
  private ready: Promise<void>;

  constructor(filePath?: string) {
    this.filePath =
      filePath ??
      path.join(
        process.env["RIPLINE_DATA"] ?? path.join(process.cwd(), "data"),
        "activity.jsonl",
      );
    this.ready = this.init();
  }

  /* ------------------------------------------------------------------ */
  /*  Initialisation                                                     */
  /* ------------------------------------------------------------------ */

  private async init(): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fsp.mkdir(dir, { recursive: true });

    let raw: string;
    try {
      raw = await fsp.readFile(this.filePath, "utf-8");
    } catch {
      // File doesn't exist yet — nothing to load.
      return;
    }

    const cutoff = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
    const kept: ActivityEvent[] = [];

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const event = JSON.parse(trimmed) as ActivityEvent;
        if (event.timestamp >= cutoff) {
          kept.push(event);
        }
      } catch {
        // Skip malformed lines.
      }
    }

    // Sort descending by timestamp for fast recent-first queries.
    kept.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));
    this.events = kept;

    // Rewrite file without pruned entries.
    if (raw.split("\n").filter((l) => l.trim()).length !== kept.length) {
      await this.rewriteFile();
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** Wait for the store to finish loading / pruning. */
  async waitReady(): Promise<void> {
    await this.ready;
  }

  /** Generate a new ActivityEvent id. */
  static newId(): string {
    return crypto.randomUUID();
  }

  /** Append a new event to the store and persist it. */
  async append(event: ActivityEvent): Promise<void> {
    await this.ready;
    this.events.unshift(event); // keep descending order (newest first)
    // Re-sort in case caller supplies an older timestamp.
    this.events.sort((a, b) => (a.timestamp > b.timestamp ? -1 : 1));

    const line = JSON.stringify(event) + "\n";
    await fsp.appendFile(this.filePath, line, "utf-8");
  }

  /** Query events matching the given filters. Returns most-recent first. */
  async query(filter: ActivityQuery = {}): Promise<ActivityEvent[]> {
    await this.ready;

    let results = this.events;

    if (filter.source !== undefined) {
      results = results.filter((e) => e.source === filter.source);
    }
    if (filter.project !== undefined) {
      results = results.filter((e) => e.project === filter.project);
    }
    if (filter.status !== undefined) {
      results = results.filter((e) => e.status === filter.status);
    }
    if (filter.since !== undefined) {
      const since = filter.since;
      results = results.filter((e) => e.timestamp >= since);
    }
    if (filter.limit !== undefined && filter.limit > 0) {
      results = results.slice(0, filter.limit);
    }

    return results;
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  private async rewriteFile(): Promise<void> {
    // Write oldest-first so the file is in chronological order.
    const lines = [...this.events]
      .reverse()
      .map((e) => JSON.stringify(e))
      .join("\n");
    await fsp.writeFile(this.filePath, lines + "\n", "utf-8");
  }
}
