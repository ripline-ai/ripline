import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { FocusAreaStore } from "../focus-area-store.js";

export function registerEpicRoutes(
  fastify: FastifyInstance,
  faStore: FocusAreaStore,
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
): void {
  /** GET /api/epics - list all Epics */
  fastify.get("/api/epics", {
    preHandler: requireAuth,
    handler: async (_request, reply) => {
      const epics = await faStore.listEpics();
      return reply.send({ epics });
    },
  });

  /** POST /api/epics - create a new Epic */
  fastify.post<{ Body: { focusAreaId?: string; name?: string; description?: string } }>("/api/epics", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      if (!body.focusAreaId || typeof body.focusAreaId !== "string") {
        return reply.status(400).send({ error: "Bad Request", message: "focusAreaId is required" });
      }
      if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
        return reply.status(400).send({ error: "Bad Request", message: "name is required" });
      }
      const epic = await faStore.createEpic({
        focusAreaId: body.focusAreaId as string,
        name: (body.name as string).trim(),
        ...(typeof body.description === "string" && { description: body.description.trim() }),
      });
      if (!epic) {
        return reply.status(404).send({ error: "Not Found", message: `Focus Area ${body.focusAreaId} not found` });
      }
      return reply.status(201).send(epic);
    },
  });

  /** GET /api/epics/:id - fetch single Epic */
  fastify.get<{ Params: { id: string } }>("/api/epics/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const epic = await faStore.getEpic(request.params.id);
      if (!epic) {
        return reply.status(404).send({ error: "Not Found", message: `Epic ${request.params.id} not found` });
      }
      return reply.send(epic);
    },
  });

  /** PUT /api/epics/:id - update an Epic */
  fastify.put<{ Params: { id: string }; Body: { name?: string; description?: string; status?: string; focusAreaId?: string } }>("/api/epics/:id", {
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
        const validStatuses = ["draft", "active", "done", "archived"];
        if (typeof body.status !== "string" || !validStatuses.includes(body.status)) {
          return reply.status(400).send({ error: "Bad Request", message: `status must be one of: ${validStatuses.join(", ")}` });
        }
        patch.status = body.status;
      }
      if (body.focusAreaId !== undefined) {
        if (typeof body.focusAreaId !== "string") {
          return reply.status(400).send({ error: "Bad Request", message: "focusAreaId must be a string" });
        }
        patch.focusAreaId = body.focusAreaId;
      }
      const updated = await faStore.updateEpic(request.params.id, patch as any);
      if (!updated) {
        return reply.status(404).send({ error: "Not Found", message: `Epic ${request.params.id} not found` });
      }
      return reply.send(updated);
    },
  });

  /** DELETE /api/epics/:id - delete an Epic */
  fastify.delete<{ Params: { id: string } }>("/api/epics/:id", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const removed = await faStore.deleteEpic(request.params.id);
      if (!removed) {
        return reply.status(404).send({ error: "Not Found", message: `Epic ${request.params.id} not found` });
      }
      return reply.status(204).send();
    },
  });

  /** PATCH /api/epics/:id/stories - add or remove story associations */
  fastify.patch<{ Params: { id: string }; Body: { add?: string[]; remove?: string[] } }>("/api/epics/:id/stories", {
    preHandler: requireAuth,
    handler: async (request, reply) => {
      const body = (request.body as Record<string, unknown>) ?? {};
      const add = Array.isArray(body.add) ? (body.add as string[]).filter((s) => typeof s === "string") : [];
      const remove = Array.isArray(body.remove) ? (body.remove as string[]).filter((s) => typeof s === "string") : [];
      if (add.length === 0 && remove.length === 0) {
        return reply.status(400).send({ error: "Bad Request", message: "At least one of 'add' or 'remove' arrays is required" });
      }
      const updated = await faStore.updateEpicStories(request.params.id, add, remove);
      if (!updated) {
        return reply.status(404).send({ error: "Not Found", message: `Epic ${request.params.id} not found` });
      }
      return reply.send(updated);
    },
  });
}
