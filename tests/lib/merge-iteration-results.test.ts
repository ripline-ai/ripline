/**
 * Acceptance tests for merge-iteration-results utilities (Story 4).
 *
 * Covers: extractIterationResult, deriveResultKey, safeLargeArtifact,
 * mergeWaveResults, and buildPriorResultsContext.
 */
import { describe, expect, it } from "vitest";
import {
  extractIterationResult,
  deriveResultKey,
  safeLargeArtifact,
  mergeWaveResults,
  buildPriorResultsContext,
} from "../../src/lib/merge-iteration-results.js";

// ---------------------------------------------------------------------------
// extractIterationResult
// ---------------------------------------------------------------------------

describe("extractIterationResult", () => {
  it("returns value at resultKey when provided and present", () => {
    const outputs = { result: { text: "hello" }, other: 42 };
    expect(extractIterationResult(outputs, "result")).toEqual({ text: "hello" });
  });

  it("unwraps single-key outputs when no resultKey provided", () => {
    const outputs = { delegation: { text: "done" } };
    expect(extractIterationResult(outputs)).toEqual({ text: "done" });
  });

  it("returns full outputs when multiple keys and no resultKey", () => {
    const outputs = { a: 1, b: 2, c: 3 };
    expect(extractIterationResult(outputs)).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("falls through to single-key unwrap when resultKey is missing from outputs", () => {
    const outputs = { actual: "value" };
    expect(extractIterationResult(outputs, "nonexistent")).toEqual("value");
  });

  it("returns full outputs when resultKey missing and multiple keys exist", () => {
    const outputs = { a: 1, b: 2 };
    expect(extractIterationResult(outputs, "missing")).toEqual({ a: 1, b: 2 });
  });
});

// ---------------------------------------------------------------------------
// deriveResultKey
// ---------------------------------------------------------------------------

describe("deriveResultKey", () => {
  it("returns last body node id", () => {
    const nodes = [{ id: "first" }, { id: "second" }, { id: "last" }];
    expect(deriveResultKey(nodes)).toBe("last");
  });

  it("returns single body node id", () => {
    expect(deriveResultKey([{ id: "only" }])).toBe("only");
  });

  it("returns undefined for empty array", () => {
    expect(deriveResultKey([])).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(deriveResultKey(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// safeLargeArtifact
// ---------------------------------------------------------------------------

describe("safeLargeArtifact", () => {
  it("returns small values unchanged", () => {
    const value = { text: "hello world" };
    expect(safeLargeArtifact(value)).toEqual(value);
  });

  it("returns primitives unchanged", () => {
    expect(safeLargeArtifact(42)).toBe(42);
    expect(safeLargeArtifact("short")).toBe("short");
    expect(safeLargeArtifact(null)).toBeNull();
  });

  it("truncates large string values", () => {
    const bigString = "x".repeat(600 * 1024);
    const result = safeLargeArtifact(bigString);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBeLessThan(bigString.length);
    expect((result as string)).toContain("truncated");
  });

  it("truncates large .text field in objects", () => {
    const bigText = "y".repeat(600 * 1024);
    const value = { text: bigText, meta: "keep" };
    const result = safeLargeArtifact(value) as Record<string, unknown>;
    expect(typeof result.text).toBe("string");
    expect((result.text as string).length).toBeLessThan(bigText.length);
    expect((result.text as string)).toContain("truncated");
  });

  it("handles circular references gracefully", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    const result = safeLargeArtifact(obj) as Record<string, unknown>;
    expect(result.__error).toBe(true);
    expect(result.message).toContain("not serializable");
  });
});

// ---------------------------------------------------------------------------
// mergeWaveResults
// ---------------------------------------------------------------------------

describe("mergeWaveResults", () => {
  it("places results at correct indices in iteration results array", () => {
    const iterationResults = [null, null, null, null];
    const waveResults = [
      { index: 0, result: { result: { text: "A-done" } } },
      { index: 2, result: { result: { text: "C-done" } } },
    ];
    mergeWaveResults(iterationResults, waveResults, "result");
    expect(iterationResults[0]).toEqual({ text: "A-done" });
    expect(iterationResults[1]).toBeNull(); // untouched
    expect(iterationResults[2]).toEqual({ text: "C-done" });
    expect(iterationResults[3]).toBeNull(); // untouched
  });

  it("passes error markers through as-is", () => {
    const iterationResults = [null, null];
    const errorResult = { __error: true, status: "errored", error: "boom" };
    mergeWaveResults(iterationResults, [{ index: 1, result: errorResult }]);
    expect(iterationResults[1]).toEqual(errorResult);
  });

  it("normalizes single-key outputs to match sequential shape", () => {
    const iterationResults = [null];
    mergeWaveResults(iterationResults, [
      { index: 0, result: { delegation: { text: "done" } } },
    ]);
    // Single key → unwrapped
    expect(iterationResults[0]).toEqual({ text: "done" });
  });

  it("uses resultKey when provided for extraction", () => {
    const iterationResults = [null];
    mergeWaveResults(
      iterationResults,
      [{ index: 0, result: { result: "val", other: "ignored" } }],
      "result",
    );
    expect(iterationResults[0]).toBe("val");
  });

  it("handles non-object results (arrays, primitives) as-is", () => {
    const iterationResults = [null, null];
    mergeWaveResults(iterationResults, [
      { index: 0, result: [1, 2, 3] },
      { index: 1, result: "plain" },
    ]);
    expect(iterationResults[0]).toEqual([1, 2, 3]);
    expect(iterationResults[1]).toBe("plain");
  });
});

// ---------------------------------------------------------------------------
// buildPriorResultsContext
// ---------------------------------------------------------------------------

describe("buildPriorResultsContext", () => {
  it("returns completed results with index and id", () => {
    const iterationResults = [{ text: "A-done" }, null, { text: "C-done" }];
    const collection = [
      { id: "A", title: "Story A" },
      { id: "B", title: "Story B" },
      { id: "C", title: "Story C" },
    ];
    const prior = buildPriorResultsContext(iterationResults, collection);
    expect(prior).toHaveLength(2);
    expect(prior[0]).toEqual({ index: 0, id: "A", result: { text: "A-done" } });
    expect(prior[1]).toEqual({ index: 2, id: "C", result: { text: "C-done" } });
  });

  it("filters out null slots", () => {
    const iterationResults = [null, null, "done"];
    const collection = [{}, {}, { id: "Z" }];
    const prior = buildPriorResultsContext(iterationResults, collection);
    expect(prior).toHaveLength(1);
    expect(prior[0]!.index).toBe(2);
  });

  it("filters out error markers", () => {
    const iterationResults = [
      { __error: true, status: "errored", error: "fail" },
      { text: "ok" },
    ];
    const collection = [{ id: "A" }, { id: "B" }];
    const prior = buildPriorResultsContext(iterationResults, collection);
    expect(prior).toHaveLength(1);
    expect(prior[0]!.id).toBe("B");
  });

  it("omits id property when collection item has no id field", () => {
    const iterationResults = ["result"];
    const collection = [{ title: "No ID" }];
    const prior = buildPriorResultsContext(iterationResults, collection);
    expect(prior).toHaveLength(1);
    expect(prior[0]).toEqual({ index: 0, result: "result" });
    expect("id" in prior[0]!).toBe(false);
  });

  it("returns empty array when no results yet", () => {
    const iterationResults = [null, null];
    const collection = [{ id: "A" }, { id: "B" }];
    expect(buildPriorResultsContext(iterationResults, collection)).toEqual([]);
  });
});
