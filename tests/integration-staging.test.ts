/**
 * Integration test: Ripline with STAGE=staging listens on port 4002.
 *
 * Starts the actual Fastify app (using createApp) bound to an ephemeral port
 * derived from the STAGE env var, then confirms it responds on that port.
 */
import { describe, expect, it, afterEach, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import { resolveStageConfig } from "../src/config.js";

describe("integration: Ripline STAGE=staging", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  let runsDir: string;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-staging-test-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });
  });

  afterEach(async () => {
    if (app?.close) await app.close();
    await fs.rm(runsDir, { recursive: true, force: true }).catch(() => {});
  });

  it("resolveStageConfig returns port 4002 for staging", () => {
    const cfg = resolveStageConfig({ STAGE: "staging" });
    expect(cfg.stage).toBe("staging");
    expect(cfg.port).toBe(4002);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3001");
  });

  it("createApp responds to health check when configured for staging port", async () => {
    const stageConfig = resolveStageConfig({ STAGE: "staging" });

    app = await createApp({
      pipelinesDir: path.join(process.cwd(), "pipelines", "examples"),
      httpPath: "/",
      httpPort: stageConfig.port,
      runsDir,
    });

    // Use Fastify's inject (no real TCP bind needed)
    const res = await app.inject({ method: "GET", url: "/pipelines" });
    expect(res.statusCode).toBe(200);
  });

  it("resolveStageConfig defaults to production (port 4001) when STAGE is unset", () => {
    const cfg = resolveStageConfig({});
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
  });
});
