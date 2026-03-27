import { describe, it, expect } from "vitest";
import { DependencyGraph, Idea } from "./dependency-graph.js";

// ── Helpers ───────────────────────────────────────────────────

function idea(
  id: string,
  opts: Partial<Omit<Idea, "id">> = {},
): Idea {
  return { id, ...opts };
}

// ── Tests ─────────────────────────────────────────────────────

describe("DependencyGraph", () => {
  // ── Construction ──────────────────────────────────────────

  it("constructs from an empty array", () => {
    const g = new DependencyGraph([]);
    expect(g.transitiveBlockCount("x")).toBe(0);
  });

  it("constructs from valid DAGs without errors", () => {
    const ideas: Idea[] = [
      idea("a"),
      idea("b", { blockedBy: ["a"] }),
      idea("c", { blockedBy: ["a"] }),
      idea("d", { blockedBy: ["b", "c"] }),
    ];
    expect(() => new DependencyGraph(ideas)).not.toThrow();
  });

  // ── transitiveBlockCount ──────────────────────────────────

  describe("transitiveBlockCount", () => {
    it("returns 0 for isolated nodes", () => {
      const g = new DependencyGraph([idea("a"), idea("b")]);
      expect(g.transitiveBlockCount("a")).toBe(0);
      expect(g.transitiveBlockCount("b")).toBe(0);
    });

    it("counts a single chain correctly", () => {
      // a → b → c → d
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
        idea("c", { blockedBy: ["b"] }),
        idea("d", { blockedBy: ["c"] }),
      ]);
      expect(g.transitiveBlockCount("a")).toBe(3); // blocks b, c, d
      expect(g.transitiveBlockCount("b")).toBe(2); // blocks c, d
      expect(g.transitiveBlockCount("c")).toBe(1); // blocks d
      expect(g.transitiveBlockCount("d")).toBe(0);
    });

    it("counts diamond dependency correctly (no double-counting)", () => {
      //   a
      //  / \
      // b   c
      //  \ /
      //   d
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
        idea("c", { blockedBy: ["a"] }),
        idea("d", { blockedBy: ["b", "c"] }),
      ]);
      expect(g.transitiveBlockCount("a")).toBe(3); // b, c, d
      expect(g.transitiveBlockCount("b")).toBe(1); // d
      expect(g.transitiveBlockCount("c")).toBe(1); // d
    });

    it("returns 0 for unknown ids", () => {
      const g = new DependencyGraph([idea("a")]);
      expect(g.transitiveBlockCount("unknown")).toBe(0);
    });
  });

  // ── isBlocked ─────────────────────────────────────────────

  describe("isBlocked", () => {
    it("returns false for nodes with no dependencies", () => {
      const g = new DependencyGraph([idea("a")]);
      expect(g.isBlocked("a")).toBe(false);
    });

    it("returns true when upstream idea is open", () => {
      const g = new DependencyGraph([
        idea("a", { status: "open" }),
        idea("b", { blockedBy: ["a"] }),
      ]);
      expect(g.isBlocked("b")).toBe(true);
    });

    it("returns false when all upstream ideas are done", () => {
      const g = new DependencyGraph([
        idea("a", { status: "done" }),
        idea("b", { blockedBy: ["a"] }),
      ]);
      expect(g.isBlocked("b")).toBe(false);
    });

    it("returns false when all upstream ideas are built", () => {
      const g = new DependencyGraph([
        idea("a", { status: "built" }),
        idea("b", { blockedBy: ["a"] }),
      ]);
      expect(g.isBlocked("b")).toBe(false);
    });

    it("returns true when any one upstream is not done", () => {
      const g = new DependencyGraph([
        idea("a", { status: "done" }),
        idea("b", { status: "in-progress" }),
        idea("c", { blockedBy: ["a", "b"] }),
      ]);
      expect(g.isBlocked("c")).toBe(true);
    });

    it("returns false for unknown ids", () => {
      const g = new DependencyGraph([idea("a")]);
      expect(g.isBlocked("unknown")).toBe(false);
    });
  });

  // ── wouldCreateCycle ──────────────────────────────────────

  describe("wouldCreateCycle", () => {
    it("returns true for self-loop", () => {
      const g = new DependencyGraph([idea("a")]);
      expect(g.wouldCreateCycle("a", "a")).toBe(true);
    });

    it("returns true for direct back-edge", () => {
      // a → b exists, adding b → a would cycle
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
      ]);
      expect(g.wouldCreateCycle("b", "a")).toBe(true);
    });

    it("returns false for valid new edge", () => {
      const g = new DependencyGraph([
        idea("a"),
        idea("b"),
      ]);
      expect(g.wouldCreateCycle("a", "b")).toBe(false);
    });

    it("detects transitive cycle (3+ nodes)", () => {
      // a → b → c exists, adding c → a would create a cycle
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
        idea("c", { blockedBy: ["b"] }),
      ]);
      expect(g.wouldCreateCycle("c", "a")).toBe(true);
    });

    it("no false positive on unrelated nodes", () => {
      // a → b → c, d is isolated
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
        idea("c", { blockedBy: ["b"] }),
        idea("d"),
      ]);
      expect(g.wouldCreateCycle("d", "a")).toBe(false);
      expect(g.wouldCreateCycle("a", "d")).toBe(false);
    });

    it("detects cycle through diamond", () => {
      //   a
      //  / \
      // b   c
      //  \ /
      //   d
      // Adding a blockedBy d would create a cycle
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
        idea("c", { blockedBy: ["a"] }),
        idea("d", { blockedBy: ["b", "c"] }),
      ]);
      expect(g.wouldCreateCycle("d", "a")).toBe(true);
      expect(g.wouldCreateCycle("d", "b")).toBe(true);
    });
  });

  // ── computeEffectivePriority ──────────────────────────────

  describe("computeEffectivePriority", () => {
    it("returns raw priority for isolated nodes", () => {
      const g = new DependencyGraph([idea("a", { priority: 5 })]);
      expect(g.computeEffectivePriority("a", 2)).toBe(5);
    });

    it("boosts priority by boostFactor * transitiveBlockCount", () => {
      const g = new DependencyGraph([
        idea("a", { priority: 3 }),
        idea("b", { blockedBy: ["a"] }),
        idea("c", { blockedBy: ["a"] }),
      ]);
      // transitiveBlockCount("a") = 2, so effective = 3 + 10*2 = 23
      expect(g.computeEffectivePriority("a", 10)).toBe(23);
    });

    it("defaults rawPriority to 0 when not set", () => {
      const g = new DependencyGraph([
        idea("a"),
        idea("b", { blockedBy: ["a"] }),
      ]);
      expect(g.computeEffectivePriority("a", 5)).toBe(5);
    });

    it("works with boostFactor of 0", () => {
      const g = new DependencyGraph([
        idea("a", { priority: 7 }),
        idea("b", { blockedBy: ["a"] }),
      ]);
      expect(g.computeEffectivePriority("a", 0)).toBe(7);
    });
  });
});
