import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  parseReviewPipeline,
  loadReviewPipeline,
} from "../src/review-pipeline-parser.js";

// ---------------------------------------------------------------------------
// Inline YAML fixtures
// ---------------------------------------------------------------------------

/** Minimal single-phase template (mirrors code-review.yaml structure). */
const CODE_REVIEW_YAML = `
id: code-review
name: Code Review
description: Single-phase review template.
author: chorus
agreementThreshold: 0.66
onThresholdMet: ask
maxRounds: 3
yoloDefault: false
estimatedBaselineTokens: 700
ship:
  enabled: true
  branchPattern: "chorus/{chatId}"
  titleTemplate: "chorus: code-review via #{chatId}"
phases:
  - id: review
    kind: review
    title: Code Review
    doer:
      lineage: anthropic
      models:
        - claude-opus-4-7
    reviewer:
      require: 2
      crossLineage: true
      candidates:
        - lineage: openai
          models:
            - gpt-5.5
        - lineage: google
          models:
            - gemini-3.1-pro-preview
    inputs:
      include: []
      exclude: []
    iterate:
      maxRounds: 2
      onDisagreement: continue
`.trim();

/** Two-phase template where the second phase explicitly includes the first via inputs.include. */
const ARCHITECT_REVIEW_YAML = `
id: architect-review
name: Architecture Review
description: Two-phase decision workflow.
author: chorus
agreementThreshold: 0.5
onThresholdMet: ask
maxRounds: 3
yoloDefault: false
estimatedBaselineTokens: 900
phases:
  - id: plan
    kind: plan
    title: Architecture Proposal
    doer:
      lineage: anthropic
      models:
        - claude-opus-4-7
    reviewer:
      require: 0
      crossLineage: false
      candidates: []
    inputs:
      include: []
      exclude: []
    iterate:
      maxRounds: 1
      onDisagreement: continue

  - id: design-review
    kind: review
    title: Design Critique
    doer:
      lineage: any
      models: []
    reviewer:
      require: 3
      crossLineage: true
      candidates:
        - lineage: anthropic
        - lineage: openai
        - lineage: google
    inputs:
      include:
        - plan
      exclude: []
    iterate:
      maxRounds: 2
      onDisagreement: continue
`.trim();

/** Three-phase sequential template (no inputs.include on any phase). */
const SEQUENTIAL_YAML = `
id: sequential-pipeline
name: Sequential Pipeline
phases:
  - id: phase-a
    kind: plan
    doer:
      lineage: anthropic
    iterate:
      maxRounds: 1
      onDisagreement: continue
  - id: phase-b
    kind: review
    doer:
      lineage: openai
    reviewer:
      require: 1
      candidates:
        - lineage: google
    iterate:
      maxRounds: 1
      onDisagreement: continue
  - id: phase-c
    kind: review_only
    reviewer:
      require: 1
      candidates:
        - lineage: anthropic
    iterate:
      maxRounds: 1
      onDisagreement: continue
`.trim();

// ---------------------------------------------------------------------------
// Single-phase parsing (code-review)
// ---------------------------------------------------------------------------

describe("parseReviewPipeline — single-phase (code-review)", () => {
  it("returns ok: true for valid YAML", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    expect(result.ok).toBe(true);
  });

  it("sets pipeline.id from YAML", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.id).toBe("code-review");
  });

  it("derives entry from the first phase id", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.entry).toEqual(["review"]);
  });

  it("preserves top-level fields", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    const { pipeline } = result;
    expect(pipeline.agreementThreshold).toBe(0.66);
    expect(pipeline.onThresholdMet).toBe("ask");
    expect(pipeline.maxRounds).toBe(3);
    expect(pipeline.yoloDefault).toBe(false);
    expect(pipeline.estimatedBaselineTokens).toBe(700);
    expect(pipeline.author).toBe("chorus");
  });

  it("preserves ship config", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.ship?.enabled).toBe(true);
    expect(result.pipeline.ship?.branchPattern).toBe("chorus/{chatId}");
  });

  it("produces one phase of kind 'review'", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.phases).toHaveLength(1);
    const phase = result.pipeline.phases[0];
    expect(phase).toMatchObject({ id: "review", kind: "review" });
  });

  it("generates no edges for a single-phase pipeline", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    // No edges needed for a single phase
    expect(result.pipeline.edges ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// inputs.include → explicit edges (architect-review)
// ---------------------------------------------------------------------------

describe("parseReviewPipeline — inputs.include generates edges", () => {
  it("returns ok: true for architect-review", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    expect(result.ok).toBe(true);
  });

  it("derives entry as ['plan']", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.entry).toEqual(["plan"]);
  });

  it("generates exactly one edge from 'plan' to 'design-review'", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    const { edges } = result.pipeline;
    expect(edges).toHaveLength(1);
    expect(edges![0]).toMatchObject({
      from: { node: "plan" },
      to: { node: "design-review" },
    });
  });

  it("phases array has two entries with correct kinds", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.phases[0]).toMatchObject({ id: "plan", kind: "plan" });
    expect(result.pipeline.phases[1]).toMatchObject({ id: "design-review", kind: "review" });
  });
});

