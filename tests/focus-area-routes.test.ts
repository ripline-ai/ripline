/**
 * Tests for Focus Area and Epic HTTP routes — Story 2 acceptance criteria:
 * CRUD endpoints, validation, error responses, auth, cascading deletes,
 * and Story 7 PATCH /epics/:id/stories for story association management.
 *
 * Uses Fastify's inject() for in-process HTTP testing.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import Fastify from "fastify";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { FocusAreaStore } from "../src/focus-area-store.js";
import { registerFocusAreaRoutes } from "../src/routes/focus-areas.js";
import { registerEpicRoutes } from "../src/routes/epics.js";

let app: FastifyInstance;
let store: FocusAreaStore;
let tmpFilePath: string;
const cleanupPaths: string[] = [];

// No-op auth for testing
const noopAuth = async (_request: FastifyRequest, _reply: FastifyReply) => {};

beforeEach(async () => {
  tmpFilePath = path.join(
    os.tmpdir(),
    `fa-routes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  cleanupPaths.push(tmpFilePath);

  store = new FocusAreaStore(tmpFilePath);
  app = Fastify();
  registerFocusAreaRoutes(app, store, noopAuth);
  registerEpicRoutes(app, store, noopAuth);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  for (const p of cleanupPaths) {
    await fs.rm(p, { force: true }).catch(() => {});
  }
  cleanupPaths.length = 0;
});

// ─── Focus Area Routes ───────────────────────────────────────────────────────

describe("GET /api/focus-areas", () => {
  it("returns empty list on fresh store", async () => {
    const res = await app.inject({ method: "GET", url: "/api/focus-areas" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { focusAreas: unknown[] }).focusAreas).toEqual([]);
  });

  it("returns all focus areas", async () => {
    await store.createFocusArea({ name: "Engine" });
    const res = await app.inject({ method: "GET", url: "/api/focus-areas" });
    expect((res.json() as { focusAreas: unknown[] }).focusAreas).toHaveLength(1);
  });
});

describe("POST /api/focus-areas", () => {
  it("creates a focus area and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/focus-areas",
      payload: { name: "New Area", description: "Important" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; name: string; status: string };
    expect(body.id).toBeDefined();
    expect(body.name).toBe("New Area");
    expect(body.status).toBe("active");
  });

  it("returns 400 when name is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/focus-areas",
      payload: { description: "No name" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for blank name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/focus-areas",
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /api/focus-areas/:id", () => {
  it("returns the focus area", async () => {
    const fa = await store.createFocusArea({ name: "Eng" });
    const res = await app.inject({ method: "GET", url: `/api/focus-areas/${fa.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("Eng");
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/focus-areas/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /api/focus-areas/:id", () => {
  it("updates name", async () => {
    const fa = await store.createFocusArea({ name: "Old" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/focus-areas/${fa.id}`,
      payload: { name: "New" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("New");
  });

  it("updates status to archived", async () => {
    const fa = await store.createFocusArea({ name: "X" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/focus-areas/${fa.id}`,
      payload: { status: "archived" },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe("archived");
  });

  it("returns 400 for invalid status", async () => {
    const fa = await store.createFocusArea({ name: "X" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/focus-areas/${fa.id}`,
      payload: { status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 for blank name", async () => {
    const fa = await store.createFocusArea({ name: "X" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/focus-areas/${fa.id}`,
      payload: { name: "   " },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/focus-areas/nonexistent",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/focus-areas/:id", () => {
  it("deletes and returns 204", async () => {
    const fa = await store.createFocusArea({ name: "X" });
    const res = await app.inject({ method: "DELETE", url: `/api/focus-areas/${fa.id}` });
    expect(res.statusCode).toBe(204);
    expect(await store.listFocusAreas()).toHaveLength(0);
  });

  it("cascades deletion to linked epics", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    await store.createEpic({ focusAreaId: fa.id, name: "Child" });
    await app.inject({ method: "DELETE", url: `/api/focus-areas/${fa.id}` });
    expect(await store.listEpics()).toHaveLength(0);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/focus-areas/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/focus-areas/:id/epics", () => {
  it("returns epics linked to the focus area", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    await store.createEpic({ focusAreaId: fa.id, name: "E1" });
    await store.createEpic({ focusAreaId: fa.id, name: "E2" });

    const res = await app.inject({ method: "GET", url: `/api/focus-areas/${fa.id}/epics` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { epics: unknown[] }).epics).toHaveLength(2);
  });

  it("returns 404 when focus area does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/focus-areas/nonexistent/epics" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── Epic Routes ─────────────────────────────────────────────────────────────

describe("GET /api/epics", () => {
  it("returns empty list on fresh store", async () => {
    const res = await app.inject({ method: "GET", url: "/api/epics" });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { epics: unknown[] }).epics).toEqual([]);
  });
});

describe("POST /api/epics", () => {
  it("creates an epic linked to a focus area", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const res = await app.inject({
      method: "POST",
      url: "/api/epics",
      payload: { focusAreaId: fa.id, name: "Auth Epic" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { name: string; status: string; storyIds: string[] };
    expect(body.name).toBe("Auth Epic");
    expect(body.status).toBe("draft");
    expect(body.storyIds).toEqual([]);
  });

  it("returns 400 when name is missing", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const res = await app.inject({
      method: "POST",
      url: "/api/epics",
      payload: { focusAreaId: fa.id },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 400 when focusAreaId is missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/epics",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 when focusAreaId does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/epics",
      payload: { focusAreaId: "nonexistent", name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("GET /api/epics/:id", () => {
  it("returns the epic", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const res = await app.inject({ method: "GET", url: `/api/epics/${epic!.id}` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { name: string }).name).toBe("E");
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "GET", url: "/api/epics/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});

describe("PUT /api/epics/:id", () => {
  it("updates name and status", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "Old" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/epics/${epic!.id}`,
      payload: { name: "New", status: "active" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { name: string; status: string };
    expect(body.name).toBe("New");
    expect(body.status).toBe("active");
  });

  it("rejects invalid status", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const res = await app.inject({
      method: "PUT",
      url: `/api/epics/${epic!.id}`,
      payload: { status: "bogus" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/api/epics/nonexistent",
      payload: { name: "X" },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("DELETE /api/epics/:id", () => {
  it("deletes and returns 204", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const res = await app.inject({ method: "DELETE", url: `/api/epics/${epic!.id}` });
    expect(res.statusCode).toBe(204);
    expect(await store.listEpics()).toHaveLength(0);
  });

  it("returns 404 for unknown id", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/epics/nonexistent" });
    expect(res.statusCode).toBe(404);
  });
});

// ─── PATCH /api/epics/:id/stories — Story association management ─────────────

describe("PATCH /api/epics/:id/stories", () => {
  it("adds stories to an epic", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/epics/${epic!.id}/stories`,
      payload: { add: ["s1", "s2"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { storyIds: string[] }).storyIds).toEqual(["s1", "s2"]);
  });

  it("removes stories from an epic", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2", "s3"], []);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/epics/${epic!.id}/stories`,
      payload: { remove: ["s2"] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { storyIds: string[] }).storyIds).toEqual(["s1", "s3"]);
  });

  it("returns 400 when both add and remove are empty/missing", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    const res = await app.inject({
      method: "PATCH",
      url: `/api/epics/${epic!.id}/stories`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 404 for unknown epic id", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/epics/nonexistent/stories",
      payload: { add: ["s1"] },
    });
    expect(res.statusCode).toBe(404);
  });
});
