import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { writeJsonAtomically } from "../src/lib/atomic-write.js";

describe("writeJsonAtomically", () => {
  let dir: string;

  beforeEach(async () => {
    dir = path.join(os.tmpdir(), `atomic-write-test-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("writes JSON to target path and leaves no .tmp file", async () => {
    const targetPath = path.join(dir, "run.json");
    const data = { id: "run-1", status: "pending" };
    await writeJsonAtomically(targetPath, data);

    const raw = await fs.readFile(targetPath, "utf8");
    expect(JSON.parse(raw)).toEqual(data);
    await expect(fs.access(path.join(dir, "run.json.tmp"))).rejects.toThrow(/ENOENT/);
  });

  it("overwrites existing file atomically", async () => {
    const targetPath = path.join(dir, "run.json");
    await writeJsonAtomically(targetPath, { v: 1 });
    await writeJsonAtomically(targetPath, { v: 2 });
    const raw = await fs.readFile(targetPath, "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 2 });
  });
});
