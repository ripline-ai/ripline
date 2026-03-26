import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Steering action types that can be logged
 */
export type SteeringAction = "reorder" | "inject" | "pause" | "resume" | "cancel" | "redirect";

/**
 * A single entry in the steering log
 */
export interface SteeringLogEntry {
  action: SteeringAction;
  timestamp: number;
  data?: Record<string, unknown>;
}

/**
 * Options for reading the steering log
 */
export interface ReadSteeringLogOptions {
  /** Maximum number of entries to return */
  limit?: number;
  /** Cursor for pagination: return entries before this timestamp */
  before?: number;
}

/**
 * Atomically append a steering log entry to /data/steering-log.jsonl.
 * Writes to a temporary file, fsyncs, then renames into place.
 * Creates the file and parent directory if missing.
 */
export async function appendSteeringLog(entry: SteeringLogEntry): Promise<void> {
  const logPath = "/data/steering-log.jsonl";
  const tmpPath = `${logPath}.${randomBytes(6).toString("hex")}.tmp`;

  // Ensure parent directory exists
  const dir = path.dirname(logPath);
  await fs.mkdir(dir, { recursive: true });

  // Serialize entry as JSON and append newline
  const line = JSON.stringify(entry) + "\n";

  // Write to temp file
  await fs.writeFile(tmpPath, line, { flag: "a" });

  // Sync to disk
  const fd = await fs.open(tmpPath, "a");
  await fd.sync();
  await fd.close();

  // Atomically rename into place
  try {
    await fs.rename(tmpPath, logPath);
  } catch {
    // If rename fails (e.g., file exists), append to existing file
    // This handles the case where another process created the file first
    try {
      const content = await fs.readFile(tmpPath, "utf-8");
      await fs.appendFile(logPath, content);
      await fs.unlink(tmpPath);
    } catch (e) {
      // Clean up temp file if append fails
      try {
        await fs.unlink(tmpPath);
      } catch {
        // Ignore cleanup errors
      }
      throw e;
    }
  }
}

/**
 * Read steering log entries from /data/steering-log.jsonl.
 * Returns entries in newest-first order with cursor-based pagination support.
 * Skips malformed lines with a console.warn.
 */
export async function readSteeringLog(
  options?: ReadSteeringLogOptions
): Promise<SteeringLogEntry[]> {
  const logPath = "/data/steering-log.jsonl";
  const limit = options?.limit;
  const before = options?.before;

  try {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.split("\n").filter((line) => line.trim().length > 0);

    // Parse entries
    const entries: SteeringLogEntry[] = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as SteeringLogEntry;
        entries.push(entry);
      } catch (e) {
        console.warn(`Skipping malformed steering log entry: ${line}`);
      }
    }

    // Reverse to get newest-first order
    entries.reverse();

    // Apply cursor-based pagination
    let filtered = entries;
    if (before !== undefined) {
      filtered = entries.filter((entry) => entry.timestamp < before);
    }

    // Apply limit
    if (limit !== undefined) {
      filtered = filtered.slice(0, limit);
    }

    return filtered;
  } catch (e) {
    // File doesn't exist yet, return empty array
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw e;
  }
}
