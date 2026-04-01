import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";

const cliPath = path.join(process.cwd(), "dist", "cli", "run.js");

describe("CLI detached runs", () => {
  it("run --detach launches a background child and completes the run record", async () => {
    if (!fs.existsSync(cliPath)) return;
    const tmp = path.join(os.tmpdir(), "ripline-cli-detach-" + Date.now());
    const pipelineDir = path.join(tmp, "pipelines");
    const runsDir = path.join(tmp, "runs");
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(
      path.join(pipelineDir, "minimal.yaml"),
      `id: minimal
name: Minimal
entry: [a]
nodes:
  - id: a
    type: input
  - id: b
    type: output
    source: a
edges:
  - from: { node: a }
    to: { node: b }
`,
      "utf-8"
    );

    try {
      const runId = execFileSync(
        process.execPath,
        [cliPath, "run", "minimal", "--pipeline-dir", pipelineDir, "--runs-dir", runsDir, "--detach", "--input", '{"hello":"world"}'],
        { encoding: "utf-8", cwd: process.cwd() }
      ).trim();
      expect(runId).toMatch(/^[0-9a-f-]{36}$/);

      const runJsonPath = path.join(runsDir, runId, "run.json");
      let record: { status?: string; outputs?: Record<string, unknown> } | null = null;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (fs.existsSync(runJsonPath)) {
          record = JSON.parse(fs.readFileSync(runJsonPath, "utf-8")) as { status?: string; outputs?: Record<string, unknown> };
          if (record.status === "completed" || record.status === "errored") break;
        }
        await delay(100);
      }

      expect(record?.status).toBe("completed");
      expect(record?.outputs).toEqual({ b: { hello: "world" } });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 120000);
});
