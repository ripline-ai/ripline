import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FocusAreaStore } from "../focus-area-store.js";

export function registerFocusAreaRoutes(
  fastify: FastifyInstance,
  faStore: FocusAreaStore,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  /** GET /api/focus-areas - list all Focus Areas */
  fastify.get("/api/focus-areas", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const focusAreas = await faStore.listFocusAreas();
      return reply.send({ focusAreas });
    },
  });

  /** POST /api/focus-areas - create a new Focus Area */
  fastify.post<{ Body: { name?: string; description?: string } }>("/api/focus-areas", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return reply.status(400).send({ error: "Bad Request", message: "name is required" });
      }
      const fa = await faStore.createFocusArea({
        name: (body.name as string).trim(),
        ...(typeof body.description === "string" && { description: body.description.trim() }),
      });
      return reply.status(201).send(fa);
    },
  });

  /** GET /api/focus-areas/:id - fetch single Focus Area */
  fastify.get<{ Params: { id: string } }>("/api/focus-areas/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const fa = await faStore.getFocusArea(request.params.id);
      if (!fa) {
        return reply.status(404).send({ error: "Not Found", message: `Focus Area ${request.params.id} not found` });
      }
      return reply.send(fa);
    },
  });

  /** PUT /api/focus-areas/:id - update a Focus Area */
  fastify.put<{ Params: { id: string }; Body: { name?: string; description?: string; status?: string } }>("/api/focus-areas/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      const patch: Record<string, unknown> = {};
      if (body.name !== undefined) {
        if (typeof body.name !== "string" || !body.name.trim()) {
          return reply.status(400).send({ error: "Bad Request", message: "name must be a non-empty string" });
        }
        patch.name = (body.name as string).trim();
      }
      if (body.description !== undefined) {
        patch.description = typeof body.description === "string" ? body.description.trim() : body.description;
      }
      if (body.status !== undefined) {
        if (body.status !== "active" && body.status !== "archived") {
          return reply.status(400).send({ error: "Bad Request", message: "status must be 'active' or 'archived'" });
        }
        patch.status = body.status;
      }
      const updated = await faStore.updateFocusArea(request.params.id, patch as any);
      if (!updated) {
        return reply.status(404).send({ error: "Not Found", message: `Focus Area ${request.params.id} not found` });
      }
      return reply.send(updated);
    },
  });

  /** DELETE /api/focus-areas/:id - delete a Focus Area (and its linked Epics) */
  fastify.delete<{ Params: { id: string } }>("/api/focus-areas/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const removed = await faStore.deleteFocusArea(request.params.id);
      if (!removed) {
        return reply.status(404).send({ error: "Not Found", message: `Focus Area ${request.params.id} not found` });
      }
      return reply.status(204).send();
    },
  });

  /** GET /api/focus-areas/:id/epics - list Epics linked to a Focus Area */
  fastify.get<{ Params: { id: string } }>("/api/focus-areas/:id/epics", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const fa = await faStore.getFocusArea(request.params.id);
      if (!fa) {
        return reply.status(404).send({ error: "Not Found", message: `Focus Area ${request.params.id} not found` });
      }
      const epics = await faStore.getEpicsByFocusArea(request.params.id);
      return reply.send({ epics });
    },
  });
}
