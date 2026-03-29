/**
 * API endpoint acceptance tests for the Dockerized build feature.
 *
 * Covers:
 *  - GET /runs/:runId/container-logs — retrieve container execution logs
 *  - GET /config/queues — read queue concurrency & resource limits
 *  - PUT /config/queues — update queue config at runtime
 *  - Cross-endpoint integration (config + logs)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig } from "../src/types.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("API acceptance: Container logs endpoint", () => {
  let runsDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-api-accept-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });
    app = await createApp({
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
    });
  });

  afterEach(async () => {
    if (app?.close) await app.close();
    await fs.rm(runsDir, { recursive: true, force: true });
  });

  async function seedRun(runId: string, opts?: { containerLog?: string; featureBranch?: string }) {
    const runDir = path.join(runsDir, runId);
    await fs.mkdir(runDir, { recursive: true });
    const record: Record<string, unknown> = {
      id: runId,
      pipelineId: "test-pipeline",
      status: "completed",
      inputs: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    if (opts?.featureBranch) record.featureBranch = opts.featureBranch;
    if (opts?.containerLog !== undefined) record.containerLogFile = path.join(runDir, "container.log");
    await fs.writeFile(path.join(runDir, "run.json"), JSON.stringify(record));
    if (opts?.containerLog !== undefined) {
      await fs.writeFile(path.join(runDir, "container.log"), opts.containerLog);
    }
  }

  it("returns container log content as text/plain for valid runs", async () => {
    const logContent = "[entrypoint] Cloning repo...\n[entrypoint] npm test\n[entrypoint] Build finished\n";
    await seedRun("run-log-1", { containerLog: logContent });

    const res = await app.inject({ method: "GET", url: "/runs/run-log-1/container-logs" });

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.body).toBe(logContent);
  });

  it("returns 404 for non-existent run IDs", async () => {
    const res = await app.inject({ method: "GET", url: "/runs/nonexistent/container-logs" });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 when run exists but has no container log file", async () => {
    await seedRun("run-no-log");

    const res = await app.inject({ method: "GET", url: "/runs/run-no-log/container-logs" });

    expect(res.statusCode).toBe(404);
  });

  it("handles empty container log files gracefully", async () => {
    await seedRun("run-empty-log", { containerLog: "" });

    const res = await app.inject({ method: "GET", url: "/runs/run-empty-log/container-logs" });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
  });

  it("does not truncate large log outputs", async () => {
    const largeLog = "line output\n".repeat(5000);
    await seedRun("run-large", { containerLog: largeLog });

    const res = await app.inject({ method: "GET", url: "/runs/run-large/container-logs" });

    expect(res.statusCode).toBe(200);
    expect(res.body.length).toBe(largeLog.length);
  });

  it("enforces authentication when authToken is configured", async () => {
    await app.close();
    app = await createApp({
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
      authToken: "my-secret-token",
    });
    await seedRun("run-auth", { containerLog: "some logs" });

    // Without auth → 401
    const noAuth = await app.inject({ method: "GET", url: "/runs/run-auth/container-logs" });
    expect(noAuth.statusCode).toBe(401);

    // With valid auth → 200
    const withAuth = await app.inject({
      method: "GET",
      url: "/runs/run-auth/container-logs",
      headers: { authorization: "Bearer my-secret-token" },
    });
    expect(withAuth.statusCode).toBe(200);
    expect(withAuth.body).toBe("some logs");
  });
});

describe("API acceptance: Queue configuration endpoints", () => {
  let runsDir: string;
  let tmpHome: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let originalHome: string | undefined;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-queue-api-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });

    tmpHome = path.join(os.tmpdir(), `ripline-home-${Date.now()}`);
    await fs.mkdir(path.join(tmpHome, ".ripline"), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = tmpHome;

    app = await createApp({
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
    });
  });

  afterEach(async () => {
    if (app?.close) await app.close();
    process.env.HOME = originalHome;
    await fs.rm(runsDir, { recursive: true, force: true });
    if (tmpHome.startsWith(os.tmpdir())) {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("GET /config/queues returns configured and effective queue settings", async () => {
    const res = await app.inject({ method: "GET", url: "/config/queues" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveProperty("configured");
    expect(body).toHaveProperty("effective");
  });

  it("PUT /config/queues persists queue config with concurrency + resource limits", async () => {
    const payload = {
      queues: {
        build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
        test: { concurrency: 2, resourceLimits: { memory: "512m" } },
      },
    };

    const res = await app.inject({
      method: "PUT",
      url: "/config/queues",
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queues.build).toEqual({ concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } });
    expect(body.queues.test).toEqual({ concurrency: 2, resourceLimits: { memory: "512m" } });
    expect(body.note).toContain("restart");

    // Verify persisted to disk
    const configPath = path.join(tmpHome, ".ripline", "config.json");
    const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(saved.queues.build.concurrency).toBe(3);
    expect(saved.queues.build.resourceLimits.cpus).toBe("2");
  });

  it("PUT /config/queues enforces minimum concurrency of 1", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/config/queues",
      payload: { queues: { build: { concurrency: 0 } } },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.queues.build.concurrency).toBeGreaterThanOrEqual(1);
  });

  it("PUT /config/queues returns 400 for missing queues key", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/config/queues",
      payload: {},
    });

    expect(res.statusCode).toBe(400);
  });

  it("PUT /config/queues returns 400 for invalid queue entries", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/config/queues",
      payload: { queues: { build: "invalid" } },
    });

    expect(res.statusCode).toBe(400);
  });

  it("PUT /config/queues preserves existing config keys", async () => {
    // Seed existing config
    const configPath = path.join(tmpHome, ".ripline", "config.json");
    await fs.writeFile(configPath, JSON.stringify({
      pipelineDir: "/my/pipelines",
      containerBuild: { enabled: true, buildImage: "builder:v1" },
    }));

    await app.inject({
      method: "PUT",
      url: "/config/queues",
      payload: { queues: { build: { concurrency: 4 } } },
    });

    const saved = JSON.parse(await fs.readFile(configPath, "utf-8"));
    expect(saved.pipelineDir).toBe("/my/pipelines");
    expect(saved.containerBuild.enabled).toBe(true);
    expect(saved.queues.build.concurrency).toBe(4);
  });

  it("authentication required when authToken is configured", async () => {
    await app.close();
    app = await createApp({
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
      authToken: "secret-token",
    });

    const getRes = await app.inject({ method: "GET", url: "/config/queues" });
    expect(getRes.statusCode).toBe(401);

    const putRes = await app.inject({
      method: "PUT",
      url: "/config/queues",
      payload: { queues: { build: { concurrency: 2 } } },
    });
    expect(putRes.statusCode).toBe(401);

    // With auth → should work
    const authGet = await app.inject({
      method: "GET",
      url: "/config/queues",
      headers: { authorization: "Bearer secret-token" },
    });
    expect(authGet.statusCode).toBe(200);
  });
});
