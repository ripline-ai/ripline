import path from "node:path";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import os from "node:os";
import type { AgentDefinition, SkillsRegistry, PipelinePluginConfig, ContainerResourceLimits } from "./types.js";
import type { ContainerBuildConfig } from "./container-build-runner.js";
import { resolveSkillsDir, resolveConfig } from "./config.js";
import type { PipelineRunRecord } from "./types.js";
import { PipelineRegistry } from "./registry.js";
import { PipelineRunStore } from "./run-store.js";
import { EventBus, type BusEvent } from "./event-bus.js";
import { createRunQueue } from "./run-queue.js";
import { createScheduler } from "./scheduler.js";
import { BackgroundQueue } from "./background-queue.js";
import { YamlFileQueueStore } from "./interfaces/queue-store.js";
import { loadUserConfig } from "./config.js";
import { createLogger, createRunScopedFileSink, LOG_FILE_NAME } from "./log.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";
import { loadAgentDefinitionsFromFile, loadSkillsRegistryFromFile } from "./agent-runner-config.js";
import { listProfiles, loadProfile } from "./profiles.js";
import { WebhookDispatcher } from "./webhook-dispatcher.js";
// AutoExecutor import retained for reference — not wired up at runtime
// import { AutoExecutor } from "./auto-executor.js";
import { createTelegramNotifier } from "./telegram.js";
import { FocusAreaStore } from "./focus-area-store.js";
import { registerFocusAreaRoutes } from "./routes/focus-areas.js";
import { registerEpicRoutes } from "./routes/epics.js";
import { registerUsageRoutes } from "./routes/usage.js";
import YAML from "yaml";

const DEFAULT_RUNS_DIR = ".ripline/runs";
const DEFAULT_PROFILES_DIR = path.join(
  process.env.HOME ?? path.resolve("."),
  ".ripline",
  "profiles"
);
const SSE_POLL_MS = 500;

/** Stub agent for HTTP-triggered runs when no external agent runner is available. */
const stubAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
  text: `[http-stub] ${agentId}: ${prompt.slice(0, 80)}…`,
  tokenUsage: { input: 0, output: 0 },
});

export type ServerConfig = PipelinePluginConfig & {
  runsDir?: string;
  profilesDir?: string;
  /** When set (e.g. by an integration plugin), agent nodes use this runner; otherwise stub. */
  agentRunner?: AgentRunner;
  /** For agent nodes with runner: claude-code. Not set when an external agent runner is used instead. */
  claudeCodeRunner?: AgentRunner;
  /** For agent nodes with runner: codex. Not set when an external agent runner is used instead. */
  codexRunner?: AgentRunner;
  /** Named agent definitions. Loaded from ripline.config.json in pipelinesDir when not provided. */
  agentDefinitions?: Record<string, AgentDefinition>;
  /** Skills registry. Loaded from ripline.config.json in pipelinesDir when not provided. */
  skillsRegistry?: SkillsRegistry;
  /** Directory containing per-skill markdown files. Defaults to ~/.ripline/skills. */
  skillsDir?: string;
  /** Per-queue concurrency overrides. Key = queue name, value = worker count. */
  queueConcurrencies?: Record<string, number>;
  /** Container build configuration. When set, scheduler attempts container-based execution for builds. */
  containerBuild?: ContainerBuildConfig;
};

