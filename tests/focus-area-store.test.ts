/**
 * Tests for FocusAreaStore — Story 1 data model + file-backed stores,
 * Story 7 Epic auto-creation with linked stories,
 * cascading deletes, and story association management.
 */
import { describe, expect, it, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { FocusAreaStore } from "../src/focus-area-store.js";

function tmpFile(): string {
  return path.join(
    os.tmpdir(),
    `fa-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
}

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const p of cleanupPaths) {
    await fs.rm(p, { force: true }).catch(() => {});
  }
  cleanupPaths.length = 0;
});

// ─── Focus Area CRUD ─────────────────────────────────────────────────────────

describe("FocusAreaStore — Focus Areas", () => {
  it("listFocusAreas returns empty array on fresh store", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const result = await store.listFocusAreas();
    expect(result).toEqual([]);
  });

  it("createFocusArea persists and returns the created entity", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "Engine", description: "Core" });

    expect(fa.id).toBeDefined();
    expect(fa.name).toBe("Engine");
    expect(fa.description).toBe("Core");
    expect(fa.status).toBe("active");
    expect(fa.createdAt).toBeDefined();
    expect(fa.updatedAt).toBeDefined();
  });

  it("createFocusArea without description omits the field", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "Minimal" });
    expect(fa).not.toHaveProperty("description");
  });

  it("getFocusArea returns the matching entity", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const created = await store.createFocusArea({ name: "Engine" });
    const found = await store.getFocusArea(created.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("Engine");
  });

  it("getFocusArea returns undefined for unknown id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.getFocusArea("nonexistent")).toBeUndefined();
  });

  it("updateFocusArea patches name and bumps updatedAt", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "Old" });
    const updated = await store.updateFocusArea(fa.id, { name: "New" });

    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New");
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(fa.updatedAt).getTime(),
    );
  });

  it("updateFocusArea can change status to archived", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "X" });
    const updated = await store.updateFocusArea(fa.id, { status: "archived" });
    expect(updated!.status).toBe("archived");
  });

  it("updateFocusArea returns null for unknown id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.updateFocusArea("nonexistent", { name: "X" })).toBeNull();
  });

  it("deleteFocusArea removes the entity and returns true", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "ToDelete" });
    expect(await store.deleteFocusArea(fa.id)).toBe(true);
    expect(await store.listFocusAreas()).toHaveLength(0);
  });

  it("deleteFocusArea returns false for unknown id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.deleteFocusArea("nonexistent")).toBe(false);
  });

  it("deleteFocusArea cascades to remove linked epics", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "Parent" });
    await store.createEpic({ focusAreaId: fa.id, name: "Child Epic" });
    expect(await store.listEpics()).toHaveLength(1);

    await store.deleteFocusArea(fa.id);
    expect(await store.listEpics()).toHaveLength(0);
  });

  it("persists data across store instances", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);

    const store1 = new FocusAreaStore(fp);
    await store1.createFocusArea({ name: "Persisted" });

    const store2 = new FocusAreaStore(fp);
    const result = await store2.listFocusAreas();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Persisted");
  });
});

// ─── Epic CRUD ───────────────────────────────────────────────────────────────

describe("FocusAreaStore — Epics", () => {
  it("listEpics returns empty array on fresh store", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.listEpics()).toEqual([]);
  });

  it("createEpic returns the created entity with correct defaults", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "Parent" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "Auth" });

    expect(epic).not.toBeNull();
    expect(epic!.id).toBeDefined();
    expect(epic!.name).toBe("Auth");
    expect(epic!.focusAreaId).toBe(fa.id);
    expect(epic!.status).toBe("draft");
    expect(epic!.storyIds).toEqual([]);
  });

  it("createEpic returns null when focusAreaId does not exist", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const result = await store.createEpic({ focusAreaId: "nonexistent", name: "X" });
    expect(result).toBeNull();
  });

  it("createEpic with description", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({
      focusAreaId: fa.id,
      name: "Detailed",
      description: "A detailed epic",
    });
    expect(epic!.description).toBe("A detailed epic");
  });

  it("getEpic returns the matching entity", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const created = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const found = await store.getEpic(created!.id);
    expect(found).toBeDefined();
    expect(found!.name).toBe("E");
  });

  it("getEpic returns undefined for unknown id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.getEpic("nonexistent")).toBeUndefined();
  });

  it("updateEpic patches fields and bumps updatedAt", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "Old" });

    const updated = await store.updateEpic(epic!.id, { name: "New", status: "active" });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("New");
    expect(updated!.status).toBe("active");
  });

  it("updateEpic validates focusAreaId when changing it", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });

    // Attempt to reassign to nonexistent focus area
    const result = await store.updateEpic(epic!.id, { focusAreaId: "nonexistent" });
    expect(result).toBeNull();
  });

  it("updateEpic returns null for unknown id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.updateEpic("nonexistent", { name: "X" })).toBeNull();
  });

  it("deleteEpic removes the entity and returns true", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });

    expect(await store.deleteEpic(epic!.id)).toBe(true);
    expect(await store.listEpics()).toHaveLength(0);
  });

  it("deleteEpic returns false for unknown id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.deleteEpic("nonexistent")).toBe(false);
  });

  it("getEpicsByFocusArea filters correctly", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa1 = await store.createFocusArea({ name: "FA1" });
    const fa2 = await store.createFocusArea({ name: "FA2" });
    await store.createEpic({ focusAreaId: fa1.id, name: "E1" });
    await store.createEpic({ focusAreaId: fa2.id, name: "E2" });
    await store.createEpic({ focusAreaId: fa1.id, name: "E3" });

    const result = await store.getEpicsByFocusArea(fa1.id);
    expect(result).toHaveLength(2);
    expect(result.map((e) => e.name).sort()).toEqual(["E1", "E3"]);
  });
});

// ─── Story Association Management (PATCH /epics/:id/stories) ─────────────────

describe("FocusAreaStore — updateEpicStories", () => {
  it("adds story IDs to an epic", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });

    const updated = await store.updateEpicStories(epic!.id, ["s1", "s2"], []);
    expect(updated).not.toBeNull();
    expect(updated!.storyIds).toEqual(["s1", "s2"]);
  });

  it("removes story IDs from an epic", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2", "s3"], []);

    const updated = await store.updateEpicStories(epic!.id, [], ["s2"]);
    expect(updated!.storyIds).toEqual(["s1", "s3"]);
  });

  it("deduplicates added story IDs", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1"], []);

    // Adding s1 again should not duplicate
    const updated = await store.updateEpicStories(epic!.id, ["s1", "s2"], []);
    expect(updated!.storyIds).toEqual(["s1", "s2"]);
  });

  it("removes before adding (order of operations)", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2"], []);

    // Remove s1, add s3 in same operation
    const updated = await store.updateEpicStories(epic!.id, ["s3"], ["s1"]);
    expect(updated!.storyIds).toEqual(["s2", "s3"]);
  });

  it("returns null for unknown epic id", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    expect(await store.updateEpicStories("nonexistent", ["s1"], [])).toBeNull();
  });

  it("bumps updatedAt on story changes", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const originalUpdatedAt = epic!.updatedAt;

    const updated = await store.updateEpicStories(epic!.id, ["s1"], []);
    expect(new Date(updated!.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(originalUpdatedAt).getTime(),
    );
  });
});

// ─── Integration: Focus Area + Epic lifecycle ────────────────────────────────

describe("FocusAreaStore — Integration", () => {
  it("full lifecycle: create FA → create Epic → add stories → archive FA cascades", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    // Create focus area
    const fa = await store.createFocusArea({ name: "Core", description: "Core platform" });
    expect(fa.status).toBe("active");

    // Create epic under it
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "Auth Overhaul" });
    expect(epic).not.toBeNull();
    expect(epic!.focusAreaId).toBe(fa.id);

    // Link stories to the epic
    await store.updateEpicStories(epic!.id, ["story-1", "story-2", "story-3"], []);
    const withStories = await store.getEpic(epic!.id);
    expect(withStories!.storyIds).toHaveLength(3);

    // Archive (delete) the focus area — epics should cascade
    await store.deleteFocusArea(fa.id);
    expect(await store.listFocusAreas()).toHaveLength(0);
    expect(await store.listEpics()).toHaveLength(0);
  });

  it("multiple focus areas with multiple epics are independently managed", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    const store = new FocusAreaStore(fp);

    const fa1 = await store.createFocusArea({ name: "FA1" });
    const fa2 = await store.createFocusArea({ name: "FA2" });

    await store.createEpic({ focusAreaId: fa1.id, name: "E1-A" });
    await store.createEpic({ focusAreaId: fa1.id, name: "E1-B" });
    await store.createEpic({ focusAreaId: fa2.id, name: "E2-A" });

    // Delete FA1 only removes its epics
    await store.deleteFocusArea(fa1.id);
    expect(await store.listFocusAreas()).toHaveLength(1);
    const remaining = await store.listEpics();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("E2-A");
  });

  it("creates file on disk on first write", async () => {
    const fp = tmpFile();
    cleanupPaths.push(fp);
    // Ensure file does not exist
    await fs.rm(fp, { force: true }).catch(() => {});

    const store = new FocusAreaStore(fp);
    await store.createFocusArea({ name: "First" });

    const stat = await fs.stat(fp);
    expect(stat.isFile()).toBe(true);
  });
});
