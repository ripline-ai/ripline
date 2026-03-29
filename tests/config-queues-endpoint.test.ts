import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig } from "../src/types.js";

/**
 * Tests for GET /config/queues and PUT /config/queues API endpoints.
 *
 * Story 5 (Add concurrency configuration to build queue) added API
 * endpoints for reading and updating per-queue concurrency and resource
 * limits at runtime.
 *
 * Acceptance criteria:
 *  - GET returns configured and effective queue settings
 *  - PUT validates input and persists queue config to disk
 *  - PUT enforces minimum concurrency of 1
 *  - PUT returns 400 on invalid input
 *  - Changes take effect on next restart (documented via response note)
 *  - Authentication is enforced when authToken is configured
 */

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("Queue configuration API endpoints", () => {
  let runsDir: string;
  let app: Awaited<ReturnType<typeof createApp>>;
  let originalHome: string | undefined;

  beforeEach(async () => {
    runsDir = path.join(os.tmpdir(), `ripline-queues-api-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });

    // Set HOME to a temp dir so PUT writes to a temp config instead of real config
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

  /* ── GET /config/queues ─────────────────────────────────────────────── */

  describe("GET /config/queues", () => {
    it("returns 200 with configured and effective queue settings", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/config/queues",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { configured: Record<string, unknown>; effective: Record<string, unknown> };
      expect(body).toHaveProperty("configured");
      expect(body).toHaveProperty("effective");
    });

    it("returns empty configured queues when no queues are set", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/config/queues",
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { configured: Record<string, unknown> };
      expect(typeof body.configured).toBe("object");
    });
  });

  /* ── PUT /config/queues ─────────────────────────────────────────────── */

  describe("PUT /config/queues", () => {
    it("persists queue configuration to disk", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
            test: { concurrency: 2 },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, unknown>; note: string };
      expect(body.queues).toBeDefined();
      expect(body.queues.build).toEqual({
        concurrency: 3,
        resourceLimits: { cpus: "2", memory: "4g" },
      });
      expect(body.queues.test).toEqual({ concurrency: 2 });
      expect(body.note).toContain("restart");

      // Verify file was written
      const configPath = path.join(process.env.HOME!, ".ripline", "config.json");
      const raw = await fs.readFile(configPath, "utf-8");
      const saved = JSON.parse(raw) as { queues: Record<string, unknown> };
      expect(saved.queues).toBeDefined();
      expect(saved.queues.build).toEqual({
        concurrency: 3,
        resourceLimits: { cpus: "2", memory: "4g" },
      });
    });

    it("enforces minimum concurrency of 1", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            build: { concurrency: 0 },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, { concurrency: number }> };
      expect(body.queues.build.concurrency).toBe(1);
    });

    it("defaults concurrency to 1 when not provided", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            build: {},
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, { concurrency: number }> };
      expect(body.queues.build.concurrency).toBe(1);
    });

    it("returns 400 when queues is missing from body", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = res.json() as { error: string };
      expect(body.error).toBe("Bad Request");
    });

    it("returns 400 when queues is not an object", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: { queues: "invalid" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when a queue entry is not an object", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: { queues: { build: "invalid" } },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json() as { message: string };
      expect(body.message).toContain("build");
    });

    it("omits resourceLimits when not provided in queue entry", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            deploy: { concurrency: 1 },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, { concurrency: number; resourceLimits?: unknown }> };
      expect(body.queues.deploy.resourceLimits).toBeUndefined();
    });

    it("handles partial resource limits (cpus only)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            build: { concurrency: 2, resourceLimits: { cpus: "1.5" } },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, { resourceLimits?: { cpus?: string; memory?: string } }> };
      expect(body.queues.build.resourceLimits).toEqual({ cpus: "1.5" });
    });

    it("handles partial resource limits (memory only)", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            build: { concurrency: 2, resourceLimits: { memory: "2g" } },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, { resourceLimits?: { cpus?: string; memory?: string } }> };
      expect(body.queues.build.resourceLimits).toEqual({ memory: "2g" });
    });

    it("preserves existing config keys when updating queues", async () => {
      // Write some existing config
      const configPath = path.join(process.env.HOME!, ".ripline", "config.json");
      await fs.writeFile(configPath, JSON.stringify({
        pipelineDir: "/my/pipelines",
        backgroundQueue: { enabled: true, maxRetries: 5 },
      }));

      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: { build: { concurrency: 4 } },
        },
      });

      expect(res.statusCode).toBe(200);

      const raw = await fs.readFile(configPath, "utf-8");
      const saved = JSON.parse(raw) as Record<string, unknown>;
      expect(saved.pipelineDir).toBe("/my/pipelines");
      expect(saved.backgroundQueue).toEqual({ enabled: true, maxRetries: 5 });
      expect(saved.queues).toBeDefined();
    });

    it("floors fractional concurrency values", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: {
          queues: {
            build: { concurrency: 3.7 },
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json() as { queues: Record<string, { concurrency: number }> };
      expect(body.queues.build.concurrency).toBe(3);
    });
  });

  /* ── Authentication ──────────────────────────────────────────────────── */

  describe("authentication", () => {
    it("returns 401 for GET /config/queues when authToken is set and no auth header", async () => {
      await app.close();
      app = await createApp({
        pipelinesDir: fixturesDir,
        httpPath: "/",
        httpPort: 4001,
        runsDir,
        authToken: "secret",
      });

      const res = await app.inject({
        method: "GET",
        url: "/config/queues",
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 401 for PUT /config/queues when authToken is set and no auth header", async () => {
      await app.close();
      app = await createApp({
        pipelinesDir: fixturesDir,
        httpPath: "/",
        httpPort: 4001,
        runsDir,
        authToken: "secret",
      });

      const res = await app.inject({
        method: "PUT",
        url: "/config/queues",
        payload: { queues: { build: { concurrency: 2 } } },
      });
      expect(res.statusCode).toBe(401);
    });
  });
});
