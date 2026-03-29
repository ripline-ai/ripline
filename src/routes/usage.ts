/* ------------------------------------------------------------------ */
/*  Usage API routes — GET/POST /api/usage, GET/PUT /api/usage/config  */
/* ------------------------------------------------------------------ */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getUsageStore } from "../lib/usageStore.js";
import type { UsageConfig } from "../lib/usageTypes.js";

/**
 * Compute the ISO-8601 start-of-week timestamp for a given reset day.
 * resetDay: 0 = Sunday, 1 = Monday, etc.
 */
function getWeekStart(resetDay: number): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun
  const diff = (day - resetDay + 7) % 7;
  const start = new Date(now);
  start.setUTCDate(start.getUTCDate() - diff);
  start.setUTCHours(0, 0, 0, 0);
  return start.toISOString();
}

export function registerUsageRoutes(
  fastify: FastifyInstance,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  const store = getUsageStore();

  /* ---------------------------------------------------------------- */
  /*  GET /api/usage                                                   */
  /* ---------------------------------------------------------------- */
  fastify.get("/api/usage", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      await store.waitReady();
      const config = await store.getConfig();
      const since = getWeekStart(config.resetDay);
      const agg = await store.getAggregates(since);

      const total = agg.totalTokens;
      const cap = config.weeklyTokenCap;
      const remaining = cap > 0 ? Math.max(0, cap - total) : null;
      const percentage = cap > 0 ? Math.min(100, (total / cap) * 100) : null;

      // Burn rate: tokens per hour based on the elapsed hours in this window
      const elapsedMs = Date.now() - new Date(since).getTime();
      const elapsedHours = elapsedMs / (1000 * 60 * 60);
      const burnRate = elapsedHours > 0 ? total / elapsedHours : 0;

      return reply.send({
        total,
        remaining,
        percentage,
        burnRate: Math.round(burnRate * 100) / 100,
        perPipeline: agg.byPipeline,
        hourlyBuckets: agg.hourlyBuckets,
      });
    },
  });

  /* ---------------------------------------------------------------- */
  /*  POST /api/usage                                                  */
  /* ---------------------------------------------------------------- */
  fastify.post<{
    Body: {
      pipelineId?: string;
      runId?: string;
      promptTokens?: number;
      completionTokens?: number;
      model?: string;
    };
  }>("/api/usage", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};

      const promptTokens = body.promptTokens;
      const completionTokens = body.completionTokens;

      if (typeof promptTokens !== "number" || promptTokens < 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "promptTokens is required and must be a non-negative number",
        });
      }
      if (typeof completionTokens !== "number" || completionTokens < 0) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "completionTokens is required and must be a non-negative number",
        });
      }

      await store.waitReady();
      const event = await store.appendEvent({
        inputTokens: promptTokens,
        outputTokens: completionTokens,
        ...(typeof body.pipelineId === "string" && { pipelineId: body.pipelineId }),
        ...(typeof body.model === "string" && { model: body.model }),
        ...(typeof body.runId === "string" && { meta: { runId: body.runId } }),
      });

      return reply.status(201).send(event);
    },
  });

  /* ---------------------------------------------------------------- */
  /*  GET /api/usage/config                                            */
  /* ---------------------------------------------------------------- */
  fastify.get("/api/usage/config", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      await store.waitReady();
      const config = await store.getConfig();
      return reply.send(config);
    },
  });

  /* ---------------------------------------------------------------- */
  /*  PUT /api/usage/config                                            */
  /* ---------------------------------------------------------------- */
  fastify.put<{
    Body: Partial<UsageConfig>;
  }>("/api/usage/config", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};

      await store.waitReady();
      const current = await store.getConfig();

      // Validate and merge each field
      if (body.weeklyTokenCap !== undefined) {
        if (typeof body.weeklyTokenCap !== "number" || body.weeklyTokenCap < 0) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "weeklyTokenCap must be a non-negative number",
          });
        }
        current.weeklyTokenCap = body.weeklyTokenCap;
      }

      if (body.thresholdPercents !== undefined) {
        if (
          !Array.isArray(body.thresholdPercents) ||
          !body.thresholdPercents.every(
            (v: unknown) => typeof v === "number" && v >= 0 && v <= 100,
          )
        ) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "thresholdPercents must be an array of numbers between 0 and 100",
          });
        }
        current.thresholdPercents = (body.thresholdPercents as number[]).sort(
          (a, b) => a - b,
        );
      }

      if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") {
          return reply.status(400).send({
            error: "Bad Request",
            message: "enabled must be a boolean",
          });
        }
        current.enabled = body.enabled;
      }

      if (body.resetDay !== undefined) {
        if (
          typeof body.resetDay !== "number" ||
          !Number.isInteger(body.resetDay) ||
          body.resetDay < 0 ||
          body.resetDay > 6
        ) {
          return reply.status(400).send({
            error: "Bad Request",
            message: "resetDay must be an integer between 0 (Sunday) and 6 (Saturday)",
          });
        }
        current.resetDay = body.resetDay;
      }

      await store.setConfig(current);
      return reply.send(current);
    },
  });
}
