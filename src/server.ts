import path from "node:path";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyReply,
} from "fastify";
import cors from "@fastify/cors";
import type { PipelinePluginConfig } from "./types.js";
import type { PipelineRunRecord } from "./types.js";
import { PipelineRegistry } from "./registry.js";
import { PipelineRunStore } from "./run-store.js";
import { createRunQueue } from "./run-queue.js";
import { createScheduler } from "./scheduler.js";
import { DeterministicRunner } from "./pipeline/runner.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";

const DEFAULT_RUNS_DIR = ".ripline/runs";
const SSE_POLL_MS = 500;

/** Stub agent for HTTP-triggered runs when no OpenClaw is available. */
const stubAgentRunner: AgentRunner = async ({ agentId, prompt }) => ({
  text: `[http-stub] ${agentId}: ${prompt.slice(0, 80)}…`,
  tokenUsage: { input: 0, output: 0 },
});

export type ServerConfig = PipelinePluginConfig & {
  runsDir?: string;
  /** When set (e.g. by OpenClaw plugin), agent nodes use this runner; otherwise stub. */
  agentRunner?: AgentRunner;
  /** For agent nodes with runner: claude-code. Not set when running inside OpenClaw. */
  claudeCodeRunner?: AgentRunner;
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

  /** GET /pipelines - list definitions (id, name, tags) */
  fastify.get("/pipelines", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const definitions = await registry.list();
      const pipelines = definitions.map((d) => ({
        id: d.id,
        name: d.name,
        tags: d.tags,
      }));
      return reply.send({ pipelines });
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
        const runner = new DeterministicRunner(entry.definition, {
          store,
          runsDir,
          quiet: true,
          agentRunner,
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
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

        const tempRunner = new DeterministicRunner(entry.definition, {
          store,
          runsDir,
          quiet: true,
          agentRunner,
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
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
          const inlineRunner = new DeterministicRunner(entry.definition, {
            store,
            runsDir,
            quiet: true,
            agentRunner,
            ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
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
