import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PipelineRunRecord } from "./types.js";

export class PipelineRunStore {
  constructor(private readonly rootDir: string) {}

  private resolvePath(runId: string): string {
    return path.join(this.rootDir, `${runId}.json`);
  }

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  async create(params: {
    pipelineId: string;
    inputs: Record<string, unknown>;
    parentRunId?: string;
  }): Promise<PipelineRunRecord> {
    const id = randomUUID();
    const now = Date.now();
    const record: PipelineRunRecord = {
      id,
      pipelineId: params.pipelineId,
      parentRunId: params.parentRunId,
      childRunIds: [],
      status: "pending",
      startedAt: now,
      updatedAt: now,
      inputs: params.inputs,
      steps: [],
    };
    await this.save(record);
    return record;
  }

  async load(runId: string): Promise<PipelineRunRecord | null> {
    try {
      const data = await fs.readFile(this.resolvePath(runId), "utf8");
      return JSON.parse(data) as PipelineRunRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async save(record: PipelineRunRecord): Promise<void> {
    record.updatedAt = Date.now();
    await fs.writeFile(this.resolvePath(record.id), JSON.stringify(record, null, 2), "utf8");
  }

  async list(): Promise<PipelineRunRecord[]> {
    const files = await fs.readdir(this.rootDir).catch(() => []);
    const runs: PipelineRunRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const run = await this.load(path.basename(file, ".json"));
      if (run) runs.push(run);
    }
    return runs.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
