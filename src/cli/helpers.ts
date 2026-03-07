import path from "node:path";
import fs from "node:fs/promises";

/** Load inputs from inline JSON string or file path. */
export async function loadInputs(value: string): Promise<Record<string, unknown>> {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
  const absolutePath = path.resolve(trimmed);
  const raw = await fs.readFile(absolutePath, "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Parse KEY=value pairs from --env options into a single object. */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq === -1) {
      env[pair] = "";
    } else {
      env[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
  }
  return env;
}
