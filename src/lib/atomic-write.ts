import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Write JSON to a file atomically: write to `<targetPath>.<random>.tmp` then rename into place.
 * The unique suffix prevents concurrent writers from clobbering each other's temp files.
 * Readers never see half-written JSON.
 */
export async function writeJsonAtomically(targetPath: string, data: unknown): Promise<void> {
  const tmpPath = `${targetPath}.${randomBytes(6).toString("hex")}.tmp`;
  const json = JSON.stringify(data, null, 2);
  await fs.writeFile(tmpPath, json, "utf8");
  await fs.rename(tmpPath, targetPath);
}
