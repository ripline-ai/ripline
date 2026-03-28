/**
 * Fire-and-forget activity event emitter.
 *
 * Posts lifecycle events to the Wintermute activity API.
 * Failed posts are buffered to `data/activity-buffer.jsonl` and retried
 * on the next pipeline run start via `flushBuffer()`.
 */

import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
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
 *
 * Uses node:http directly with agent:false to disable keep-alive connection
 * pooling, ensuring the process can exit cleanly after fire-and-forget calls.
 */
async function postEvent(event: ActivityEvent): Promise<boolean> {
  const base = process.env["WINTERMUTE_URL"] ?? DEFAULT_WINTERMUTE_URL;
  const url = `${base}${ACTIVITY_ENDPOINT}`;
  return new Promise((resolve) => {
    let settled = false;
    const settle = (val: boolean) => {
      if (!settled) {
        settled = true;
        resolve(val);
      }
    };

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      settle(false);
      return;
    }

    const body = JSON.stringify(event);
    const isHttps = parsedUrl.protocol === "https:";
    const options: http.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "Connection": "close",
      },
      // agent: false disables connection pooling — no keep-alive, process exits cleanly
      agent: false,
    };

    const timer = setTimeout(() => {
      req.destroy();
      settle(false);
    }, POST_TIMEOUT_MS);

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      // Drain response body so the socket closes
      res.resume();
      res.on("end", () => {
        clearTimeout(timer);
        settle((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
      });
    });

    req.on("error", () => {
      clearTimeout(timer);
      settle(false);
    });

    req.write(body);
    req.end();
  });
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
 * Caps the flush to MAX_FLUSH_BATCH events per call to prevent runaway
 * sequential HTTP traffic from stale backlogs stalling the event loop.
 *
 * Should be called at pipeline run start.
 */
const MAX_FLUSH_BATCH = 50;

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

  // Cap batch size to prevent stalling on large backlogs
  const batch = lines.slice(0, MAX_FLUSH_BATCH);
  const deferred = lines.slice(MAX_FLUSH_BATCH);

  const stillFailed: ActivityEvent[] = [];

  for (const line of batch) {
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

  // Remaining buffer = events that failed to post + events deferred for next batch
  const remaining = [...stillFailed, ...deferred.map((l) => {
    try { return JSON.parse(l) as ActivityEvent; } catch { return null; }
  }).filter((e): e is ActivityEvent => e !== null)];

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