export async function createApp(config: ServerConfig): Promise<FastifyInstance> {
  const runsDir = path.resolve(config.runsDir ?? DEFAULT_RUNS_DIR);
  const registry = new PipelineRegistry(config.pipelinesDir);
  const store = new PipelineRunStore(runsDir);
  await store.init();

  const claudeCodeRunner = config.claudeCodeRunner;
  const codexRunner = config.codexRunner;
  const agentRunner =
    process.env.RIPLINE_AGENT_RUNNER === "stub"
      ? stubAgentRunner
      : (config.agentRunner ?? claudeCodeRunner ?? codexRunner ?? stubAgentRunner);
  const agentDefinitions =
    config.agentDefinitions ?? loadAgentDefinitionsFromFile(config.pipelinesDir) ?? undefined;
  const skillsRegistry =
    config.skillsRegistry ?? loadSkillsRegistryFromFile(config.pipelinesDir) ?? undefined;
  const skillsDir = config.skillsDir ?? resolveSkillsDir({ homedir: os.homedir() });
  const maxConcurrency = config.maxConcurrency ?? 0;
  const queue = createRunQueue(store);

  // Merge per-queue config from user config (queues field) with CLI overrides (queueConcurrencies).
  // User config provides both concurrency and resource limits per queue.
  const userConfig2 = loadUserConfig();
  const mergedQueueConcurrencies: Record<string, number> = {};
  const mergedQueueResourceLimits: Record<string, ContainerResourceLimits> = {};

  // First, apply user config queues (concurrency + resource limits)
  if (userConfig2.queues) {
    for (const [name, qc] of Object.entries(userConfig2.queues)) {
      mergedQueueConcurrencies[name] = qc.concurrency;
      if (qc.resourceLimits) {
        mergedQueueResourceLimits[name] = qc.resourceLimits;
      }
    }
  }

  // Then, apply config.queues (programmatic / plugin config)
  if (config.queues) {
    for (const [name, qc] of Object.entries(config.queues)) {
      mergedQueueConcurrencies[name] = qc.concurrency;
      if (qc.resourceLimits) {
        mergedQueueResourceLimits[name] = qc.resourceLimits;
      }
    }
  }

  // CLI --queue flags override concurrency (backward compat)
  if (config.queueConcurrencies) {
    for (const [name, concurrency] of Object.entries(config.queueConcurrencies)) {
      mergedQueueConcurrencies[name] = concurrency;
    }
  }

  const hasQueues = Object.keys(mergedQueueConcurrencies).length > 0;
  const hasResourceLimits = Object.keys(mergedQueueResourceLimits).length > 0;
  const scheduler =
    maxConcurrency > 0 || hasQueues
      ? createScheduler({
          store,
          queue,
          registry,
          maxConcurrency,
          ...(hasQueues && { queueConcurrencies: mergedQueueConcurrencies }),
          agentRunner,
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
          ...(codexRunner !== undefined && { codexRunner }),
          ...(agentDefinitions !== undefined && { agentDefinitions }),
          ...(skillsRegistry !== undefined && { skillsRegistry }),
          skillsDir,
          ...(config.containerBuild !== undefined && { containerBuild: config.containerBuild }),
          ...(hasResourceLimits && { queueResourceLimits: mergedQueueResourceLimits }),
        })
      : null;
  if (scheduler) scheduler.start();

  const webhookDispatcher = new WebhookDispatcher(store);

  /** Track in-flight fire-and-forget background runs so close() can await them. */
  const backgroundRunPromises = new Set<Promise<void>>();

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

  /** GET /pipelines - list definitions (id, name, tags) */
  fastify.get("/pipelines", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const definitions = await registry.list();
      const pipelines = definitions.map((d) => ({
        id: d.id,
        name: d.name,
        tags: d.tags,
        queue: d.queue,
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
  fastify.post<{ Params: { id: string }; Body: { inputs?: Record<string, unknown>; env?: Record<string, string>; webhook_url?: string } }>(
    "/pipelines/:id/run",
    {
      preHandler: requireAuth,
      handler: async (request, reply) => {
        const entry = await registry.get(request.params.id);
        if (!entry) {
          return reply.status(404).send({ error: "Not Found", message: `Pipeline ${request.params.id} not found` });
        }
        const body = (request.body as { inputs?: Record<string, unknown>; env?: Record<string, string>; webhook_url?: string }) ?? {};
        const inputs = body.inputs ?? {};
        const webhookUrl = typeof body.webhook_url === "string" ? body.webhook_url : undefined;
        if (scheduler) {
          const queueName = entry.definition.queue ?? "default";
          const runId = await queue.enqueue(request.params.id, inputs, { queueName, ...(webhookUrl !== undefined && { webhook_url: webhookUrl }) });
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
          ...(codexRunner !== undefined && { codexRunner }),
          ...(agentDefinitions !== undefined && { agentDefinitions }),
          ...(skillsRegistry !== undefined && { skillsRegistry }),
          skillsDir,
        });
        const runIdPromise = new Promise<string>((resolve) => {
          runner.once("run.started", async (record: PipelineRunRecord) => {
            if (webhookUrl) {
              record.webhook_url = webhookUrl;
              await store.save(record);
            }
            resolve(record.id);
          });
        });
        const runBgP: Promise<void> = runner.run({
          inputs,
          ...(body.env !== undefined && { env: body.env }),
        }).then(() => {}).catch((err) => {
          console.error(`[server] pipeline run failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        backgroundRunPromises.add(runBgP);
        void runBgP.finally(() => { backgroundRunPromises.delete(runBgP); });
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
        const metrics = await scheduler.getDetailedMetrics();
        return reply.send(metrics);
      },
    });
  }

  /** Hook close to stop scheduler, webhook dispatcher, and drain background runs */
  fastify.addHook("onClose", async () => {
    if (scheduler) scheduler.stop();
    webhookDispatcher.stop();
    // Drain any in-flight fire-and-forget background retry/resume runners
    if (backgroundRunPromises.size > 0) {
      await Promise.allSettled([...backgroundRunPromises]);
    }
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

  /** GET /runs - list runs, optionally filtered by pipelineId, status, and limit */
  fastify.get<{
    Querystring: { pipelineId?: string; status?: string; limit?: string };
  }>("/runs", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { pipelineId, status, limit } = request.query;
      const statusOption =
        status === "pending" || status === "running" || status === "completed" || status === "errored" || status === "paused"
          ? (status as "pending" | "running" | "completed" | "errored" | "paused")
          : undefined;
      const limitOption = limit !== undefined ? Math.max(1, parseInt(limit, 10) || 100) : undefined;
      let runs = await store.list({
        ...(statusOption !== undefined && { status: statusOption }),
        ...(limitOption !== undefined && { limit: limitOption }),
      });
      if (pipelineId !== undefined && pipelineId !== "") {
        runs = runs.filter((r) => r.pipelineId === pipelineId);
      }
      return reply.send({ runs });
    },
  });

  /** DELETE /runs/prune - delete completed/errored run directories older than a threshold */
  fastify.delete<{
    Querystring: { olderThanDays?: string };
  }>("/runs/prune", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const rawDays = request.query.olderThanDays;
      const olderThanDays = rawDays !== undefined ? Math.max(0, parseFloat(rawDays) || 7) : 7;
      const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

      const { promises: fsP } = await import("node:fs");
      const entries = await fsP.readdir(runsDir, { withFileTypes: true }).catch(() => []);
      const dirs = entries.filter((e) => e.isDirectory());

      let pruned = 0;
      let skipped = 0;

      for (const ent of dirs) {
        const runId = ent.name;
        let record: PipelineRunRecord | null = null;
        try {
          record = await store.load(runId);
        } catch {
          skipped++;
          continue;
        }
        if (!record) { skipped++; continue; }
        if (record.status !== "completed" && record.status !== "errored") { skipped++; continue; }
        if (record.updatedAt > cutoffMs) { skipped++; continue; }

        try {
          await fsP.rm(path.join(runsDir, runId), { recursive: true, force: true });
          pruned++;
        } catch {
          skipped++;
        }
      }

      return reply.send({ pruned, skipped });
    },
  });

  /** POST /runs/:runId/retry - requeue an errored/paused run with optional strategy */
  fastify.post<{ Params: { runId: string }; Body: { fromNode?: string; strategy?: string } }>(
    "/runs/:runId/retry",
    {
      preHandler: requireAuth,
      handler: async (request, reply) => {
        const { runId } = request.params;
        const body = (request.body as { fromNode?: string; strategy?: string }) ?? {};
        const { fromNode } = body;
        const strategy = body.strategy ?? "from-failure";

        if (strategy !== "from-failure" && strategy !== "from-start") {
          return reply.status(400).send({
            error: "Bad Request",
            message: `Invalid strategy "${strategy}". Must be "from-failure" or "from-start".`,
          });
        }

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
        if (strategy === "from-start") {
          // Restart from the beginning: reset all steps and clear cursor
          targetIndex = 0;
        } else if (fromNode) {
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

        if (strategy === "from-start") {
          // Full restart: clear cursor and outputs
          delete record.cursor;
          record.outputs = {};
        } else {
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
        }

        record.status = "pending";
        record.updatedAt = Date.now();
        record.retryCount = 0;
        delete record.error;
        await store.save(record);

        if (!scheduler) {
          // No scheduler — run inline in background; track promise so close() can drain it
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
          const runP = strategy === "from-start"
            ? inlineRunner.run({ startRunId: runId, inputs: record.inputs })
            : inlineRunner.run({ resumeRunId: runId });
          const bgPromise: Promise<void> = runP.then(() => {}).catch((err) => {
            console.error(`[server] retry run failed: ${err instanceof Error ? err.message : String(err)}`);
          });
          backgroundRunPromises.add(bgPromise);
          void bgPromise.finally(() => { backgroundRunPromises.delete(bgPromise); });
        }

        return reply.status(202).send({ runId: record.id, fromNode: order[targetIndex], strategy });
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
        if (current.status === "completed" || current.status === "errored" || current.status === "needs-conflict-resolution") {
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

  /** GET /runs/:runId/container-logs - container execution log (plain text) */
  fastify.get<{ Params: { runId: string } }>(
    "/runs/:runId/container-logs",
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
        // Prefer the containerLogFile field on the record, fall back to conventional path
        const containerLogPath = record.containerLogFile
          ?? path.join(runsDir, request.params.runId, "container.log");
        try {
          const content = await fs.readFile(containerLogPath, "utf8");
          return reply.type("text/plain").send(content);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
            return reply.status(404).send({
              error: "Not Found",
              message: `No container logs for run ${request.params.runId}`,
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
          if (current?.status === "completed" || current?.status === "errored" || current?.status === "needs-conflict-resolution") {
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

  /** GET /events - global SSE stream of EventBus run events */
  fastify.get<{
    Querystring: { pipelineId?: string; status?: string };
  }>("/events", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const { pipelineId, status } = request.query;

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      const bus = EventBus.getInstance();

      const listener = (evt: BusEvent) => {
        // Usage events bypass pipeline/status filters — always broadcast
        if (evt.event !== "usage.update") {
          if (pipelineId && evt.pipelineId !== pipelineId) return;
          if (status && evt.status !== status) return;
        }
        reply.raw.write(`data: ${JSON.stringify(evt)}\n\n`);
      };

      bus.on("run-event", listener);

      // Keepalive comment every 15 seconds
      const keepalive = setInterval(() => {
        reply.raw.write(": keepalive\n\n");
      }, 15_000);

      request.raw.on("close", () => {
        bus.removeListener("run-event", listener);
        clearInterval(keepalive);
      });
    },
  });

  // ─── Background Queue endpoints ───────────────────────────

  const userConfig = loadUserConfig();
  const defaultQueuePath = path.join(os.homedir(), ".ripline", "queue.yaml");
  const queueStore = new YamlFileQueueStore(config.queueFilePath ?? defaultQueuePath);
  const bgQueue = new BackgroundQueue({
    store: queueStore,
    maxRetries: userConfig.backgroundQueue?.maxRetries ?? 5,
  });

  // Recover orphaned items: running with no runId means a previous process died
  // mid-dispatch before it could record the runId. Reset them to pending.
  for (const item of bgQueue.list()) {
    if (item.status === "running" && !item.runId) {
      console.warn(`[server] resetting orphaned queue item ${item.id} to pending`);
      bgQueue.update(item.id, { status: "pending" });
    }
  }

  // Kill orphaned Docker containers from previous Ripline processes.
  // Containers are named ripline-run-<runId> (full UUID); if the run no longer
  // exists in this store or is not in "running" state, the container is orphaned
  // and should be stopped.  Containers whose runId is not found in this store
  // are skipped — they belong to a different Ripline instance (e.g. a production
  // container visible to a staging server that shares the Docker daemon).
  //
  // Fully async — does not block startup or event loop.
  void (async () => {
    try {
      const { stdout } = await execFileAsync(
        "docker",
        ["ps", "--filter", "name=ripline-run-", "--format", "{{.Names}}"],
        { timeout: 5000 }
      );
      const containerNames = stdout.split("\n").map((n) => n.trim()).filter(Boolean);
      for (const name of containerNames) {
        const match = /^ripline-run-(.+)$/.exec(name);
        if (!match) continue;
        const runId = match[1] as string;
        const run = await store.load(runId);
        if (!run) {
          // Not found in this store — container belongs to a different Ripline
          // instance or store (e.g. production container seen by staging).  Skip.
          continue;
        }
        const status = run.status;
        if (status !== "running") {
          console.warn(`[server] stopping orphaned container ${name} (run ${runId} status: ${status})`);
          await execFileAsync("docker", ["stop", name], { timeout: 30000 }).catch((err: unknown) => {
            console.warn(`[server] failed to stop container ${name}: ${(err as Error).message}`);
          });
        }
      }
    } catch (err) {
      // docker not available or docker ps failed — log and continue
      const msg = (err as Error).message ?? String(err);
      if ((err as NodeJS.ErrnoException).code === "ENOENT" || msg.includes("not found")) {
        console.warn(`[server] docker not available, skipping container orphan cleanup`);
      } else {
        console.warn(`[server] container orphan cleanup skipped: ${msg}`);
      }
    }
  })();

  /** GET /queue - list all items sorted by computed priority score descending */
  fastify.get("/queue", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const items = bgQueue.list().map((item) => ({
        ...item,
        computedPriority: bgQueue.computePriority(item),
      }));
      items.sort((a, b) => b.computedPriority - a.computedPriority);
      return reply.send({ items });
    },
  });

  /** GET /queue/approved - return only pending items sorted by priority */
  fastify.get("/queue/approved", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const items = bgQueue
        .list()
        .filter((item) => item.status === "pending")
        .map((item) => ({
          ...item,
          computedPriority: bgQueue.computePriority(item),
        }));
      items.sort((a, b) => b.computedPriority - a.computedPriority);
      return reply.send({ items });
    },
  });

  /** POST /queue - add a new item with validation */
  fastify.post<{
    Body: {
      pipeline?: string;
      inputs?: Record<string, unknown>;
      severityWeight?: number;
      manualBoost?: number;
      maxRetries?: number;
    };
  }>("/queue", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (!body.pipeline || typeof body.pipeline !== "string" || !body.pipeline.trim()) {
        return reply.status(400).send({ error: "Bad Request", message: "pipeline is required and must be a non-empty string" });
      }
      if (body.inputs !== undefined && (typeof body.inputs !== "object" || body.inputs === null || Array.isArray(body.inputs))) {
        return reply.status(400).send({ error: "Bad Request", message: "inputs must be an object" });
      }
      if (body.severityWeight !== undefined && typeof body.severityWeight !== "number") {
        return reply.status(400).send({ error: "Bad Request", message: "severityWeight must be a number" });
      }
      if (body.manualBoost !== undefined && typeof body.manualBoost !== "number") {
        return reply.status(400).send({ error: "Bad Request", message: "manualBoost must be a number" });
      }
      if (body.maxRetries !== undefined && typeof body.maxRetries !== "number") {
        return reply.status(400).send({ error: "Bad Request", message: "maxRetries must be a number" });
      }

      const addOpts: Parameters<typeof bgQueue.add>[0] = {
        pipeline: (body.pipeline as string).trim(),
      };
      if (body.inputs !== undefined) addOpts.inputs = body.inputs as Record<string, unknown>;
      if (typeof body.severityWeight === "number") addOpts.severityWeight = body.severityWeight;
      if (typeof body.manualBoost === "number") addOpts.manualBoost = body.manualBoost;
      if (typeof body.maxRetries === "number") addOpts.maxRetries = body.maxRetries;
      const id = bgQueue.add(addOpts);
      const item = bgQueue.get(id);
      return reply.status(201).send(item);
    },
  });

  /** PATCH /queue/:id - update allowed fields */
  fastify.patch<{
    Params: { id: string };
    Body: {
      priority?: number;
      manualBoost?: number;
      status?: string;
      severityWeight?: number;
    };
  }>("/queue/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const existing = bgQueue.get(request.params.id);
      if (!existing) {
        return reply.status(404).send({ error: "Not Found", message: `Queue item ${request.params.id} not found` });
      }
      const body = (request.body as Record<string, unknown>) ?? {};
      const patch: Record<string, unknown> = {};
      if (body.priority !== undefined) {
        if (typeof body.priority !== "number") {
          return reply.status(400).send({ error: "Bad Request", message: "priority must be a number" });
        }
        patch.priority = body.priority;
      }
      if (body.manualBoost !== undefined) {
        if (typeof body.manualBoost !== "number") {
          return reply.status(400).send({ error: "Bad Request", message: "manualBoost must be a number" });
        }
        patch.manualBoost = body.manualBoost;
      }
      if (body.severityWeight !== undefined) {
        if (typeof body.severityWeight !== "number") {
          return reply.status(400).send({ error: "Bad Request", message: "severityWeight must be a number" });
        }
        patch.severityWeight = body.severityWeight;
      }
      if (body.status !== undefined) {
        const validStatuses = ["pending", "running", "completed", "errored", "failed"];
        if (typeof body.status !== "string" || !validStatuses.includes(body.status)) {
          return reply.status(400).send({ error: "Bad Request", message: `status must be one of: ${validStatuses.join(", ")}` });
        }
        patch.status = body.status;
      }
      const updated = bgQueue.update(request.params.id, patch);
      return reply.send(updated);
    },
  });

  /** DELETE /queue/:id - remove an item */
  fastify.delete<{ Params: { id: string } }>("/queue/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const removed = bgQueue.remove(request.params.id);
      if (!removed) {
        return reply.status(404).send({ error: "Not Found", message: `Queue item ${request.params.id} not found` });
      }
      return reply.status(204).send();
    },
  });

  // ─── Telegram notifier (retained for future use / other integrations) ────────
  const _telegramNotifier = createTelegramNotifier(userConfig.telegram);

  // NOTE: AutoExecutor has been removed from this process.
  // Dispatch decisions are now owned by an external orchestrator's reconciliation loop,
  // which lazily tops up the queue to the concurrency limit on each tick.
  // BackgroundQueue storage and REST endpoints remain here as-is.

  /** GET /config/background-queue - return current enabled state from config */
  fastify.get("/config/background-queue", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const currentConfig = loadUserConfig();
      const enabled = currentConfig.backgroundQueue?.enabled ?? false;
      return reply.send({ enabled });
    },
  });

  /** GET /config/queues - return current per-queue concurrency and resource limits config */
  fastify.get("/config/queues", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const currentConfig = loadUserConfig();
      const queues = currentConfig.queues ?? {};
      // Include effective concurrencies from scheduler if available
      const effective: Record<string, { concurrency: number; resourceLimits?: ContainerResourceLimits }> = {};
      for (const [name, qc] of Object.entries(mergedQueueConcurrencies)) {
        effective[name] = {
          concurrency: qc,
          ...(mergedQueueResourceLimits[name] !== undefined && { resourceLimits: mergedQueueResourceLimits[name] }),
        };
      }
      return reply.send({ configured: queues, effective });
    },
  });

  /** PUT /config/queues - update per-queue concurrency and resource limits in config (takes effect on restart) */
  fastify.put<{ Body: { queues?: Record<string, { concurrency?: number; resourceLimits?: { cpus?: string; memory?: string } }> } }>("/config/queues", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (!body.queues || typeof body.queues !== "object" || Array.isArray(body.queues)) {
        return reply.status(400).send({ error: "Bad Request", message: "queues is required and must be an object" });
      }

      // Validate each queue entry
      const queuesInput = body.queues as Record<string, unknown>;
      const validated: Record<string, { concurrency: number; resourceLimits?: { cpus?: string; memory?: string } }> = {};
      for (const [name, raw] of Object.entries(queuesInput)) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          return reply.status(400).send({ error: "Bad Request", message: `Queue "${name}" must be an object` });
        }
        const q = raw as Record<string, unknown>;
        const concurrency = typeof q.concurrency === "number" ? Math.max(1, Math.floor(q.concurrency)) : 1;
        const entry: { concurrency: number; resourceLimits?: { cpus?: string; memory?: string } } = { concurrency };
        if (q.resourceLimits && typeof q.resourceLimits === "object" && !Array.isArray(q.resourceLimits)) {
          const rl = q.resourceLimits as Record<string, unknown>;
          const limits: { cpus?: string; memory?: string } = {};
          if (typeof rl.cpus === "string") limits.cpus = rl.cpus;
          if (typeof rl.memory === "string") limits.memory = rl.memory;
          if (Object.keys(limits).length > 0) entry.resourceLimits = limits;
        }
        validated[name] = entry;
      }

      // Persist to config.json
      const configPath = path.join(
        process.env.HOME ?? path.resolve("."),
        ".ripline",
        "config.json",
      );
      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // file missing or invalid — start fresh
      }
      existing.queues = validated;

      const dir = path.dirname(configPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

      return reply.send({ queues: validated, note: "Changes take effect on next Ripline restart" });
    },
  });

  /** PUT /config/background-queue - toggle backgroundQueue.enabled at runtime and persist */
  fastify.put<{ Body: { enabled?: boolean } }>("/config/background-queue", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (typeof body.enabled !== "boolean") {
        return reply.status(400).send({ error: "Bad Request", message: "enabled is required and must be a boolean" });
      }
      const configPath = path.join(
        process.env.HOME ?? path.resolve("."),
        ".ripline",
        "config.json",
      );
      let existing: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(configPath, "utf-8");
        existing = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // file missing or invalid — start fresh
      }
      const bgBlock =
        existing.backgroundQueue && typeof existing.backgroundQueue === "object"
          ? { ...(existing.backgroundQueue as Record<string, unknown>) }
          : {};
      bgBlock.enabled = body.enabled;
      existing.backgroundQueue = bgBlock;

      const dir = path.dirname(configPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(existing, null, 2), "utf-8");

      // Dispatch is now owned externally; no AutoExecutor to toggle at runtime.
      // External orchestrators read this flag from GET /config/background-queue before enqueuing.

      return reply.send({ backgroundQueue: bgBlock });
    },
  });

  // ─── Health endpoints ────────────────────────────────────

  /** GET /health/scheduler - scheduler and background queue health */
  fastify.get("/health/scheduler", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      if (!scheduler) {
        return reply.status(503).send({
          error: "Service Unavailable",
          message: "Scheduler is not initialized (maxConcurrency is 0 and no queues are configured)",
        });
      }

      const metrics = await scheduler.getDetailedMetrics();
      const bgItems = bgQueue.list();
      const bgSummary = {
        total: bgItems.length,
        pending: bgItems.filter((i) => i.status === "pending").length,
        running: bgItems.filter((i) => i.status === "running").length,
        errored: bgItems.filter((i) => i.status === "failed").length,
        needsReview: bgItems.filter((i) => i.needsReview).length,
      };

      const queues: Record<string, { depth: number; activeWorkers: number; maxConcurrency: number }> = {};
      for (const [name, qm] of Object.entries(metrics.queues)) {
        queues[name] = {
          depth: qm.depth,
          activeWorkers: qm.activeWorkers,
          maxConcurrency: qm.maxConcurrency,
        };
      }

      return reply.send({
        scheduler: {
          running: true,
          pollIntervalMs: 500,
          totalQueueDepth: metrics.queueDepth,
          totalActiveWorkers: metrics.activeWorkers,
          queues,
        },
        backgroundQueue: bgSummary,
      });
    },
  });

  // ─── Focus Areas & Epics endpoints ──────────────────────

  const focusAreaStorePath = path.join(
    process.env.HOME ?? path.resolve("."),
    ".ripline",
    "focus-areas.json",
  );
  const faStore = new FocusAreaStore(focusAreaStorePath);

  registerFocusAreaRoutes(fastify, faStore, requireAuth);
  registerEpicRoutes(fastify, faStore, requireAuth);
  registerUsageRoutes(fastify, requireAuth);

  return fastify;
}

export type StartServerOptions = ServerConfig & {
  port?: number;
};

/** Start the HTTP server. Used by the plugin when running standalone. */
export async function startServer(options: StartServerOptions): Promise<{ close: () => Promise<void> }> {
  const riplineConfig = resolveConfig();
  const port = options.httpPort ?? options.port ?? riplineConfig.port;
  const app = await createApp(options);
  await app.listen({ port, host: "0.0.0.0" });
  return {
    close: () => app.close(),
  };
}
