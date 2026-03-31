import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { BackgroundQueueItem } from "./types.js";
import { YamlFileQueueStore } from "./interfaces/queue-store.js";
import type { QueueStore } from "./interfaces/queue-store.js";

const DEFAULT_QUEUE_PATH = path.join(
  process.env.HOME ?? "~",
  ".ripline/queue.yaml",
);

export type AddItemOptions = {
  pipeline: string;
  inputs?: Record<string, unknown>;
  severityWeight?: number;
  manualBoost?: number;
  maxRetries?: number;
};

/**
 * Manages a YAML-persisted background work queue with priority scoring,
 * mtime-based caching, and circuit-breaker retry logic.
 */
export class BackgroundQueue {
  private readonly store: QueueStore;
  private readonly defaultMaxRetries: number;

  constructor(opts?: { store?: QueueStore; maxRetries?: number }) {
    this.store = opts?.store ?? new YamlFileQueueStore(DEFAULT_QUEUE_PATH);
    this.defaultMaxRetries = opts?.maxRetries ?? 5;
  }

  // ─── CRUD ────────────────────────────────────────────────

  /** Add a new item to the queue. Returns the generated ID. */
  add(opts: AddItemOptions): string {
    const items = this.read();
    const item: BackgroundQueueItem = {
      id: randomUUID(),
      pipeline: opts.pipeline,
      inputs: opts.inputs ?? {},
      priority: 0,
      severityWeight: opts.severityWeight ?? 1,
      manualBoost: opts.manualBoost ?? 0,
      createdAt: Date.now(),
      status: "pending",
      retries: 0,
      maxRetries: opts.maxRetries ?? this.defaultMaxRetries,
      needsReview: false,
    };
    items.push(item);
    this.write(items);
    return item.id;
  }

  /** Return all items (reads from cache when file unchanged). */
  list(): BackgroundQueueItem[] {
    return this.read();
  }

  /** Return a single item by ID, or undefined. */
  get(id: string): BackgroundQueueItem | undefined {
    return this.read().find((i) => i.id === id);
  }

  /** Update fields on an existing item. Returns the updated item or undefined. */
  update(
    id: string,
    patch: Partial<Omit<BackgroundQueueItem, "id">>,
  ): BackgroundQueueItem | undefined {
    const items = this.read();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return undefined;
    items[idx] = { ...items[idx]!, ...patch };
    this.write(items);
    return items[idx]!;
  }

  /** Remove an item by ID. Returns true if found and removed. */
  remove(id: string): boolean {
    const items = this.read();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    items.splice(idx, 1);
    this.write(items);
    return true;
  }

  /** Clear the runId field from an item (used when resetting ghost items to pending). */
  clearRunId(id: string): boolean {
    const items = this.read();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return false;
    const item = { ...items[idx]! };
    delete item.runId;
    items[idx] = item;
    this.write(items);
    return true;
  }

  // ─── Priority & Pop ──────────────────────────────────────

  /**
   * Compute the priority score for an item.
   *   score = severityWeight + ageInHours * 0.5 + manualBoost
   */
  computePriority(item: BackgroundQueueItem): number {
    const ageMs = Date.now() - item.createdAt;
    const ageHours = ageMs / (1000 * 60 * 60);
    return item.severityWeight + ageHours * 0.5 + item.manualBoost;
  }

  /**
   * Pop the highest-priority pending item: marks it `running`, persists,
   * and returns it. Returns undefined when no pending items exist.
   */
  pop(): BackgroundQueueItem | undefined {
    const items = this.read();
    const pending = items.filter((i) => i.status === "pending");
    if (pending.length === 0) return undefined;

    // Sort descending by computed priority
    pending.sort((a, b) => this.computePriority(b) - this.computePriority(a));
    const best = pending[0]!;

    // Mark in-progress
    const idx = items.findIndex((i) => i.id === best.id);
    items[idx] = { ...items[idx]!, status: "running", priority: this.computePriority(best) };
    this.write(items);
    return items[idx]!;
  }

  // ─── Circuit Breaker ─────────────────────────────────────

  /**
   * Record a retry for the given item. If retries exceed maxRetries the
   * item is flipped to `failed` with `needsReview: true`.
   *
   * Special case: if the error message contains "exit code 137" (container OOM
   * kill), the item is immediately marked `failed` with `needsReview: true`
   * rather than being retried — retrying with the same memory limit will always
   * fail.
   */
  recordRetry(id: string, errorMessage?: string): BackgroundQueueItem | undefined {
    const items = this.read();
    const idx = items.findIndex((i) => i.id === id);
    if (idx === -1) return undefined;

    const item = items[idx]!;

    // OOM kill — retrying with the same memory limit will always fail.
    if (errorMessage && errorMessage.includes("exit code 137")) {
      items[idx] = { ...item, status: "failed" as const, needsReview: true };
      this.write(items);
      return items[idx];
    }

    const retries = item.retries + 1;

    if (retries >= item.maxRetries) {
      items[idx] = { ...item, retries, status: "failed" as const, needsReview: true };
    } else {
      items[idx] = { ...item, retries, status: "pending" as const };
    }

    this.write(items);
    return items[idx];
  }

  // ─── Persistence ─────────────────────────────────────────

  private read(): BackgroundQueueItem[] {
    return this.store.load();
  }

  private write(items: BackgroundQueueItem[]): void {
    this.store.save(items);
  }
}