// ---------------------------------------------------------------------------
// Sequential auto-wiring (no inputs.include)
// ---------------------------------------------------------------------------

describe("parseReviewPipeline — sequential auto-wiring", () => {
  it("returns ok: true", () => {
    const result = parseReviewPipeline(SEQUENTIAL_YAML);
    expect(result.ok).toBe(true);
  });

  it("auto-wires three phases into two sequential edges", () => {
    const result = parseReviewPipeline(SEQUENTIAL_YAML);
    if (!result.ok) throw new Error(result.error);
    const { edges } = result.pipeline;
    expect(edges).toHaveLength(2);
    expect(edges![0]).toMatchObject({ from: { node: "phase-a" }, to: { node: "phase-b" } });
    expect(edges![1]).toMatchObject({ from: { node: "phase-b" }, to: { node: "phase-c" } });
  });

  it("derives entry as ['phase-a']", () => {
    const result = parseReviewPipeline(SEQUENTIAL_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.entry).toEqual(["phase-a"]);
  });

  it("handles review_only phase kind", () => {
    const result = parseReviewPipeline(SEQUENTIAL_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.phases[2]).toMatchObject({ id: "phase-c", kind: "review_only" });
  });
});

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe("parseReviewPipeline — invalid input", () => {
  it("returns ok: false for completely invalid YAML syntax", () => {
    const result = parseReviewPipeline(": : : :");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toMatch(/YAML parse error|Validation error/i);
  });

  it("returns ok: false when YAML root is a scalar", () => {
    const result = parseReviewPipeline("just a string");
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when phases is missing", () => {
    const result = parseReviewPipeline("id: no-phases\nentry: [x]");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("Validation error");
  });

  it("returns ok: false when phases is empty", () => {
    const result = parseReviewPipeline("id: empty-phases\nphases: []\nentry: [x]");
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when a required phase field is missing (no id)", () => {
    const yaml = `
id: bad-phase
phases:
  - kind: plan
    doer:
      lineage: anthropic
    iterate:
      maxRounds: 1
      onDisagreement: continue
`.trim();
    const result = parseReviewPipeline(yaml);
    expect(result.ok).toBe(false);
  });

  it("returns ok: false when id field is missing from pipeline", () => {
    const yaml = `
phases:
  - id: p1
    kind: plan
    doer:
      lineage: anthropic
    iterate:
      maxRounds: 1
      onDisagreement: continue
`.trim();
    const result = parseReviewPipeline(yaml);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toContain("Validation error");
  });

  it("error message is a non-empty string on failure", () => {
    const result = parseReviewPipeline("null");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// loadReviewPipeline (file I/O)
// ---------------------------------------------------------------------------

describe("loadReviewPipeline", () => {
  it("loads and parses a valid YAML file from disk", async () => {
    const dir = path.join(os.tmpdir(), `ripline-review-pipeline-parser-test-${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, "test-template.yaml");
    try {
      fs.writeFileSync(filePath, CODE_REVIEW_YAML, "utf8");
      const result = await loadReviewPipeline(filePath);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.pipeline.id).toBe("code-review");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns ok: false when file does not exist", async () => {
    const result = await loadReviewPipeline("/tmp/does-not-exist-ripline-review-pipeline.yaml");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected failure");
    expect(result.error).toMatch(/File read error/i);
  });
});
