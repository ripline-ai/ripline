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
