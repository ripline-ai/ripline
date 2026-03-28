/**
 * Integration tests for Focus Areas and Epics feature — covers cross-story
 * integration points and edge cases not covered by unit/route tests:
 *
 * - Epic reassignment between focus areas (Store + Routes)
 * - Cascade delete only removes matching epics (leaves others intact)
 * - Focus area keyword-overlap suggestion algorithm (Story 8)
 * - Route-level focusAreaId validation on epic update (Story 2/7)
 * - Story association edge cases (remove non-existent, add+remove same ID)
 * - Empty epics list for a focus area with no epics via routes
 * - Non-string values filtered from PATCH stories payload
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

const noopAuth = async (_request: FastifyRequest, _reply: FastifyReply) => {};

beforeEach(async () => {
  tmpFilePath = path.join(
    os.tmpdir(),
    `fa-integ-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
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

// ─── Epic Reassignment Between Focus Areas ──────────────────────────────────

describe("Epic reassignment via PUT /api/epics/:id", () => {
  it("reassigns an epic to a different valid focus area", async () => {
    const fa1 = await store.createFocusArea({ name: "FA1" });
    const fa2 = await store.createFocusArea({ name: "FA2" });
    const epic = await store.createEpic({ focusAreaId: fa1.id, name: "Movable" });

    const res = await app.inject({
      method: "PUT",
      url: `/api/epics/${epic!.id}`,
      payload: { focusAreaId: fa2.id },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { focusAreaId: string }).focusAreaId).toBe(fa2.id);

    // Verify the reassignment persisted
    const updated = await store.getEpic(epic!.id);
    expect(updated!.focusAreaId).toBe(fa2.id);
  });

  it("rejects reassignment to nonexistent focus area via store", async () => {
    const fa = await store.createFocusArea({ name: "FA" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });

    const result = await store.updateEpic(epic!.id, { focusAreaId: "nonexistent" });
    expect(result).toBeNull();

    // Epic should retain original focusAreaId
    const unchanged = await store.getEpic(epic!.id);
    expect(unchanged!.focusAreaId).toBe(fa.id);
  });

  it("reassigned epic appears in new focus area's epic list", async () => {
    const fa1 = await store.createFocusArea({ name: "Source" });
    const fa2 = await store.createFocusArea({ name: "Target" });
    const epic = await store.createEpic({ focusAreaId: fa1.id, name: "Migrating" });

    await store.updateEpic(epic!.id, { focusAreaId: fa2.id });

    const fa1Epics = await store.getEpicsByFocusArea(fa1.id);
    const fa2Epics = await store.getEpicsByFocusArea(fa2.id);
    expect(fa1Epics).toHaveLength(0);
    expect(fa2Epics).toHaveLength(1);
    expect(fa2Epics[0].name).toBe("Migrating");
  });
});

// ─── Cascade Delete — Selective ─────────────────────────────────────────────

describe("Cascade delete selectivity", () => {
  it("deleting one focus area only cascades its own epics, not others", async () => {
    const fa1 = await store.createFocusArea({ name: "FA1" });
    const fa2 = await store.createFocusArea({ name: "FA2" });
    await store.createEpic({ focusAreaId: fa1.id, name: "E1-A" });
    await store.createEpic({ focusAreaId: fa1.id, name: "E1-B" });
    const e2 = await store.createEpic({ focusAreaId: fa2.id, name: "E2-A" });

    // Cascade via route
    const res = await app.inject({ method: "DELETE", url: `/api/focus-areas/${fa1.id}` });
    expect(res.statusCode).toBe(204);

    // FA2's epic is untouched
    const remaining = await store.listEpics();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(e2!.id);

    // FA2 and its epic are accessible via routes
    const faRes = await app.inject({ method: "GET", url: `/api/focus-areas/${fa2.id}/epics` });
    expect(faRes.statusCode).toBe(200);
    expect((faRes.json() as { epics: unknown[] }).epics).toHaveLength(1);
  });

  it("cascade delete also removes epics with linked stories", async () => {
    const fa = await store.createFocusArea({ name: "Parent" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "WithStories" });
    await store.updateEpicStories(epic!.id, ["s1", "s2", "s3"], []);

    await store.deleteFocusArea(fa.id);
    expect(await store.listEpics()).toHaveLength(0);
  });
});

// ─── Focus Area with No Epics ───────────────────────────────────────────────

describe("GET /api/focus-areas/:id/epics — empty case", () => {
  it("returns empty epics array for focus area with no linked epics", async () => {
    const fa = await store.createFocusArea({ name: "Lonely" });

    const res = await app.inject({
      method: "GET",
      url: `/api/focus-areas/${fa.id}/epics`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { epics: unknown[] }).epics).toEqual([]);
  });
});

// ─── Story Association Edge Cases ───────────────────────────────────────────

describe("updateEpicStories — edge cases", () => {
  it("removing a story ID that is not in the array is a no-op", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2"], []);

    const updated = await store.updateEpicStories(epic!.id, [], ["s99"]);
    expect(updated!.storyIds).toEqual(["s1", "s2"]);
  });

  it("adding and removing the same ID in one operation: remove wins then re-add", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2"], []);

    // Remove s1 then add s1 → s1 should be re-added (remove-first semantics)
    const updated = await store.updateEpicStories(epic!.id, ["s1"], ["s1"]);
    expect(updated!.storyIds).toContain("s1");
    expect(updated!.storyIds).toContain("s2");
  });

  it("adding empty array with non-empty remove only removes", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2", "s3"], []);

    const updated = await store.updateEpicStories(epic!.id, [], ["s1", "s3"]);
    expect(updated!.storyIds).toEqual(["s2"]);
  });
});

describe("PATCH /api/epics/:id/stories — non-string filtering", () => {
  it("filters out non-string values from add array", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/epics/${epic!.id}/stories`,
      payload: { add: ["s1", 42, null, "s2", true] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { storyIds: string[] }).storyIds).toEqual(["s1", "s2"]);
  });

  it("filters out non-string values from remove array", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "E" });
    await store.updateEpicStories(epic!.id, ["s1", "s2", "s3"], []);

    const res = await app.inject({
      method: "PATCH",
      url: `/api/epics/${epic!.id}/stories`,
      payload: { remove: ["s2", 99, false] },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { storyIds: string[] }).storyIds).toEqual(["s1", "s3"]);
  });
});

// ─── Focus Area Keyword-Overlap Suggestion Algorithm (Story 8) ──────────────
// The suggest_focus_area transform in flesh_out_idea.yaml uses a pure-JS
// keyword-overlap algorithm. We replicate the exact logic here for testability.

describe("Focus Area keyword-overlap suggestion algorithm", () => {
  const STOP_WORDS = [
    "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "must", "it", "its",
    "this", "that", "these", "those", "i", "we", "you", "he", "she", "they",
    "me", "us", "him", "her", "them", "my", "our", "your", "his", "their",
    "not", "no", "from", "as", "into", "about", "between", "through", "during",
    "before", "after", "above", "below", "up", "down", "out", "off", "over",
    "under", "then", "than", "so", "if", "when", "where", "how", "what",
    "which", "who", "whom", "why", "all", "each", "every", "both", "few",
    "more", "most", "other", "some", "such", "only", "own", "same", "just",
    "also", "very", "even", "back", "now", "new", "old", "first", "last",
    "long", "great", "small", "large", "next", "early", "young", "important",
    "different", "used", "make", "like", "use", "many", "way", "well", "get",
  ];

  function tokenize(text: string): string[] {
    return text
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.includes(w));
  }

  function suggestFocusArea(
    idea: { title?: string; description?: string; rationale?: string; tags?: string[] },
    focusAreas: Array<{ id: string; name: string; description?: string; status: string }>,
  ): string | null {
    const active = focusAreas.filter((fa) => fa.status === "active");
    if (active.length === 0) return null;

    const ideaText = (
      (idea.title || "") + " " +
      (idea.description || "") + " " +
      (idea.rationale || "") + " " +
      ((idea.tags || []).join(" "))
    ).toLowerCase();

    const ideaTokens = tokenize(ideaText);
    if (ideaTokens.length === 0) return null;

    const ideaSet: Record<string, boolean> = {};
    ideaTokens.forEach((t) => { ideaSet[t] = true; });

    let bestId: string | null = null;
    let bestScore = 0;

    active.forEach((fa) => {
      const faText = ((fa.name || "") + " " + (fa.description || "")).toLowerCase();
      const faTokens = tokenize(faText);
      if (faTokens.length === 0) return;
      let overlap = 0;
      faTokens.forEach((t) => { if (ideaSet[t]) overlap++; });
      const score = overlap / faTokens.length;
      if (score > bestScore) { bestScore = score; bestId = fa.id; }
    });

    if (bestScore >= 0.3 && bestId) return bestId;
    return null;
  }

  it("returns null when no focus areas exist", () => {
    expect(suggestFocusArea({ title: "Auth system" }, [])).toBeNull();
  });

  it("returns null when all focus areas are archived", () => {
    const areas = [
      { id: "fa1", name: "Auth", description: "Authentication", status: "archived" },
    ];
    expect(suggestFocusArea({ title: "Auth system" }, areas)).toBeNull();
  });

  it("returns null when idea has no meaningful tokens (stop words only)", () => {
    const areas = [
      { id: "fa1", name: "Auth Flow", description: "Login handling", status: "active" },
    ];
    expect(suggestFocusArea({ title: "the and but or" }, areas)).toBeNull();
  });

  it("returns null when idea text is empty", () => {
    const areas = [
      { id: "fa1", name: "Pipeline", description: "Pipelines", status: "active" },
    ];
    expect(suggestFocusArea({}, areas)).toBeNull();
  });

  it("matches idea to focus area with overlapping keywords", () => {
    const areas = [
      { id: "fa-auth", name: "Authentication", description: "Login, SSO, OAuth", status: "active" },
      { id: "fa-pipe", name: "Pipeline Engine", description: "Execution and scheduling", status: "active" },
    ];
    const idea = { title: "OAuth token refresh", description: "Implement automatic OAuth token refresh for SSO" };
    expect(suggestFocusArea(idea, areas)).toBe("fa-auth");
  });

  it("returns null when overlap is below 30% threshold", () => {
    const areas = [
      { id: "fa1", name: "Pipeline Engine Scheduling Runner Executor Queue", status: "active" },
    ];
    // Only "pipeline" overlaps out of 6+ tokens → ~17% overlap < 30%
    const idea = { title: "pipeline monitoring dashboard" };
    expect(suggestFocusArea(idea, areas)).toBeNull();
  });

  it("selects the focus area with the highest overlap score", () => {
    const areas = [
      { id: "fa-general", name: "General improvements", description: "Misc enhancements", status: "active" },
      { id: "fa-auth", name: "Auth", description: "OAuth login SSO", status: "active" },
      { id: "fa-exact", name: "OAuth token refresh", description: "SSO improvements", status: "active" },
    ];
    const idea = { title: "OAuth token refresh for SSO" };
    expect(suggestFocusArea(idea, areas)).toBe("fa-exact");
  });

  it("is case insensitive", () => {
    const areas = [
      { id: "fa1", name: "AUTHENTICATION SYSTEM", description: "Login OAuth", status: "active" },
    ];
    const idea = { title: "authentication oauth login" };
    expect(suggestFocusArea(idea, areas)).toBe("fa1");
  });

  it("strips special characters during tokenization", () => {
    const areas = [
      { id: "fa1", name: "Auth (OAuth2.0)", description: "Token-based login", status: "active" },
    ];
    // "oauth2" and "token" and "login" should match after stripping special chars
    const idea = { title: "token-based oauth2 login system" };
    const result = suggestFocusArea(idea, areas);
    expect(result).toBe("fa1");
  });

  it("uses idea tags for matching", () => {
    const areas = [
      { id: "fa-pipe", name: "Pipeline Engine", description: "Execution runtime", status: "active" },
    ];
    const idea = { title: "New feature", tags: ["pipeline", "engine", "execution"] };
    expect(suggestFocusArea(idea, areas)).toBe("fa-pipe");
  });

  it("ignores archived focus areas even if they have better overlap", () => {
    const areas = [
      { id: "fa-archived", name: "OAuth login SSO token refresh", status: "archived" },
      { id: "fa-active", name: "Auth security", description: "OAuth handling", status: "active" },
    ];
    const idea = { title: "OAuth login SSO token refresh" };
    const result = suggestFocusArea(idea, areas);
    expect(result).not.toBe("fa-archived");
    // Should either be fa-active or null, but never the archived one
    if (result !== null) {
      expect(result).toBe("fa-active");
    }
  });
});

// ─── Full Cross-Story Integration ───────────────────────────────────────────

describe("Cross-story integration: FA → Epic → Stories lifecycle via routes", () => {
  it("creates focus area, creates epic, links stories, verifies retrieval, deletes all", async () => {
    // Story 1/2: Create a focus area via POST
    const faRes = await app.inject({
      method: "POST",
      url: "/api/focus-areas",
      payload: { name: "Platform Core", description: "Infrastructure work" },
    });
    expect(faRes.statusCode).toBe(201);
    const fa = faRes.json() as { id: string };

    // Story 2/7: Create an epic linked to the focus area
    const epicRes = await app.inject({
      method: "POST",
      url: "/api/epics",
      payload: { focusAreaId: fa.id, name: "Auth Overhaul", description: "Complete rewrite" },
    });
    expect(epicRes.statusCode).toBe(201);
    const epic = epicRes.json() as { id: string; storyIds: string[] };
    expect(epic.storyIds).toEqual([]);

    // Story 7: Link stories to the epic (mimics feature pipeline auto-linking)
    const storyRes = await app.inject({
      method: "PATCH",
      url: `/api/epics/${epic.id}/stories`,
      payload: { add: ["story-1", "story-2", "story-3"] },
    });
    expect(storyRes.statusCode).toBe(200);
    expect((storyRes.json() as { storyIds: string[] }).storyIds).toEqual([
      "story-1", "story-2", "story-3",
    ]);

    // Verify focus area's epics endpoint
    const faEpicsRes = await app.inject({
      method: "GET",
      url: `/api/focus-areas/${fa.id}/epics`,
    });
    expect(faEpicsRes.statusCode).toBe(200);
    const faEpics = faEpicsRes.json() as { epics: Array<{ id: string; storyIds: string[] }> };
    expect(faEpics.epics).toHaveLength(1);
    expect(faEpics.epics[0].storyIds).toHaveLength(3);

    // Story 1/2: Delete the focus area — cascade should remove epic
    const delRes = await app.inject({ method: "DELETE", url: `/api/focus-areas/${fa.id}` });
    expect(delRes.statusCode).toBe(204);

    // Verify everything is cleaned up
    expect(await store.listFocusAreas()).toHaveLength(0);
    expect(await store.listEpics()).toHaveLength(0);
  });

  it("epic status progression: draft → active → done → archived", async () => {
    const fa = await store.createFocusArea({ name: "P" });
    const epic = await store.createEpic({ focusAreaId: fa.id, name: "Flow" });

    for (const status of ["active", "done", "archived"] as const) {
      const res = await app.inject({
        method: "PUT",
        url: `/api/epics/${epic!.id}`,
        payload: { status },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { status: string }).status).toBe(status);
    }
  });

  it("focus area status toggle: active → archived → active", async () => {
    const fa = await store.createFocusArea({ name: "Toggleable" });

    let res = await app.inject({
      method: "PUT",
      url: `/api/focus-areas/${fa.id}`,
      payload: { status: "archived" },
    });
    expect((res.json() as { status: string }).status).toBe("archived");

    res = await app.inject({
      method: "PUT",
      url: `/api/focus-areas/${fa.id}`,
      payload: { status: "active" },
    });
    expect((res.json() as { status: string }).status).toBe("active");
  });
});
