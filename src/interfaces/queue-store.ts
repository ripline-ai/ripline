import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";
import type { BackgroundQueueItem } from "../types.js";

/**
 * QueueStore — pluggable persistence interface for the background queue.
 *
 * Implementations decide where queue items are stored: a YAML file on disk,
 * an in-memory array, a database, etc.
 */
export interface QueueStore {
  load(): BackgroundQueueItem[];
  save(items: BackgroundQueueItem[]): void;
}

/** Stores queue items in memory. Items are lost on process restart. */
export class MemoryQueueStore implements QueueStore {
  private items: BackgroundQueueItem[] = [];

  load(): BackgroundQueueItem[] {
    return [...this.items];
  }

  save(items: BackgroundQueueItem[]): void {
    this.items = [...items];
  }
}

/**
 * Persists queue items as a YAML file on disk.
 *
 * The file is created (including parent directories) on the first save.
 * If the file does not exist, load() returns an empty array.
 */
export class YamlFileQueueStore implements QueueStore {
  constructor(private readonly filePath: string) {}

  load(): BackgroundQueueItem[] {
    if (!fs.existsSync(this.filePath)) return [];
    const raw = fs.readFileSync(this.filePath, "utf-8");
    const parsed = YAML.parse(raw);
    return Array.isArray(parsed) ? (parsed as BackgroundQueueItem[]) : [];
  }

  save(items: BackgroundQueueItem[]): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, YAML.stringify(items), "utf-8");
  }
}
