import path from "node:path";
import { promises as fs } from "node:fs";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import os from "node:os";
import type { AgentDefinition, SkillsRegistry, PipelinePluginConfig } from "./types.js";
import { resolveSkillsDir } from "./config.js";
import type { PipelineRunRecord } from "./types.js";
import { PipelineRegistry } from "./registry.js";
import { PipelineRunStore } from "./run-store.js";
import { createRunQueue } from "./run-queue.js";
import { createScheduler } from "./scheduler.js";
import { createLogger, createRunScopedFileSink, LOG_FILE_NAME } from "./log.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";
import { loadAgentDefinitionsFromFile, loadSkillsRegistryFromFile } from "./agent-runner-config.js";
import { listProfiles, loadProfile } from "./profiles.js";
import YAML from "yaml";

const DEFAULT_RUNS_DIR = ".ripline/runs";
const DEFAULT_PROFILES_DIR = path.join(
  process.env.HOME ?? path.resolve("."),
  ".ripline",
  "profiles"
);
const SSE_POLL_MS = 500;

/** Stub agent for HTTP-triggered runs when no OpenClaw is available. */
const stubAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
  text: `[http-stub] ${agentId}: ${prompt.slice(0, 80)}…`,
  tokenUsage: { input: 0, output: 0 },
});

export type ServerConfig = PipelinePluginConfig & {
  runsDir?: string;
  profilesDir?: string;
  /** When set (e.g. by OpenClaw plugin), agent nodes use this runner; otherwise stub. */
  agentRunner?: AgentRunner;
  /** For agent nodes with runner: claude-code. Not set when running inside OpenClaw. */
  claudeCodeRunner?: AgentRunner;
  /** Named agent definitions. Loaded from ripline.config.json in pipelinesDir when not provided. */
  agentDefinitions?: Record<string, AgentDefinition>;
  /** Skills registry. Loaded from ripline.config.json in pipelinesDir when not provided. */
  skillsRegistry?: SkillsRegistry;
  /** Directory containing per-skill markdown files. Defaults to ~/.ripline/skills. */
  skillsDir?: string;
};

