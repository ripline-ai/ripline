import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { ActivityStore } from "../src/activity-store.js";
import type { ActivityEvent } from "../src/types/activity.js";

function tmpFile(): string {
  return path.join(
    os.tmpdir(),
    `activity-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
}

function makeEvent(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    id: ActivityStore.newId(),
    timestamp: new Date().toISOString(),
    source: "ripline",
    sourceId: "run-1",
    action: "run.started",
    summary: "Pipeline started",
    status: "started",
    ...overrides,
  };
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const p of cleanupPaths) {
    await fs.rm(p, { force: true }).catch(() => {});
  }
  cleanupPaths.length = 0;
});

describe("ActivityStore", () => {
  it("append then query returns the appended event", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    const event = makeEvent();
    await store.append(event);

    const results = await store.query();
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(event);
  });

  it("query filters by source", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    await store.append(makeEvent({ source: "ripline", sourceId: "a" }));
    await store.append(makeEvent({ source: "claude-agent", sourceId: "b" }));

    const results = await store.query({ source: "claude-agent" });
    expect(results).toHaveLength(1);
    expect(results[0]!.sourceId).toBe("b");
  });

  it("query filters by project", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    await store.append(makeEvent({ project: "alpha" }));
    await store.append(makeEvent({ project: "beta" }));

    const results = await store.query({ project: "alpha" });
    expect(results).toHaveLength(1);
    expect(results[0]!.project).toBe("alpha");
  });

  it("query filters by status", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    await store.append(makeEvent({ status: "success" }));
    await store.append(makeEvent({ status: "error" }));

    const results = await store.query({ status: "error" });
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("error");
  });

  it("query filters by since", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    const old = makeEvent({ timestamp: "2020-01-01T00:00:00.000Z" });
    const recent = makeEvent({ timestamp: new Date().toISOString() });

    await store.append(old);
    await store.append(recent);

    const results = await store.query({ since: "2025-01-01T00:00:00.000Z" });
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(recent.id);
  });

  it("query respects limit", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    await store.append(makeEvent());
    await store.append(makeEvent());
    await store.append(makeEvent());

    const results = await store.query({ limit: 2 });
    expect(results).toHaveLength(2);
  });

  it("returns events in descending timestamp order", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new ActivityStore(fp);

    const e1 = makeEvent({ timestamp: "2026-01-01T00:00:00.000Z" });
    const e2 = makeEvent({ timestamp: "2026-01-03T00:00:00.000Z" });
    const e3 = makeEvent({ timestamp: "2026-01-02T00:00:00.000Z" });

    await store.append(e1);
    await store.append(e2);
    await store.append(e3);

    const results = await store.query();
    expect(results.map((e) => e.id)).toEqual([e2.id, e3.id, e1.id]);
  });

  it("prunes entries older than 30 days on init", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);

    // Write an old and a recent event directly to the file.
    const old = makeEvent({
      timestamp: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      sourceId: "old",
    });
    const recent = makeEvent({ sourceId: "recent" });

    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(
      fp,
      JSON.stringify(old) + "\n" + JSON.stringify(recent) + "\n",
      "utf-8",
    );

    // Creating a new store should prune the old entry.
    const store = new ActivityStore(fp);
    await store.waitReady();

    const results = await store.query();
    expect(results).toHaveLength(1);
    expect(results[0]!.sourceId).toBe("recent");

    // Verify the file was rewritten without the old entry.
    const raw = await fs.readFile(fp, "utf-8");
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(1);
  });

  it("persists events across store instances", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);

    const store1 = new ActivityStore(fp);
    const event = makeEvent();
    await store1.append(event);

    // New store instance should load persisted events.
    const store2 = new ActivityStore(fp);
    const results = await store2.query();
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(event.id);
  });

  it("creates the data file on first write if absent", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);

    // Ensure file does not exist.
    await fs.rm(fp, { force: true }).catch(() => {});

    const store = new ActivityStore(fp);
    await store.append(makeEvent());

    const stat = await fs.stat(fp);
    expect(stat.isFile()).toBe(true);
  });
});
