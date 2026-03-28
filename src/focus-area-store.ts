import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeJsonAtomically } from "./lib/atomic-write.js";

// ─── Types ───────────────────────────────────────────────

export type FocusArea = {
  id: string;
  name: string;
  description?: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
};

export type Epic = {
  id: string;
  focusAreaId: string;
  name: string;
  description?: string;
  status: "draft" | "active" | "done" | "archived";
  storyIds: string[];
  createdAt: string;
  updatedAt: string;
};

type StoreData = {
  focusAreas: FocusArea[];
  epics: Epic[];
};

// ─── Store ───────────────────────────────────────────────

export class FocusAreaStore {
  private data: StoreData = { focusAreas: [], epics: [] };
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      this.data = JSON.parse(raw) as StoreData;
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        this.data = { focusAreas: [], epics: [] };
      } else {
        throw err;
      }
    }
    this.loaded = true;
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await writeJsonAtomically(this.filePath, this.data);
  }

  // ─── Focus Areas ────────────────────────────────────────

  async listFocusAreas(): Promise<FocusArea[]> {
    await this.ensureLoaded();
    return this.data.focusAreas;
  }

  async getFocusArea(id: string): Promise<FocusArea | undefined> {
    await this.ensureLoaded();
    return this.data.focusAreas.find((fa) => fa.id === id);
  }

  async createFocusArea(input: { name: string; description?: string }): Promise<FocusArea> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const fa: FocusArea = {
      id: randomUUID(),
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.data.focusAreas.push(fa);
    await this.persist();
    return fa;
  }

  async updateFocusArea(id: string, patch: Partial<Pick<FocusArea, "name" | "description" | "status">>): Promise<FocusArea | null> {
    await this.ensureLoaded();
    const fa = this.data.focusAreas.find((f) => f.id === id);
    if (!fa) return null;
    if (patch.name !== undefined) fa.name = patch.name;
    if (patch.description !== undefined) fa.description = patch.description;
    if (patch.status !== undefined) fa.status = patch.status;
    fa.updatedAt = new Date().toISOString();
    await this.persist();
    return fa;
  }

  async deleteFocusArea(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const idx = this.data.focusAreas.findIndex((f) => f.id === id);
    if (idx === -1) return false;
    this.data.focusAreas.splice(idx, 1);
    // Also remove epics linked to this focus area
    this.data.epics = this.data.epics.filter((e) => e.focusAreaId !== id);
    await this.persist();
    return true;
  }

  // ─── Epics ──────────────────────────────────────────────

  async listEpics(): Promise<Epic[]> {
    await this.ensureLoaded();
    return this.data.epics;
  }

  async getEpic(id: string): Promise<Epic | undefined> {
    await this.ensureLoaded();
    return this.data.epics.find((e) => e.id === id);
  }

  async createEpic(input: { focusAreaId: string; name: string; description?: string }): Promise<Epic | null> {
    await this.ensureLoaded();
    // Validate focus area exists
    const fa = this.data.focusAreas.find((f) => f.id === input.focusAreaId);
    if (!fa) return null;
    const now = new Date().toISOString();
    const epic: Epic = {
      id: randomUUID(),
      focusAreaId: input.focusAreaId,
      name: input.name,
      ...(input.description !== undefined && { description: input.description }),
      status: "draft",
      storyIds: [],
      createdAt: now,
      updatedAt: now,
    };
    this.data.epics.push(epic);
    await this.persist();
    return epic;
  }

  async updateEpic(id: string, patch: Partial<Pick<Epic, "name" | "description" | "status" | "focusAreaId">>): Promise<Epic | null> {
    await this.ensureLoaded();
    const epic = this.data.epics.find((e) => e.id === id);
    if (!epic) return null;
    if (patch.focusAreaId !== undefined) {
      const fa = this.data.focusAreas.find((f) => f.id === patch.focusAreaId);
      if (!fa) return null;
      epic.focusAreaId = patch.focusAreaId;
    }
    if (patch.name !== undefined) epic.name = patch.name;
    if (patch.description !== undefined) epic.description = patch.description;
    if (patch.status !== undefined) epic.status = patch.status;
    epic.updatedAt = new Date().toISOString();
    await this.persist();
    return epic;
  }

  async deleteEpic(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const idx = this.data.epics.findIndex((e) => e.id === id);
    if (idx === -1) return false;
    this.data.epics.splice(idx, 1);
    await this.persist();
    return true;
  }

  async getEpicsByFocusArea(focusAreaId: string): Promise<Epic[]> {
    await this.ensureLoaded();
    return this.data.epics.filter((e) => e.focusAreaId === focusAreaId);
  }

  async updateEpicStories(id: string, add: string[], remove: string[]): Promise<Epic | null> {
    await this.ensureLoaded();
    const epic = this.data.epics.find((e) => e.id === id);
    if (!epic) return null;
    // Remove first, then add (dedup)
    epic.storyIds = epic.storyIds.filter((sid) => !remove.includes(sid));
    for (const sid of add) {
      if (!epic.storyIds.includes(sid)) {
        epic.storyIds.push(sid);
      }
    }
    epic.updatedAt = new Date().toISOString();
    await this.persist();
    return epic;
  }
}
