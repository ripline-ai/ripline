import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig } from "../src/types.js";

/**
 * Tests for GET /runs/:runId/container-logs endpoint.
 *
 * Story 4 (Integrate container execution into Ripline build queue) added
 * a new API endpoint to retrieve container execution logs in plain text.
 *
 * Acceptance criteria:
 *  - Returns container.log content as text/plain for a valid run with logs
 *  - Returns 404 when the run does not exist
 *  - Returns 404 when the run exists but has no container log file
 *  - Requires authentication when authToken is configured
 */

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("GET /runs/:runId/container-logs", () => {
  let runsDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-container-logs-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });
    const config: PipelinePluginConfig = {
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
    };
    app = await createApp(config);
  });

  afterEach(async () => {
    if (app?.close) await app.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  async function seedRun(runId: string, opts?: { containerLog?: string }) {
    const runDir = path.join(runsDir, runId);
    await fs.mkdir(runDir, { recursive: true });
    const record = {
      id: runId,
      pipelineId: "build_from_plan",
      status: "completed",
      inputs: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(record));
    if (opts?.containerLog !== undefined) {
      await fs.writeFile(path.join(runDir, "container.log"), opts.containerLog);
    }
  }

  it("returns container log content as text/plain", async () => {
    const logContent = "[entrypoint] Cloning repo...\n[entrypoint] Build finished successfully\n";
    await seedRun("run-with-logs", { containerLog: logContent });

    const res = await app.inject({
      method: "GET",
      url: "/runs/run-with-logs/container-logs",
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe(logContent);
  });

  it("returns 404 when run does not exist", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/runs/nonexistent-run/container-logs",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.error).toBe("Not Found");
    expect(body.message).toContain("nonexistent-run");
  });

  it("returns 404 when run exists but has no container log", async () => {
    await seedRun("run-no-container-log");

    const res = await app.inject({
      method: "GET",
      url: "/runs/run-no-container-log/container-logs",
    });

    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; message: string };
    expect(body.message).toContain("No container logs");
  });

  it("returns empty string for an empty container log file", async () => {
    await seedRun("run-empty-log", { containerLog: "" });

    const res = await app.inject({
      method: "GET",
      url: "/runs/run-empty-log/container-logs",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  it("returns large container logs without truncation", async () => {
    const largeLogs = "line\n".repeat(10_000);
    await seedRun("run-large-logs", { containerLog: largeLogs });

    const res = await app.inject({
      method: "GET",
      url: "/runs/run-large-logs/container-logs",
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(largeLogs);
  });

  it("requires authentication when authToken is configured", async () => {
    await app.close();
    const config: PipelinePluginConfig = {
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
      authToken: "test-secret",
    };
    app = await createApp(config);

    await seedRun("run-auth-test", { containerLog: "log data" });

    // No auth header → 401
    const unauthRes = await app.inject({
      method: "GET",
      url: "/runs/run-auth-test/container-logs",
    });
    expect(unauthRes.statusCode).toBe(401);

    // With auth header → 200
    const authRes = await app.inject({
      method: "GET",
      url: "/runs/run-auth-test/container-logs",
      headers: { authorization: "Bearer test-secret" },
    });
    expect(authRes.statusCode).toBe(200);
    expect(authRes.body).toBe("log data");
  });
});
