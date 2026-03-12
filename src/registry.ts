import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import { pipelineDefinitionSchema } from "./schema.js";
import type { PipelineDefinition, PipelineRegistryEntry } from "./types.js";

export class PipelineRegistry {
  private readonly cache = new Map<string, PipelineRegistryEntry>();
  private readonly validator = new Ajv({ allErrors: true, allowUnionTypes: true });
  private readonly compiledSchema = pipelineDefinitionSchema;

  constructor(private readonly pipelinesDir: string) {}

  async refresh(): Promise<void> {
    const entries = await fs.readdir(this.pipelinesDir).catch(() => [] as string[]);
    const seen = new Set<string>();
    for (const file of entries) {
      if (file.startsWith('.')) continue;
      if (file === 'ripline.config.json') continue;
      if (!/[.](ya?ml|json)$/i.test(file)) continue;
      const fullPath = path.join(this.pipelinesDir, file);
      const stat = await fs.stat(fullPath).catch(() => null);
      if (!stat) continue;
      seen.add(fullPath);
      const cached = this.cache.get(fullPath);
      if (cached && cached.mtimeMs === stat.mtimeMs) continue;
      const raw = await fs.readFile(fullPath, "utf8");
      const parsed = this.parseFile(raw, file);
      const definition = this.compiledSchema.parse(parsed) as PipelineDefinition;
      this.cache.set(fullPath, { definition, mtimeMs: stat.mtimeMs, path: fullPath });
    }
    // Remove old entries
    for (const [key] of this.cache) {
      if (!seen.has(key)) {
        this.cache.delete(key);
      }
    }
  }

  async list(): Promise<PipelineDefinition[]> {
    await this.refresh();
    return Array.from(this.cache.values()).map((entry) => entry.definition);
  }

  async get(id: string): Promise<PipelineRegistryEntry | null> {
    await this.refresh();
    for (const entry of this.cache.values()) {
      if (entry.definition.id === id) {
        return entry;
      }
    }
    return null;
  }

  private parseFile(raw: string, fileName: string): unknown {
    if (/[.]ya?ml$/i.test(fileName)) {
      return parseYaml(raw);
    }
    return JSON.parse(raw);
  }

  compileContract(schema: unknown): ValidateFunction | null {
    if (!schema || typeof schema !== "object") return null;
    try {
      return this.validator.compile(schema);
    } catch (err) {
      throw new Error(`Invalid JSON schema contract: ${(err as Error).message}`);
    }
  }
}
