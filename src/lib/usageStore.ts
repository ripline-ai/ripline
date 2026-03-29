/* ------------------------------------------------------------------ */
/*  File-backed usage store for the Claude Usage Battery Meter         */
/*                                                                     */
/*  Stores usage events in  data/usage/events.json                     */
/*  Stores config in        data/usage/config.json                     */
/* ------------------------------------------------------------------ */

import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { writeJsonAtomically } from "./atomic-write.js";
import type {
  UsageEvent,
  UsageAggregate,
  UsageConfig,
  PipelineBreakdown,
  HourlyBucket,
} from "./usageTypes.js";
import { DEFAULT_USAGE_CONFIG } from "./usageTypes.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * File-backed usage store.
 *
 * - Events are kept in a single JSON array file (`events.json`).
 * - An in-memory cache is maintained for fast aggregation.
 * - Config lives in `config.json` and is created with sensible defaults
 *   on first access.
 */
export class UsageStore {
  private events: UsageEvent[] = [];
  private dir: string;
  private eventsPath: string;
  private configPath: string;
  private ready: Promise<void>;

  constructor(dataDir?: string) {
    this.dir =
      dataDir ??
      path.join(
        process.env["RIPLINE_DATA"] ?? path.join(process.cwd(), "data"),
        "usage",
      );
    this.eventsPath = path.join(this.dir, "events.json");
    this.configPath = path.join(this.dir, "config.json");
    this.ready = this.init();
  }

  /* ------------------------------------------------------------------ */
  /*  Initialisation                                                     */
  /* ------------------------------------------------------------------ */

  private async init(): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });

    // Load existing events
    try {
      const raw = await fsp.readFile(this.eventsPath, "utf-8");
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        this.events = parsed as UsageEvent[];
      }
    } catch {
      // File doesn't exist yet — start empty.
    }

    // Auto-prune on startup
    await this.pruneOlderThan(30);
  }

  /** Wait until the store is fully initialised. */
  async waitReady(): Promise<void> {
    await this.ready;
  }

  /* ------------------------------------------------------------------ */
  /*  Events                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Append a new usage event.
   *
   * If `event.id` is not supplied one will be generated.
   * If `event.timestamp` is not supplied the current time is used.
   * `totalTokens` is recomputed as `inputTokens + outputTokens`.
   */
  async appendEvent(
    event: Omit<UsageEvent, "id" | "timestamp" | "totalTokens"> &
      Partial<Pick<UsageEvent, "id" | "timestamp" | "totalTokens">>,
  ): Promise<UsageEvent> {
    await this.ready;

    const full: UsageEvent = {
      id: event.id ?? crypto.randomUUID(),
      timestamp: event.timestamp ?? new Date().toISOString(),
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      totalTokens: event.inputTokens + event.outputTokens,
      ...(event.pipelineId !== undefined && { pipelineId: event.pipelineId }),
      ...(event.pipelineName !== undefined && { pipelineName: event.pipelineName }),
      ...(event.model !== undefined && { model: event.model }),
      ...(event.meta !== undefined && { meta: event.meta }),
    };

    this.events.push(full);
    await this.flush();
    return full;
  }

  /** Return raw events within a time window. */
  async getEvents(since?: string, until?: string): Promise<UsageEvent[]> {
    await this.ready;
    return this.events.filter((e) => {
      if (since && e.timestamp < since) return false;
      if (until && e.timestamp > until) return false;
      return true;
    });
  }

  /* ------------------------------------------------------------------ */
  /*  Aggregation                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Compute aggregates for all events from `since` up to `until`
   * (defaults to now).
   */
  async getAggregates(since: string, until?: string): Promise<UsageAggregate> {
    await this.ready;

    const untilStr = until ?? new Date().toISOString();
    const filtered = this.events.filter(
      (e) => e.timestamp >= since && e.timestamp <= untilStr,
    );

    // Totals
    let inputTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    // Per-pipeline map
    const pipelineMap = new Map<
      string,
      PipelineBreakdown
    >();

    // Hourly buckets map
    const hourlyMap = new Map<string, HourlyBucket>();

    for (const ev of filtered) {
      inputTokens += ev.inputTokens;
      outputTokens += ev.outputTokens;
      totalTokens += ev.totalTokens;

      // Pipeline breakdown
      const pKey = ev.pipelineId ?? "_none_";
      const existing = pipelineMap.get(pKey);
      if (existing) {
        existing.inputTokens += ev.inputTokens;
        existing.outputTokens += ev.outputTokens;
        existing.totalTokens += ev.totalTokens;
        existing.eventCount += 1;
      } else {
        pipelineMap.set(pKey, {
          pipelineId: ev.pipelineId ?? "_none_",
          pipelineName: ev.pipelineName ?? "unknown",
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          totalTokens: ev.totalTokens,
          eventCount: 1,
        });
      }

      // Hourly bucket
      const hourKey = ev.timestamp.slice(0, 13) + ":00:00.000Z";
      const hExisting = hourlyMap.get(hourKey);
      if (hExisting) {
        hExisting.inputTokens += ev.inputTokens;
        hExisting.outputTokens += ev.outputTokens;
        hExisting.totalTokens += ev.totalTokens;
        hExisting.eventCount += 1;
      } else {
        hourlyMap.set(hourKey, {
          hour: hourKey,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          totalTokens: ev.totalTokens,
          eventCount: 1,
        });
      }
    }

    // Sort hourly buckets chronologically
    const hourlyBuckets = [...hourlyMap.values()].sort((a, b) =>
      a.hour.localeCompare(b.hour),
    );

    // Sort pipeline breakdown by total tokens descending
    const byPipeline = [...pipelineMap.values()].sort(
      (a, b) => b.totalTokens - a.totalTokens,
    );

    return {
      since,
      until: untilStr,
      inputTokens,
      outputTokens,
      totalTokens,
      eventCount: filtered.length,
      byPipeline,
      hourlyBuckets,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Pruning                                                            */
  /* ------------------------------------------------------------------ */

  /** Remove events older than `days` days. Returns the number removed. */
  async pruneOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const before = this.events.length;
    this.events = this.events.filter((e) => e.timestamp >= cutoff);
    const removed = before - this.events.length;
    if (removed > 0) {
      await this.flush();
    }
    return removed;
  }

  /* ------------------------------------------------------------------ */
  /*  Config                                                             */
  /* ------------------------------------------------------------------ */

  /** Read the usage config, creating a default one if it doesn't exist. */
  async getConfig(): Promise<UsageConfig> {
    await this.ready;

    try {
      const raw = await fsp.readFile(this.configPath, "utf-8");
      return JSON.parse(raw) as UsageConfig;
    } catch {
      // First access — write defaults
      await this.setConfig(DEFAULT_USAGE_CONFIG);
      return { ...DEFAULT_USAGE_CONFIG };
    }
  }

  /** Persist a new usage config. */
  async setConfig(config: UsageConfig): Promise<void> {
    await this.ready;
    await writeJsonAtomically(this.configPath, config);
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  private async flush(): Promise<void> {
    await writeJsonAtomically(this.eventsPath, this.events);
  }
}

/** Singleton instance used throughout the application. */
let _instance: UsageStore | undefined;

export function getUsageStore(): UsageStore {
  if (!_instance) {
    _instance = new UsageStore();
  }
  return _instance;
}
