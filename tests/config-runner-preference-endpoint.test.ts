import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig } from "../src/types.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("Runner preference API endpoints", () => {
  let runsDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let originalHome: string | undefined;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-runner-pref-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });

    originalHome = process.env.HOME;
    process.env.HOME = path.join(os.tmpdir(), `ripline-home-${Date.now()}`);
    await fs.mkdir(path.join(process.env.HOME, ".ripline"), { recursive: true });

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
    const tmpHome = process.env.HOME;
    process.env.HOME = originalHome;
    await fs.rm(runsDir, { recursive: true, force: true });
    if (tmpHome && tmpHome.startsWith(os.tmpdir())) {
      await fs.rm(tmpHome, { recursive: true, force: true });
    }
  });

  it("GET /config/runner-preference returns default codex", async () => {
    const res = await app.inject({ method: "GET", url: "/config/runner-preference" });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { preferredRunner: string; available: string[] };
    expect(body.preferredRunner).toBe("codex");
    expect(body.available).toEqual(["codex", "claude-code"]);
  });

  it("PUT /config/runner-preference persists claude-code", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/config/runner-preference",
      payload: { preferredRunner: "claude-code" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { preferredRunner: string; note: string };
    expect(body.preferredRunner).toBe("claude-code");

    const configPath = path.join(process.env.HOME!, ".ripline", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const saved = JSON.parse(raw) as { preferredRunner?: string };
    expect(saved.preferredRunner).toBe("claude-code");

    const check = await app.inject({ method: "GET", url: "/config/runner-preference" });
    expect(check.statusCode).toBe(200);
    expect((check.json() as { preferredRunner: string }).preferredRunner).toBe("claude-code");
  });

  it("accepts claude alias and normalizes to claude-code", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/config/runner-preference",
      payload: { preferredRunner: "claude" },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { preferredRunner: string }).preferredRunner).toBe("claude-code");
  });

  it("returns 400 on invalid preferredRunner", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/config/runner-preference",
      payload: { preferredRunner: "invalid-runner" },
    });

    expect(res.statusCode).toBe(400);
  });

  it("preserves other config keys when updating preferredRunner", async () => {
    const configPath = path.join(process.env.HOME!, ".ripline", "config.json");
    await fs.writeFile(configPath, JSON.stringify({
      backgroundQueue: { enabled: true, maxRetries: 5 },
      pipelineDir: "/tmp/pipelines",
    }));

    const res = await app.inject({
      method: "PUT",
      url: "/config/runner-preference",
      payload: { preferredRunner: "codex" },
    });
    expect(res.statusCode).toBe(200);

    const raw = await fs.readFile(configPath, "utf-8");
    const saved = JSON.parse(raw) as Record<string, unknown>;
    expect(saved.pipelineDir).toBe("/tmp/pipelines");
    expect(saved.backgroundQueue).toEqual({ enabled: true, maxRetries: 5 });
    expect(saved.preferredRunner).toBe("codex");
  });

  it("enforces auth when authToken is configured", async () => {
    await app.close();
    app = await createApp({
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
      authToken: "secret",
    });

    const getRes = await app.inject({ method: "GET", url: "/config/runner-preference" });
    expect(getRes.statusCode).toBe(401);

    const putRes = await app.inject({
      method: "PUT",
      url: "/config/runner-preference",
      payload: { preferredRunner: "codex" },
    });
    expect(putRes.statusCode).toBe(401);
  });
});
