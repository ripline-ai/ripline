import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createApp } from "../src/server.js";
import type { PipelinePluginConfig } from "../src/types.js";
import type { AgentRunner } from "../src/pipeline/executors/agent.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("HTTP server", () => {
  let config: PipelinePluginConfig;
  let app: Awaited<ReturnType<typeof createApp>>;

  beforeEach(async () => {
    const runsDir = path.join(os.tmpdir(), `ripline-server-test-${Date.now()}`);
    await fs.mkdir(runsDir, { recursive: true });
    config = {
      pipelinesDir: fixturesDir,
      httpPath: "/",
      httpPort: 4001,
      runsDir,
    };
    app = await createApp(config);
  });

  afterEach(async () => {
    if (app?.close) await app.close();
  });

  describe("GET /pipelines", () => {
    it("returns list of pipeline definitions with id, name, tags", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/pipelines",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { pipelines: { id: string; name?: string; tags?: string[] }[] };
      expect(Array.isArray(body.pipelines)).toBe(true);
      const ripline = body.pipelines.find((p) => p.id === "ripline-area-owner");
      expect(ripline).toBeDefined();
      expect(ripline!.name).toBeDefined();
      expect(ripline!.id).toBe("ripline-area-owner");
    });

    it("returns 401 when authToken is set and Authorization header is missing", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({ method: "GET", url: "/pipelines" });
      expect(res.statusCode).toBe(401);
    });

    it("returns 200 when authToken is set and Bearer token is valid", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({
        method: "GET",
        url: "/pipelines",
        headers: { authorization: "Bearer secret" },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe("POST /pipelines/:id/run", () => {
    it("returns runId and triggers execution", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { runId: string };
      expect(body.runId).toBeDefined();
      expect(typeof body.runId).toBe("string");
    });

    it("writes run artifacts to the configured runsDir", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(202);
      const { runId } = res.json() as { runId: string };
      const runDir = path.join(config.runsDir!, runId);
      const runFile = path.join(runDir, "run.json");
      await expect(fs.access(runDir)).resolves.toBeUndefined();
      await expect(fs.access(runFile)).resolves.toBeUndefined();
      const data = JSON.parse(await fs.readFile(runFile, "utf8")) as { id: string; pipelineId: string };
      expect(data.id).toBe(runId);
      expect(data.pipelineId).toBe("ripline-area-owner");
    });

    it("accepts optional inputs and env in body", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: { inputs: { foo: "bar" }, env: { FOO: "BAR" } },
      });
      expect(res.statusCode).toBe(202);
      const body = res.json() as { runId: string };
      expect(body.runId).toBeDefined();
    });

    it("returns 404 for unknown pipeline id", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/nonexistent-pipeline/run",
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    it("returns 401 when authToken is set and no Bearer token", async () => {
      await app.close();
      app = await createApp({ ...config, authToken: "secret" });
      const res = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /runs/:runId", () => {
    it("returns run record with node-by-node status", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const getRes = await app.inject({
        method: "GET",
        url: `/runs/${runId}`,
      });
      expect(getRes.statusCode).toBe(200);
      const record = getRes.json() as {
        id: string;
        pipelineId: string;
        status: string;
        steps: { nodeId: string; status: string }[];
      };
      expect(record.id).toBe(runId);
      expect(record.pipelineId).toBe("ripline-area-owner");
      expect(record.steps).toBeDefined();
      expect(Array.isArray(record.steps)).toBe(true);
    });

    it("returns 404 for unknown runId", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/runs/00000000-0000-0000-0000-000000000000",
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /metrics (when maxConcurrency > 0)", () => {
    it("returns queue depth, active workers, and avg duration", async () => {
      await app.close();
      app = await createApp({ ...config, maxConcurrency: 1 });
      const res = await app.inject({ method: "GET", url: "/metrics" });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { queueDepth: number; activeWorkers: number };
      expect(typeof body.queueDepth).toBe("number");
      expect(typeof body.activeWorkers).toBe("number");
    });
  });

  describe("GET /runs/:runId/stream", () => {
    it("returns SSE stream with node updates", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      const { runId } = runRes.json() as { runId: string };

      const streamRes = await app.inject({
        method: "GET",
        url: `/runs/${runId}/stream`,
      });
      expect(streamRes.statusCode).toBe(200);
      expect(streamRes.headers["content-type"]).toMatch(/text\/event-stream/);
      const body = streamRes.payload as string;
      expect(body).toContain("data:");
      expect(body).toContain("id");
      expect(body).toContain("steps");
    });
  });

  describe("run-store integrity under concurrent load/save", () => {
    it("GET /runs/:runId and /stream return 200 with valid JSON under concurrent load/save", async () => {
      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: {},
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      const numGet = 20;
      const numStream = 5;
      const getPromises = Array.from({ length: numGet }, () =>
        app.inject({ method: "GET", url: `/runs/${runId}` })
      );
      const streamPromises = Array.from({ length: numStream }, () =>
        app.inject({ method: "GET", url: `/runs/${runId}/stream` })
      );
      const getResults = await Promise.all(getPromises);
      const streamResults = await Promise.all(streamPromises);

      for (const res of getResults) {
        expect(res.statusCode).toBe(200);
        const body = res.json() as { id: string; status: string };
        expect(body.id).toBe(runId);
        expect(typeof body.status).toBe("string");
      }
      for (const res of streamResults) {
        expect(res.statusCode).toBe(200);
        expect(res.headers["content-type"]).toMatch(/text\/event-stream/);
        const body = res.payload as string;
        expect(body).toContain("data:");
        expect(() => {
          const line = body.split("\n").find((l) => l.startsWith("data:"));
          if (line) JSON.parse(line.slice(5));
        }).not.toThrow();
      }
    });
  });

  describe("POST /pipelines/:id/run with custom agentRunner", () => {
    it("uses injected agentRunner for agent nodes (not stub)", { timeout: 10000 }, async () => {
      const mockAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
        text: `[mock] ${agentId}: ${prompt.slice(0, 50)}`,
        tokenUsage: { input: 1, output: 2 },
      });
      await app.close();
      app = await createApp({ ...config, agentRunner: mockAgentRunner });

      const runRes = await app.inject({
        method: "POST",
        url: "/pipelines/ripline-area-owner/run",
        payload: { inputs: {} },
      });
      expect(runRes.statusCode).toBe(202);
      const { runId } = runRes.json() as { runId: string };

      let record: { status: string; steps?: { status: string; data?: { artifactValue?: { text?: string } } }[] } | null = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 50));
        const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
        record = getRes.json() as typeof record;
        if (record?.status === "completed" || record?.status === "errored") break;
      }
      expect(record).toBeDefined();
      expect(record!.status).toBe("completed");
      const withArtifact = record!.steps?.filter(
        (s) => s.data && typeof (s.data as { artifactValue?: { text?: string } }).artifactValue?.text === "string"
      ) ?? [];
      expect(withArtifact.length).toBeGreaterThan(0);
      const firstText = (withArtifact[0]!.data as { artifactValue?: { text?: string } }).artifactValue?.text ?? "";
      expect(firstText).toMatch(/\[mock\]/);
      expect(firstText).not.toMatch(/\[http-stub\]/);
    });

    it("RIPLINE_AGENT_RUNNER=stub forces stub even when config provides agentRunner", { timeout: 10000 }, async () => {
      const mockAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
        text: `[mock] ${agentId}: ${prompt.slice(0, 50)}`,
        tokenUsage: { input: 1, output: 2 },
      });
      await app.close();
      const prev = process.env.RIPLINE_AGENT_RUNNER;
      process.env.RIPLINE_AGENT_RUNNER = "stub";
      try {
        app = await createApp({ ...config, agentRunner: mockAgentRunner });
        const runRes = await app.inject({
          method: "POST",
          url: "/pipelines/ripline-area-owner/run",
          payload: { inputs: {} },
        });
        expect(runRes.statusCode).toBe(202);
        const { runId } = runRes.json() as { runId: string };

        let record: { status: string; steps?: { status: string; data?: { artifactValue?: { text?: string } } }[] } | null = null;
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 50));
          const getRes = await app.inject({ method: "GET", url: `/runs/${runId}` });
          record = getRes.json() as typeof record;
          if (record?.status === "completed" || record?.status === "errored") break;
        }
        expect(record).toBeDefined();
        expect(record!.status).toBe("completed");
        const withArtifact = record!.steps?.filter(
          (s) => s.data && typeof (s.data as { artifactValue?: { text?: string } }).artifactValue?.text === "string"
        ) ?? [];
        expect(withArtifact.length).toBeGreaterThan(0);
        const firstText = (withArtifact[0]!.data as { artifactValue?: { text?: string } }).artifactValue?.text ?? "";
        expect(firstText).toMatch(/\[http-stub\]/);
        expect(firstText).not.toMatch(/\[mock\]/);
      } finally {
        if (prev !== undefined) process.env.RIPLINE_AGENT_RUNNER = prev;
        else delete process.env.RIPLINE_AGENT_RUNNER;
      }
    });
  });
});
