import { resolveStageConfig } from "../config.js";

// ─── Types ────────────────────────────────────────────────────────────

export type QueueItemStatus = "pending" | "running" | "completed" | "errored" | "failed";

/** Shape returned by the Ripline queue HTTP endpoints. */
export type QueueItem = {
  id: string;
  pipeline: string;
  inputs: Record<string, unknown>;
  priority: number;
  severityWeight: number;
  manualBoost: number;
  createdAt: number;
  status: QueueItemStatus;
  retries: number;
  maxRetries: number;
  needsReview: boolean;
  runId?: string;
  computedPriority?: number;
  /** Identifier of the external entity that originated this queue item. */
  sourceId?: string;
  /** Type of the external source (e.g. "bug", "story", "task"). */
  sourceType?: string;
};

export type EnqueueParams = {
  pipeline: string;
  inputs?: Record<string, unknown>;
  severityWeight?: number;
  manualBoost?: number;
  maxRetries?: number;
};

export type UpdatePriorityParams = {
  priority?: number;
  manualBoost?: number;
  severityWeight?: number;
  status?: QueueItemStatus;
};

// ─── Service ──────────────────────────────────────────────────────────

export type QueueService = {
  listQueue(): Promise<QueueItem[]>;
  enqueue(params: EnqueueParams): Promise<QueueItem>;
  updatePriority(id: string, params: UpdatePriorityParams): Promise<QueueItem>;
  removeFromQueue(id: string): Promise<void>;
  findBySourceId(sourceId: string): Promise<QueueItem | undefined>;
};

/**
 * Create a typed wrapper around the Ripline queue HTTP API.
 *
 * @param baseUrl  Override the Ripline base URL. When omitted, derives it
 *                 from the STAGE env var via `resolveStageConfig()`.
 * @param fetchFn  Override the global `fetch` (useful for testing / DI).
 */
export function createQueueService(options?: {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}): QueueService {
  const base =
    options?.baseUrl ??
    `http://localhost:${resolveStageConfig().port}`;
  const fetchFn = options?.fetchFn ?? globalThis.fetch;

  async function listQueue(): Promise<QueueItem[]> {
    const res = await fetchFn(`${base}/queue`, { method: "GET" });
    if (!res.ok) {
      throw new Error(`GET /queue failed: ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as { items: QueueItem[] };
    return body.items;
  }

  async function enqueue(params: EnqueueParams): Promise<QueueItem> {
    const res = await fetchFn(`${base}/queue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`POST /queue failed: ${res.status} ${err}`);
    }
    return (await res.json()) as QueueItem;
  }

  async function updatePriority(
    id: string,
    params: UpdatePriorityParams,
  ): Promise<QueueItem> {
    const res = await fetchFn(`${base}/queue/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`PATCH /queue/${id} failed: ${res.status} ${err}`);
    }
    return (await res.json()) as QueueItem;
  }

  async function removeFromQueue(id: string): Promise<void> {
    const res = await fetchFn(`${base}/queue/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`DELETE /queue/${id} failed: ${res.status} ${res.statusText}`);
    }
  }

  async function findBySourceId(
    sourceId: string,
  ): Promise<QueueItem | undefined> {
    const items = await listQueue();
    return items.find((item) => item.sourceId === sourceId);
  }

  return { listQueue, enqueue, updatePriority, removeFromQueue, findBySourceId };
}
