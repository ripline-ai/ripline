/**
 * Fire-and-forget activity event emitter.
 *
 * Posts lifecycle events to the Wintermute activity API.
 * Failed posts are buffered to `data/activity-buffer.jsonl` and retried
 * on the next pipeline run start via `flushBuffer()`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { ActivityEvent } from "./types/activity.js";
import { resolveStageConfig } from "./config.js";

const DEFAULT_WINTERMUTE_URL = resolveStageConfig().wintermuteBaseUrl;
const ACTIVITY_ENDPOINT = "/api/activity";
const POST_TIMEOUT_MS = 3000;

const BUFFER_FILE = path.join(
  process.env["RIPLINE_DATA"] ?? path.join(process.cwd(), "data"),
  "activity-buffer.jsonl",
);

/**
 * Post a single activity event to Wintermute.
 * Returns true on success, false on failure.
 */
async function postEvent(event: ActivityEvent): Promise<boolean> {
  const base = process.env["WINTERMUTE_URL"] ?? DEFAULT_WINTERMUTE_URL;
  const url = `${base}${ACTIVITY_ENDPOINT}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: controller.signal,
    });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Emit an activity event (fire-and-forget).
 * If the POST fails, the event is appended to the buffer file.
 */
export function emitActivity(event: ActivityEvent): void {
  postEvent(event).then(async (ok) => {
    if (!ok) {
      await bufferEvent(event);
    }
  }).catch(() => {
    // Never let emission errors propagate.
  });
}

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

/**
 * Flush buffered events: re-post each one to Wintermute.
 * Successfully posted events are removed from the buffer.
 * Events that still fail remain in the buffer for the next flush.
 *
 * Should be called at pipeline run start.
 */
export async function flushActivityBuffer(): Promise<void> {
  let raw: string;
  try {
    raw = await fs.readFile(BUFFER_FILE, "utf-8");
  } catch {
    // No buffer file — nothing to flush.
    return;
  }

  const lines = raw.split("\n").filter((l) => l.trim());
  if (lines.length === 0) return;

  const stillFailed: ActivityEvent[] = [];

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as ActivityEvent;
      const ok = await postEvent(event);
      if (!ok) {
        stillFailed.push(event);
      }
    } catch {
      // Malformed line — drop it.
    }
  }

  try {
    if (stillFailed.length === 0) {
      await fs.unlink(BUFFER_FILE);
    } else {
      const content = stillFailed.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.writeFile(BUFFER_FILE, content, "utf-8");
    }
  } catch {
    // Ignore cleanup errors.
  }
}
