import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { ZodIssue } from "zod";
import { pipelineDefinitionSchema } from "../../schema.js";
import type { PipelineDefinition } from "../../types.js";

const cache = new Map<string, { definition: PipelineDefinition; mtimeMs: number }>();

function formatZodIssues(issues: ZodIssue[]): string {
  return issues
    .map((issue) => {
      const pathStr = issue.path.length ? ` at ${issue.path.join(".")}` : "";
      return `${issue.message}${pathStr}`;
    })
    .join("; ");
}

/**
 * Load and validate a pipeline definition from a YAML or JSON file.
 * Caches results keyed by absolute path + mtime to avoid re-reading unchanged files.
 * @param filePath - Path to .yaml, .yml, or .json file
 * @returns Validated PipelineDefinition
 * @throws Error with message including file path and validation details (e.g. node id)
 */
export function loadPipelineDefinition(filePath: string): PipelineDefinition {
  const absolutePath = path.resolve(filePath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile()) {
    throw new Error(`Pipeline file not found: ${absolutePath}`);
  }
  const cached = cache.get(absolutePath);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.definition;
  }

  const raw = fs.readFileSync(absolutePath, "utf-8");
  let parsed: unknown;
  if (absolutePath.endsWith(".yaml") || absolutePath.endsWith(".yml")) {
    parsed = YAML.parse(raw);
  } else if (absolutePath.endsWith(".json")) {
    parsed = JSON.parse(raw);
  } else {
    throw new Error(
      `Unsupported pipeline format: ${absolutePath} (use .yaml, .yml, or .json)`
    );
  }

  const result = pipelineDefinitionSchema.safeParse(parsed);
  if (result.success) {
    const definition = result.data;
    cache.set(absolutePath, { definition, mtimeMs: stat.mtimeMs });
    return definition;
  }

  const detail = formatZodIssues(result.error.issues);
  const fileName = path.basename(absolutePath);
  throw new Error(`${fileName}: ${detail}`);
}
