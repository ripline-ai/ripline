import { describe, it, expect } from "vitest";
import { computeDependencyWaves, type Story } from "../src/lib/dependency-waves.js";

describe("computeDependencyWaves", () => {
  /* ── Basic wave computation ──────────────────────────────────────── */

  it("returns empty array for empty input", () => {
    expect(computeDependencyWaves([])).toEqual([]);
  });

  it("puts all independent stories in wave 0", () => {
    const stories: Story[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
    ];

    const waves = computeDependencyWaves(stories);

    expect(waves).toHaveLength(1);
    expect(waves[0]!.map((s) => s.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("separates dependent stories into later waves", () => {
    const stories: Story[] = [
      { id: "a" },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];

    const waves = computeDependencyWaves(stories);

    expect(waves).toHaveLength(3);
    expect(waves[0]!.map((s) => s.id)).toEqual(["a"]);
    expect(waves[1]!.map((s) => s.id)).toEqual(["b"]);
    expect(waves[2]!.map((s) => s.id)).toEqual(["c"]);
  });

  it("groups stories that share the same dependencies in the same wave", () => {
    const stories: Story[] = [
      { id: "foundation" },
      { id: "feature-a", dependsOn: ["foundation"] },
      { id: "feature-b", dependsOn: ["foundation"] },
      { id: "integration", dependsOn: ["feature-a", "feature-b"] },
    ];

    const waves = computeDependencyWaves(stories);

    expect(waves).toHaveLength(3);
    expect(waves[0]!.map((s) => s.id)).toEqual(["foundation"]);
    expect(waves[1]!.map((s) => s.id).sort()).toEqual(["feature-a", "feature-b"]);
    expect(waves[2]!.map((s) => s.id)).toEqual(["integration"]);
  });

  /* ── Ordering within waves ───────────────────────────────────────── */

  it("sorts stories within a wave by order field", () => {
    const stories: Story[] = [
      { id: "c", order: 3 },
      { id: "a", order: 1 },
      { id: "b", order: 2 },
    ];

    const waves = computeDependencyWaves(stories);

    expect(waves[0]!.map((s) => s.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by id when order fields are equal", () => {
    const stories: Story[] = [
      { id: "zebra", order: 1 },
      { id: "alpha", order: 1 },
    ];

    const waves = computeDependencyWaves(stories);

    expect(waves[0]!.map((s) => s.id)).toEqual(["alpha", "zebra"]);
  });

  it("sorts by id when no order field is present", () => {
    const stories: Story[] = [
      { id: "z" },
      { id: "a" },
      { id: "m" },
    ];

    const waves = computeDependencyWaves(stories);

    expect(waves[0]!.map((s) => s.id)).toEqual(["a", "m", "z"]);
  });

  /* ── Error cases ─────────────────────────────────────────────────── */

  it("throws when a dependency references a nonexistent story", () => {
    const stories: Story[] = [
      { id: "a", dependsOn: ["nonexistent"] },
    ];

    expect(() => computeDependencyWaves(stories)).toThrow(
      /does not exist/,
    );
  });

  it("throws when dependency graph contains a cycle", () => {
    const stories: Story[] = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];

    expect(() => computeDependencyWaves(stories)).toThrow(
      /cycle detected/i,
    );
  });

  it("throws on three-node cycle", () => {
    const stories: Story[] = [
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];

    expect(() => computeDependencyWaves(stories)).toThrow(/cycle detected/i);
  });

  /* ── maxPerWave option ───────────────────────────────────────────── */

  it("splits large waves into sub-waves when maxPerWave is set", () => {
    const stories: Story[] = [
      { id: "a" },
      { id: "b" },
      { id: "c" },
      { id: "d" },
      { id: "e" },
    ];

    const waves = computeDependencyWaves(stories, { maxPerWave: 2 });

    // 5 stories with maxPerWave=2 → 3 sub-waves (2+2+1)
    expect(waves).toHaveLength(3);
    expect(waves[0]!).toHaveLength(2);
    expect(waves[1]!).toHaveLength(2);
    expect(waves[2]!).toHaveLength(1);
  });

  it("does not split waves when maxPerWave >= wave size", () => {
    const stories: Story[] = [
      { id: "a" },
      { id: "b" },
    ];

    const waves = computeDependencyWaves(stories, { maxPerWave: 10 });

    expect(waves).toHaveLength(1);
    expect(waves[0]!).toHaveLength(2);
  });

  it("throws when maxPerWave is not a positive integer", () => {
    expect(() => computeDependencyWaves([], { maxPerWave: 0 })).toThrow(
      /positive integer/,
    );
    expect(() => computeDependencyWaves([], { maxPerWave: -1 })).toThrow(
      /positive integer/,
    );
    expect(() => computeDependencyWaves([], { maxPerWave: 1.5 })).toThrow(
      /positive integer/,
    );
  });

  /* ── Complex dependency graphs ───────────────────────────────────── */

  it("handles diamond dependency pattern", () => {
    //    A
    //   / \
    //  B   C
    //   \ /
    //    D
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

  it("handles wide parallel graph (many independent roots)", () => {
    const stories: Story[] = Array.from({ length: 10 }, (_, i) => ({
      id: `story-${i}`,
    }));

    const waves = computeDependencyWaves(stories);

    expect(waves).toHaveLength(1);
    expect(waves[0]!).toHaveLength(10);
  });

  it("handles deep sequential chain", () => {
    const stories: Story[] = Array.from({ length: 5 }, (_, i) => ({
      id: `step-${i}`,
      ...(i > 0 ? { dependsOn: [`step-${i - 1}`] } : {}),
    }));

    const waves = computeDependencyWaves(stories);

    expect(waves).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(waves[i]!).toHaveLength(1);
      expect(waves[i]![0]!.id).toBe(`step-${i}`);
    }
  });
});