export async function createApp(config: ServerConfig): Promise<FastifyInstance> {
  const runsDir = path.resolve(config.runsDir ?? DEFAULT_RUNS_DIR);
  const registry = new PipelineRegistry(config.pipelinesDir);
  const store = new PipelineRunStore(runsDir);
  await store.init();

  const agentRunner =
    process.env.RIPLINE_AGENT_RUNNER === "stub"
      ? stubAgentRunner
      : (config.agentRunner ?? stubAgentRunner);
  const claudeCodeRunner = config.claudeCodeRunner;
  const agentDefinitions =
    config.agentDefinitions ?? loadAgentDefinitionsFromFile(config.pipelinesDir) ?? undefined;
  const skillsRegistry =
    config.skillsRegistry ?? loadSkillsRegistryFromFile(config.pipelinesDir) ?? undefined;
  const skillsDir = config.skillsDir ?? resolveSkillsDir({ homedir: os.homedir() });
  const maxConcurrency = config.maxConcurrency ?? 0;
  const queue = createRunQueue(store);
  const scheduler =
    maxConcurrency > 0
      ? createScheduler({
          store,
          queue,
          registry,
          maxConcurrency,
          agentRunner,
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
          ...(agentDefinitions !== undefined && { agentDefinitions }),
          ...(skillsRegistry !== undefined && { skillsRegistry }),
          skillsDir,
        })
      : null;
  if (scheduler) scheduler.start();

  const fastify = Fastify({ logger: false });

  await fastify.register(cors, { origin: true });

  const authToken = config.authToken;

  async function requireAuth(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!authToken) return;
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (token !== authToken) {
      await reply.status(401).send({ error: "Unauthorized", message: "Missing or invalid Authorization" });
    }
  }

  /** GET /pipelines/:id - single pipeline definition */
  fastify.get<{ Params: { id: string } }>("/pipelines/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const entry = await registry.get(request.params.id);
      if (!entry) {
        return reply.status(404).send({ error: "Not Found", message: `Pipeline ${request.params.id} not found` });
      }
      return reply.send({
        id: entry.definition.id,
        name: entry.definition.name,
        ...(entry.definition.tags && { tags: entry.definition.tags }),
        nodes: entry.definition.nodes,
        edges: entry.definition.edges,
      });
    },
  });

  /** GET /pipelines - list definitions (id, name, tags) */
  fastify.get("/pipelines", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const definitions = await registry.list();
      const pipelines = definitions.map((d) => ({
        id: d.id,
        name: d.name,
        tags: d.tags,
        nodeCount: Array.isArray(d.nodes) ? d.nodes.length : 0,
        edgeCount: Array.isArray(d.edges) ? d.edges.length : 0,
      }));
      return reply.send({ pipelines });
    },
  });

  /** GET /pipelines/:id - fetch single pipeline definition */
  fastify.get<{ Params: { id: string } }>("/pipelines/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const entry = await registry.get(request.params.id);
      if (!entry) {
        return reply.status(404).send({ error: "Not Found", message: `Pipeline ${request.params.id} not found` });
      }
      return reply.send(entry.definition);
    },
  });

  /** POST /pipelines/:id/run - enqueue run (when scheduler active) or run inline */
  fastify.post<{ Params: { id: string }; Body: { inputs?: Record<string, unknown>; env?: Record<string, string> } }>(
    "/pipelines/:id/run",
    {
      preHandler: requireAuth,
      handler: async (request, reply) => {
        const entry = await registry.get(request.params.id);
        if (!entry) {
          return reply.status(404).send({ error: "Not Found", message: `Pipeline ${request.params.id} not found` });
        }
        const body = (request.body as { inputs?: Record<string, unknown>; env?: Record<string, string> }) ?? {};
        const inputs = body.inputs ?? {};
        if (scheduler) {
          const runId = await queue.enqueue(request.params.id, inputs);
          return reply.status(202).send({ runId });
        }
        const runLog = createLogger({ sink: createRunScopedFileSink(runsDir) });
        const runner = new DeterministicRunner(entry.definition, {
          store,
          runsDir,
          quiet: true,
          log: runLog,
          agentRunner,
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
          ...(agentDefinitions !== undefined && { agentDefinitions }),
          ...(skillsRegistry !== undefined && { skillsRegistry }),
          skillsDir,
        });
        const runIdPromise = new Promise<string>((resolve) => {
          runner.once("run.started", (record: PipelineRunRecord) => resolve(record.id));
        });
        runner.run({
          inputs,
          ...(body.env !== undefined && { env: body.env }),
        }).catch((err) => {
          console.error(`[server] pipeline run failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        const runId = await runIdPromise;
        return reply.status(202).send({ runId });
      },
    }
  );

  const profilesDir = config.profilesDir ?? DEFAULT_PROFILES_DIR;

  async function profileToResponse(name: string): Promise<{ id: string; name: string; description?: string; projectRoot?: string; createdAt: string; updatedAt: string } | null> {
    try {
      const profile = loadProfile(name, profilesDir);
      const filePath = path.join(profilesDir, `${name}.yaml`);
      let mtime = new Date().toISOString();
      try { mtime = (await fs.stat(filePath)).mtime.toISOString(); } catch { /* use now */ }
      return {
        id: name,
        name: profile.name,
        ...(profile.description !== undefined && { description: profile.description }),
        ...(typeof profile.inputs?.projectRoot === "string" && { projectRoot: profile.inputs.projectRoot }),
        createdAt: mtime,
        updatedAt: mtime,
      };
    } catch {
      return null;
    }
  }

  /** GET /profiles - list all profiles */
  fastify.get<{ Querystring: { q?: string } }>("/profiles", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const all = listProfiles(profilesDir);
      const { q } = request.query;
      const filtered = q ? all.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : all;
      const results = await Promise.all(filtered.map((p) => profileToResponse(p.name)));
      return reply.send(results.filter(Boolean));
    },
  });

  /** GET /profiles/:id - fetch single profile */
  fastify.get<{ Params: { id: string } }>("/profiles/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const result = await profileToResponse(request.params.id);
      if (!result) {
        return reply.status(404).send({ error: "Not Found", message: `Profile ${request.params.id} not found` });
      }
      return reply.send(result);
    },
  });

  /** POST /profiles - create a new profile YAML */
  fastify.post<{ Body: { name?: string; description?: string; inputs?: Record<string, unknown> } }>("/profiles", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { name, description, inputs } = (request.body as { name?: string; description?: string; inputs?: Record<string, unknown> }) ?? {};
      if (!name || typeof name !== "string" || !name.trim()) {
        return reply.status(400).send({ error: "Bad Request", message: "name is required" });
      }
      const safeName = name.trim().replace(/[/\\]/g, "");
      if (!safeName) {
        return reply.status(400).send({ error: "Bad Request", message: "Invalid profile name" });
      }
      const filePath = path.join(profilesDir, `${safeName}.yaml`);
      try {
        await fs.access(filePath);
        return reply.status(409).send({ error: "Conflict", message: `Profile "${safeName}" already exists` });
      } catch { /* does not exist — proceed */ }
      const profileObj: Record<string, unknown> = { name: safeName };
      if (typeof description === "string" && description.trim()) {
        profileObj.description = description.trim();
      }
      profileObj.inputs = (inputs && typeof inputs === "object" && !Array.isArray(inputs)) ? inputs : {};
      const content = YAML.stringify(profileObj);
      await fs.mkdir(profilesDir, { recursive: true });
      await fs.writeFile(filePath, content, "utf8");
      const result = await profileToResponse(safeName);
      return reply.status(201).send(result);
    },
  });

  /** DELETE /profiles/:id - remove a profile YAML */
  fastify.delete<{ Params: { id: string } }>("/profiles/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const safeName = request.params.id.replace(/[/\\]/g, "");
      const filePath = path.join(profilesDir, `${safeName}.yaml`);
      try {
        await fs.unlink(filePath);
        return reply.status(204).send();
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
          return reply.status(404).send({ error: "Not Found", message: `Profile ${safeName} not found` });
        }
        return reply.status(500).send({ error: "Internal Server Error", message: String(err) });
      }
    },
  });

  /** GET /metrics - queue depth, active workers, avg duration (when scheduler active) */
  if (scheduler) {
    fastify.get("/metrics", {
      preHandler: requireAuth,
      handler: async (_request, reply) => {
        const metrics = await scheduler.getMetrics();
        return reply.send(metrics);
      },
    });
  }

  /** Hook close to stop scheduler */
  fastify.addHook("onClose", async () => {
    if (scheduler) scheduler.stop();
  });

  /** Load run with one retry on JSON parse failure (e.g. read during atomic rename). */
  async function loadRunWithRetry(runId: string): Promise<PipelineRunRecord | null> {
    try {
      return await store.load(runId);
    } catch (err) {
      const isParseError =
        err instanceof SyntaxError || (err instanceof Error && /JSON|parse|Unexpected token/i.test(err.message));
      if (isParseError) {
        try {
          return await store.load(runId);
        } catch {
          throw err;
        }
      }
      throw err;
    }
  }

  /** GET /runs - list runs, optionally filtered by pipelineId and status */
  fastify.get<{
    Querystring: { pipelineId?: string; status?: string };
  }>("/runs", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { pipelineId, status } = request.query;
      const statusOption =
        status === "pending" || status === "running" || status === "completed" || status === "errored" || status === "paused"
          ? (status as "pending" | "running" | "completed" | "errored" | "paused")
          : undefined;
      let runs = await store.list(statusOption !== undefined ? { status: statusOption } : {});
      if (pipelineId !== undefined && pipelineId !== "") {
        runs = runs.filter((r) => r.pipelineId === pipelineId);
      }
      return reply.send({ runs });
    },
  });

  /** POST /runs/:runId/retry - requeue an errored/paused run from a given node (or the first errored node) */
  fastify.post<{ Params: { runId: string }; Body: { fromNode?: string } }>(
    "/runs/:runId/retry",
    {
      preHandler: requireAuth,
      handler: async (request, reply) => {
        const { runId } = request.params;
        const { fromNode } = (request.body as { fromNode?: string }) ?? {};

        let record: PipelineRunRecord | null;
        try {
          record = await loadRunWithRetry(runId);
        } catch (err) {
          return reply.status(500).send({ error: "Internal Server Error", message: String(err) });
        }
        if (!record) {
          return reply.status(404).send({ error: "Not Found", message: `Run ${runId} not found` });
        }
        if (record.status !== "errored" && record.status !== "paused") {
          return reply.status(409).send({
            error: "Conflict",
            message: `Run ${runId} cannot be retried (status: ${record.status})`,
          });
        }

        const entry = await registry.get(record.pipelineId);
        if (!entry) {
          return reply.status(404).send({ error: "Not Found", message: `Pipeline ${record.pipelineId} not found` });
        }

        const retryLog = createLogger({ sink: createRunScopedFileSink(runsDir) });
        const tempRunner = new DeterministicRunner(entry.definition, {
          store,
          runsDir,
          quiet: true,
          log: retryLog,
          agentRunner,
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
          ...(agentDefinitions !== undefined && { agentDefinitions }),
          ...(skillsRegistry !== undefined && { skillsRegistry }),
          skillsDir,
        });
        const order = tempRunner.getExecutionOrder();

        let targetIndex: number;
        if (fromNode) {
          targetIndex = order.indexOf(fromNode);
          if (targetIndex === -1) {
            return reply.status(400).send({
              error: "Bad Request",
              message: `Node "${fromNode}" not found in pipeline ${record.pipelineId}. Nodes: ${order.join(", ")}`,
            });
          }
        } else {
          const erroredStep = record.steps.find((s) => s.status === "errored");
          const erroredNodeId = erroredStep?.nodeId;
          targetIndex = erroredNodeId !== undefined ? order.indexOf(erroredNodeId) : 0;
          if (targetIndex === -1) targetIndex = 0;
        }

        // Reset steps from targetIndex onwards
        for (let i = targetIndex; i < record.steps.length; i++) {
          record.steps[i] = { nodeId: record.steps[i]!.nodeId, status: "pending" };
        }

        // Rebuild artifact context from completed steps before targetIndex
        const artifacts: Record<string, unknown> = {};
        for (let k = 0; k < targetIndex; k++) {
          const s = record.steps[k];
          if (
            s?.status === "completed" &&
            s.data &&
            typeof s.data === "object" &&
            "artifactKey" in s.data &&
            "artifactValue" in s.data
          ) {
            const d = s.data as { artifactKey: string; artifactValue: unknown };
            artifacts[d.artifactKey] = d.artifactValue;
          }
        }

        record.cursor = {
          nextNodeIndex: targetIndex,
          context: { inputs: record.inputs, artifacts, outputs: record.outputs ?? {} },
        };
        record.status = "pending";
        record.updatedAt = Date.now();
        delete record.error;
        await store.save(record);

        if (!scheduler) {
          // No scheduler — run inline in background using resumeRunId path
          const resumeLog = createLogger({ sink: createRunScopedFileSink(runsDir) });
          const inlineRunner = new DeterministicRunner(entry.definition, {
            store,
            runsDir,
            quiet: true,
            log: resumeLog,
            agentRunner,
            ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
            ...(agentDefinitions !== undefined && { agentDefinitions }),
            ...(skillsRegistry !== undefined && { skillsRegistry }),
            skillsDir,
          });
          inlineRunner.run({ resumeRunId: runId }).catch((err) => {
            console.error(`[server] retry run failed: ${err instanceof Error ? err.message : String(err)}`);
          });
        }

        return reply.status(202).send({ runId: record.id, fromNode: order[targetIndex] });
      },
    }
  );

  /** GET /runs/:runId - run record + status */
  fastify.get<{ Params: { runId: string } }>("/runs/:runId", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      let record: PipelineRunRecord | null;
      try {
        record = await loadRunWithRetry(request.params.runId);
      } catch (err) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!record) {
        return reply.status(404).send({ error: "Not Found", message: `Run ${request.params.runId} not found` });
      }
      return reply.send(record);
    },
  });

  /** GET /runs/:runId/stream - SSE for node updates */
  fastify.get<{ Params: { runId: string } }>("/runs/:runId/stream", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      let record: PipelineRunRecord | null;
      try {
        record = await loadRunWithRetry(request.params.runId);
      } catch (err) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!record) {
        return reply.status(404).send({ error: "Not Found", message: `Run ${request.params.runId} not found` });
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const send = (data: PipelineRunRecord) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      let lastUpdated = record.updatedAt;
      const interval = setInterval(async () => {
        let current: PipelineRunRecord | null;
        try {
          current = await loadRunWithRetry(request.params.runId);
        } catch {
          clearInterval(interval);
          reply.raw.end();
          return;
        }
        if (!current) {
          clearInterval(interval);
          reply.raw.end();
          return;
        }
        if (current.updatedAt !== lastUpdated) {
          lastUpdated = current.updatedAt;
          send(current);
        }
        if (current.status === "completed" || current.status === "errored") {
          clearInterval(interval);
          reply.raw.end();
        }
      }, SSE_POLL_MS);
      request.raw.on("close", () => clearInterval(interval));
      send(record);
    },
  });

  /** GET /runs/:runId/logs - run log file (plain text or JSON lines) */
  fastify.get<{ Params: { runId: string }; Querystring: { format?: string } }>(
    "/runs/:runId/logs",
    {
      preHandler: requireAuth,
      handler: async (request, reply) => {
        let record: PipelineRunRecord | null;
        try {
          record = await loadRunWithRetry(request.params.runId);
        } catch (err) {
          return reply.status(500).send({
            error: "Internal Server Error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
        if (!record) {
          return reply.status(404).send({ error: "Not Found", message: `Run ${request.params.runId} not found` });
        }
        const logPath = path.join(runsDir, request.params.runId, LOG_FILE_NAME);
        try {
          const content = await fs.readFile(logPath, "utf8");
          const format = (request.query as { format?: string }).format;
          if (format === "json") {
            const lines = content.split("\n").filter((line) => line.length > 0);
            return reply.send({ lines });
          }
          return reply.type("text/plain").send(content);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            return reply.status(404).send({
              error: "Not Found",
              message: `No logs yet for run ${request.params.runId}`,
            });
          }
          return reply.status(500).send({
            error: "Internal Server Error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    }
  );

  /** GET /runs/:runId/logs/stream - SSE stream of new log lines (polls log file) */
  fastify.get<{ Params: { runId: string } }>("/runs/:runId/logs/stream", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      let record: PipelineRunRecord | null;
      try {
        record = await loadRunWithRetry(request.params.runId);
      } catch (err) {
        return reply.status(500).send({
          error: "Internal Server Error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
      if (!record) {
        return reply.status(404).send({ error: "Not Found", message: `Run ${request.params.runId} not found` });
      }
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const logPath = path.join(runsDir, request.params.runId, LOG_FILE_NAME);
      let lastSize = 0;
      const LOG_POLL_MS = 500;
      const interval = setInterval(async () => {
        try {
          const stat = await fs.stat(logPath);
          if (stat.size > lastSize) {
            const f = await fs.open(logPath, "r");
            const buf = Buffer.alloc(stat.size - lastSize);
            await f.read(buf, 0, buf.length, lastSize);
            f.close();
            lastSize = stat.size;
            const chunk = buf.toString("utf8");
            if (chunk.length > 0) {
              reply.raw.write(`data: ${JSON.stringify({ lines: chunk })}\n\n`);
            }
          }
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") {
            clearInterval(interval);
            reply.raw.end();
          }
        }
        try {
          const current = await loadRunWithRetry(request.params.runId);
          if (current?.status === "completed" || current?.status === "errored") {
            clearInterval(interval);
            reply.raw.end();
          }
        } catch {
          clearInterval(interval);
          reply.raw.end();
        }
      }, LOG_POLL_MS);
      request.raw.on("close", () => clearInterval(interval));
    },
  });

  return fastify;
}

export type StartServerOptions = ServerConfig & {
  port?: number;
};

/** Start the HTTP server. Used by the plugin when running standalone. */
export async function startServer(options: StartServerOptions): Promise<{ close: () => Promise<void> }> {
  const port = options.httpPort ?? options.port ?? 4001;
  const app = await createApp(options);
  await app.listen({ port, host: "0.0.0.0" });
  return {
    close: () => app.close(),
  };
}
