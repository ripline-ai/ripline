/**
 * Schema validation tests for the parallel loop node extensions (Story 2).
 *
 * Verifies that the Zod schema accepts new fields (mode, maxConcurrency,
 * dependsOnField) and rejects invalid values.
 */
import { describe, expect, it } from "vitest";
import { pipelineDefinitionSchema } from "../../src/schema.js";

/** Minimal valid pipeline wrapping a single loop node. */
function makePipeline(loopNodeOverrides: Record<string, unknown> = {}) {
  return {
    id: "test-pipeline",
    entry: ["loop1"],
    nodes: [
      {
        id: "loop1",
        type: "loop",
        collection: "artifacts.stories",
        body: { pipelineId: "child_pipeline" },
        ...loopNodeOverrides,
      },
    ],
    edges: [{ from: "loop1", to: "loop1" }],
  };
}

describe("Schema – loop node parallel extensions", () => {
  it("accepts mode: 'parallel'", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ mode: "parallel" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts mode: 'sequential'", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ mode: "sequential" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts loop node without mode (defaults to sequential)", () => {
    const result = pipelineDefinitionSchema.safeParse(makePipeline());
    expect(result.success).toBe(true);
  });

  it("rejects invalid mode value", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ mode: "invalid" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts maxConcurrency as positive integer", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ mode: "parallel", maxConcurrency: 3 }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects maxConcurrency as 0", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ maxConcurrency: 0 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects maxConcurrency as negative", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ maxConcurrency: -1 }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects non-integer maxConcurrency", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ maxConcurrency: 2.5 }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts dependsOnField as a string", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({ mode: "parallel", dependsOnField: "blockedBy" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts all three new fields together", () => {
    const result = pipelineDefinitionSchema.safeParse(
      makePipeline({
        mode: "parallel",
        maxConcurrency: 5,
        dependsOnField: "requires",
      }),
    );
    expect(result.success).toBe(true);
  });
});
