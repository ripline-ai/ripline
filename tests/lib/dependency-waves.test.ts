/**
 * Acceptance tests for computeDependencyWaves (Story 1).
 *
 * Covers: Kahn's topological sort, deterministic ordering, cycle detection,
 * dangling-reference rejection, maxPerWave sub-wave splitting, and edge cases.
 */
import { describe, expect, it } from "vitest";
import { computeDependencyWaves, type Story } from "../../src/lib/dependency-waves.js";

// ---------------------------------------------------------------------------
// Core wave grouping (Kahn's algorithm)
// ---------------------------------------------------------------------------

describe("computeDependencyWaves – core grouping", () => {
  it("returns empty array for empty input", () => {
    expect(computeDependencyWaves([])).toEqual([]);
  });

  it("single story produces one wave of one", () => {
    const waves = computeDependencyWaves([{ id: "only" }]);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
    expect(waves[0]![0]!.id).toBe("only");
  });

  it("all independent stories land in a single wave", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
      { id: "C" },
      { id: "D" },
      { id: "E" },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(1);
    expect(waves[0]!.map((s) => s.id).sort()).toEqual(["A", "B", "C", "D", "E"]);
  });

  it("linear chain A→B→C→D produces 4 sequential waves", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
      { id: "D", dependsOn: ["C"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(4);
    expect(waves.map((w) => w.map((s) => s.id))).toEqual([["A"], ["B"], ["C"], ["D"]]);
  });

  it("diamond pattern A→C, B→C produces 2 waves", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
      { id: "C", dependsOn: ["A", "B"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(2);
    expect(waves[0]!.map((s) => s.id).sort()).toEqual(["A", "B"]);
    expect(waves[1]!.map((s) => s.id)).toEqual(["C"]);
  });

  it("complex DAG: fork-join with shared dependency", () => {
    // A → B, A → C, B → D, C → D
    const stories: Story[] = [
      { id: "A" },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(3);
    expect(waves[0]!.map((s) => s.id)).toEqual(["A"]);
    expect(waves[1]!.map((s) => s.id).sort()).toEqual(["B", "C"]);
    expect(waves[2]!.map((s) => s.id)).toEqual(["D"]);
  });

  it("wide fan-out: one story blocks many", () => {
    const stories: Story[] = [
      { id: "root" },
      { id: "leaf1", dependsOn: ["root"] },
      { id: "leaf2", dependsOn: ["root"] },
      { id: "leaf3", dependsOn: ["root"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(2);
    expect(waves[0]!.map((s) => s.id)).toEqual(["root"]);
    expect(waves[1]!.map((s) => s.id).sort()).toEqual(["leaf1", "leaf2", "leaf3"]);
  });

  it("wide fan-in: many stories block one", () => {
    const stories: Story[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
      { id: "sink", dependsOn: ["a", "b", "c"] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(3);
    expect(waves[1]!.map((s) => s.id)).toEqual(["sink"]);
  });

  it("mixed independent and dependent stories", () => {
    // A, B independent; C depends on A; D independent
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
      { id: "C", dependsOn: ["A"] },
      { id: "D" },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(2);
    expect(waves[0]!.map((s) => s.id).sort()).toEqual(["A", "B", "D"]);
    expect(waves[1]!.map((s) => s.id)).toEqual(["C"]);
  });
});

// ---------------------------------------------------------------------------
// Deterministic ordering within waves
// ---------------------------------------------------------------------------

describe("computeDependencyWaves – deterministic ordering", () => {
  it("stories within a wave are sorted by order field then by id", () => {
    const stories: Story[] = [
      { id: "C", order: 1 },
      { id: "A", order: 3 },
      { id: "B", order: 2 },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves[0]!.map((s) => s.id)).toEqual(["C", "B", "A"]);
  });

  it("stories with same order are sorted alphabetically by id", () => {
    const stories: Story[] = [
      { id: "Zeta", order: 1 },
      { id: "Alpha", order: 1 },
      { id: "Mu", order: 1 },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves[0]!.map((s) => s.id)).toEqual(["Alpha", "Mu", "Zeta"]);
  });

  it("stories without order field default to order 0", () => {
    const stories: Story[] = [
      { id: "Z" },
      { id: "A" },
      { id: "M" },
    ];
    const waves = computeDependencyWaves(stories);
    // All order 0, so alphabetical by id
    expect(waves[0]!.map((s) => s.id)).toEqual(["A", "M", "Z"]);
  });
});

// ---------------------------------------------------------------------------
// maxPerWave sub-wave splitting
// ---------------------------------------------------------------------------

describe("computeDependencyWaves – maxPerWave", () => {
  it("splits a single large wave into sub-waves", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
      { id: "C" },
      { id: "D" },
      { id: "E" },
    ];
    const waves = computeDependencyWaves(stories, { maxPerWave: 2 });
    expect(waves).toHaveLength(3); // 2 + 2 + 1
    expect(waves[0]).toHaveLength(2);
    expect(waves[1]).toHaveLength(2);
    expect(waves[2]).toHaveLength(1);
  });

  it("does not split waves smaller than maxPerWave", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
    ];
    const waves = computeDependencyWaves(stories, { maxPerWave: 5 });
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  it("maxPerWave=1 creates one story per sub-wave", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
      { id: "C" },
    ];
    const waves = computeDependencyWaves(stories, { maxPerWave: 1 });
    expect(waves).toHaveLength(3);
    waves.forEach((w) => expect(w).toHaveLength(1));
  });

  it("preserves dependency ordering across split sub-waves", () => {
    // A, B independent; C depends on A
    // Wave 0 = [A, B] split with maxPerWave=1 → [A], [B]
    // Wave 1 = [C]
    const stories: Story[] = [
      { id: "A" },
      { id: "B" },
      { id: "C", dependsOn: ["A"] },
    ];
    const waves = computeDependencyWaves(stories, { maxPerWave: 1 });
    expect(waves).toHaveLength(3);
    // C must come after both A and B sub-waves
    const cWaveIdx = waves.findIndex((w) => w.some((s) => s.id === "C"));
    expect(cWaveIdx).toBe(2);
  });

  it("rejects maxPerWave=0", () => {
    expect(() => computeDependencyWaves([], { maxPerWave: 0 })).toThrow(/maxPerWave/);
  });

  it("rejects non-integer maxPerWave", () => {
    expect(() => computeDependencyWaves([], { maxPerWave: 1.5 })).toThrow(/maxPerWave/);
  });

  it("rejects negative maxPerWave", () => {
    expect(() => computeDependencyWaves([], { maxPerWave: -1 })).toThrow(/maxPerWave/);
  });
});

// ---------------------------------------------------------------------------
// Error handling: cycles and invalid references
// ---------------------------------------------------------------------------

describe("computeDependencyWaves – error handling", () => {
  it("detects simple 2-node cycle", () => {
    const stories: Story[] = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];
    expect(() => computeDependencyWaves(stories)).toThrow(/cycle/i);
  });

  it("detects 3-node cycle", () => {
    const stories: Story[] = [
      { id: "A", dependsOn: ["C"] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    expect(() => computeDependencyWaves(stories)).toThrow(/cycle/i);
  });

  it("cycle error message includes participant IDs", () => {
    const stories: Story[] = [
      { id: "X", dependsOn: ["Y"] },
      { id: "Y", dependsOn: ["X"] },
      { id: "Z" }, // Z is not in the cycle
    ];
    try {
      computeDependencyWaves(stories);
      expect.fail("Should have thrown");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toMatch(/X/);
      expect(msg).toMatch(/Y/);
      // Z should not be mentioned in cycle participants
    }
  });

  it("self-referencing story is a cycle", () => {
    const stories: Story[] = [
      { id: "A", dependsOn: ["A"] },
    ];
    expect(() => computeDependencyWaves(stories)).toThrow(/cycle/i);
  });

  it("rejects reference to non-existent story", () => {
    const stories: Story[] = [
      { id: "A", dependsOn: ["ghost"] },
    ];
    expect(() => computeDependencyWaves(stories)).toThrow(/ghost/);
    expect(() => computeDependencyWaves(stories)).toThrow(/does not exist/);
  });

  it("rejects when one of multiple dependencies is missing", () => {
    const stories: Story[] = [
      { id: "A" },
      { id: "B", dependsOn: ["A", "missing"] },
    ];
    expect(() => computeDependencyWaves(stories)).toThrow(/missing/);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("computeDependencyWaves – edge cases", () => {
  it("stories with empty dependsOn array are treated as independent", () => {
    const stories: Story[] = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(2);
  });

  it("preserves story objects through waves (all properties intact)", () => {
    const stories: Story[] = [
      { id: "A", order: 5 },
      { id: "B", dependsOn: ["A"], order: 10 },
    ];
    const waves = computeDependencyWaves(stories);
    expect(waves[0]![0]).toEqual({ id: "A", order: 5 });
    expect(waves[1]![0]).toEqual({ id: "B", dependsOn: ["A"], order: 10 });
  });
});
