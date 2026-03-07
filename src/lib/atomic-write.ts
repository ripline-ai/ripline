import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Write JSON to a file atomically: write to `<targetPath>.tmp` then rename into place.
 * Readers never see half-written JSON.
 */
export async function writeJsonAtomically(targetPath: string, data: unknown): Promise<void> {
  const tmpPath = `${targetPath}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, json, "utf8");
  await fs.rename(tmpPath, targetPath);
}
