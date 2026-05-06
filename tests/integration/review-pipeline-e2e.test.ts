/**
 * review-pipeline-e2e.test.ts
 *
 * Integration tests that prove Ripline can execute review pipeline YAMLs
 * end-to-end without hitting real AI backends.
 *
 * What is covered:
 *   1. Parse the real code-review.yaml template and verify structure.
 *   2. Parse the real architect-review.yaml template and verify the plan→design-review edge.
 *   3. Execute executeReviewPhase directly with stub runners:
 *      a. Unanimous approval → verdict 'approved'
 *      b. Mixed (1 approve, 1 reject, require: 2) → verdict 'request_changes'
 *      c. Quorum met on round 2 after feedback → verdict 'approved', roundsUsed === 2
 *   4. Wire a full VoiceRegistry with stubs for anthropic/openai/google lineages
 *      and execute the code-review phase via the registry.
 */

import { describe, it, expect, vi } from "vitest";
import { parseReviewPipeline } from "../../src/review-pipeline-parser.js";
import {
  executeReviewPhase,
  type ReviewPhaseEvent,
  type ReviewPhaseResult,
  type VoiceRegistryLike,
} from "../../src/pipeline/executors/review-phase.js";
import { createVoiceRegistry } from "../../src/voice-registry.js";
import type { AgentRunner, AgentEvent } from "../../src/pipeline/executors/agent.js";
import type { ReviewPhase, PlanPhase } from "../../src/review-phase-types.js";

// ---------------------------------------------------------------------------
// Helper: consume the AsyncGenerator and return the ReviewPhaseResult
// ---------------------------------------------------------------------------

async function runPhase(
  gen: AsyncGenerator<ReviewPhaseEvent>
): Promise<ReviewPhaseResult> {
  let result: ReviewPhaseResult | undefined;
  for await (const event of gen) {
    if (event.type === "phase_done") {
      result = event.result;
    }
  }
  if (!result) {
    throw new Error("phase_done event was never emitted");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Real review pipeline YAML strings
// ---------------------------------------------------------------------------

/**
 * Verbatim content of:
 *   templates/code-review.yaml
 */
const CODE_REVIEW_YAML = `\
id: code-review
name: Code Review
description: Single-phase review template. Claude Opus 4.7 produces; Codex (gpt-5.5) and Gemini 3.1 Pro Preview review independently. Both reviewers must agree.
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
    description: Claude Opus 4.7 produces the implementation; Codex (gpt-5.5) and Gemini 3.1 Pro Preview critique it independently. Quorum is 2 of 2.
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
`;

/**
 * Verbatim content of:
 *   templates/architect-review.yaml
 */
const ARCHITECT_REVIEW_YAML = `\
id: architect-review
name: Architecture Review
description: Two-phase decision workflow. Anthropic drafts a design; 3 cross-lineage reviewers critique it before any coding starts.
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
    description: Anthropic (Opus) drafts an architecture proposal or design decision.
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
    description: Three reviewers from different lineages critique the proposal. Lower threshold (50%) encourages surfacing disagreement.
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
`;

// ---------------------------------------------------------------------------
// Stub builder helpers
// ---------------------------------------------------------------------------

function makeDoerRunner(text = "Here is my implementation"): AgentRunner {
  return {
    async *run() {
      yield { type: "message_done" as const, text };
    },
  };
}

function makeApprovingReviewer(): AgentRunner {
  return {
    async *run() {
      yield { type: "message_done" as const, text: "LGTM, looks good, approved" };
    },
  };
}

function makeRejectingReviewer(): AgentRunner {
  return {
    async *run() {
      yield { type: "message_done" as const, text: "I have concerns, request_changes" };
    },
  };
}

/**
 * Build a VoiceRegistryLike from a simple lineage → AgentRunner map.
 * Missing lineages resolve to null.
 */
function makeRegistry(map: Record<string, AgentRunner>): VoiceRegistryLike {
  return {
    resolve(lineage) {
      return map[lineage] ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// 1. Parse code-review.yaml — structure validation
// ---------------------------------------------------------------------------

describe("review-pipeline-e2e: parse code-review.yaml", () => {
  it("parses successfully (ok: true)", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    expect(result.ok).toBe(true);
  });

  it("has correct top-level metadata", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    expect(result.pipeline.id).toBe("code-review");
    expect(result.pipeline.name).toBe("Code Review");
    expect(result.pipeline.author).toBe("chorus");
    expect(result.pipeline.agreementThreshold).toBe(0.66);
    expect(result.pipeline.maxRounds).toBe(3);
    expect(result.pipeline.ship?.enabled).toBe(true);
  });

  it("has exactly one phase with kind 'review'", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    expect(result.pipeline.phases).toHaveLength(1);
    const phase = result.pipeline.phases[0];
    expect(phase).toBeDefined();
    expect("kind" in phase! && phase.kind).toBe("review");
  });

  it("review phase has correct doer and reviewer config", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    const phase = result.pipeline.phases[0] as ReviewPhase;
    expect(phase.doer.lineage).toBe("anthropic");
    expect(phase.reviewer.require).toBe(2);
    expect(phase.reviewer.crossLineage).toBe(true);
    expect(phase.reviewer.candidates).toHaveLength(2);
    expect(phase.reviewer.candidates[0]?.lineage).toBe("openai");
    expect(phase.reviewer.candidates[1]?.lineage).toBe("google");
  });

  it("derives entry from first phase id", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.entry).toEqual(["review"]);
  });

  it("has no auto-derived edges (single phase)", () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    // Single phase → no edges generated
    expect(result.pipeline.edges ?? []).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Parse architect-review.yaml — two-phase structure + edge derivation
// ---------------------------------------------------------------------------

describe("review-pipeline-e2e: parse architect-review.yaml", () => {
  it("parses successfully (ok: true)", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    expect(result.ok).toBe(true);
  });

  it("has two phases: plan and design-review", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    expect(result.pipeline.phases).toHaveLength(2);
    const [planPhase, reviewPhase] = result.pipeline.phases;
    expect("kind" in planPhase! && planPhase.kind).toBe("plan");
    expect("id" in planPhase! && planPhase.id).toBe("plan");
    expect("kind" in reviewPhase! && reviewPhase.kind).toBe("review");
    expect("id" in reviewPhase! && reviewPhase.id).toBe("design-review");
  });

  it("derives entry from first phase (plan)", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);
    expect(result.pipeline.entry).toEqual(["plan"]);
  });

  it("generates edge from plan → design-review via inputs.include", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    // design-review has inputs.include: [plan] → explicit edge from plan → design-review
    const edges = result.pipeline.edges ?? [];
    expect(edges).toHaveLength(1);
    expect(edges[0]?.from.node).toBe("plan");
    expect(edges[0]?.to.node).toBe("design-review");
  });

  it("plan phase has require: 0 (doer-only, no review gate)", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    const planPhase = result.pipeline.phases[0] as PlanPhase;
    expect(planPhase.reviewer?.require ?? 0).toBe(0);
    expect(planPhase.reviewer?.candidates ?? []).toHaveLength(0);
  });

  it("design-review phase requires 3 cross-lineage approvals", () => {
    const result = parseReviewPipeline(ARCHITECT_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    const reviewPhase = result.pipeline.phases[1] as ReviewPhase;
    expect(reviewPhase.reviewer.require).toBe(3);
    expect(reviewPhase.reviewer.crossLineage).toBe(true);
    expect(reviewPhase.reviewer.candidates).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 3a. executeReviewPhase — unanimous approval
// ---------------------------------------------------------------------------

describe("review-pipeline-e2e: unanimous approval", () => {
  it("returns verdict 'approved' when all reviewers approve", async () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    const reviewPhase = result.pipeline.phases[0] as ReviewPhase;

    const doer = makeDoerRunner();
    const approver = makeApprovingReviewer();

    const registry = makeRegistry({
      anthropic: doer,
      openai: approver,
      google: approver,
    });

    const phaseResult = await runPhase(
      executeReviewPhase(
        reviewPhase,
        { task: "Implement a login endpoint" },
        { voiceRegistry: registry }
      )
    );

    expect(phaseResult.verdict).toBe("approved");
    expect(phaseResult.doerOutput).toBe("Here is my implementation");
    expect(phaseResult.reviewerFeedback).toHaveLength(2);
    expect(phaseResult.reviewerFeedback.every((fb) => fb.verdict === "approved")).toBe(true);
    expect(phaseResult.roundsUsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3b. executeReviewPhase — mixed result (1 approve, 1 reject, require: 2)
// ---------------------------------------------------------------------------

describe("review-pipeline-e2e: mixed review result", () => {
  it("returns verdict 'request_changes' when quorum is not met", async () => {
    // Build a phase with require: 2 but onDisagreement: stop so it doesn't retry
    const phase: ReviewPhase = {
      id: "review",
      kind: "review",
      title: "Code Review",
      doer: { lineage: "anthropic" },
      reviewer: {
        require: 2,
        crossLineage: false,
        candidates: [
          { lineage: "openai" },
          { lineage: "google" },
        ],
      },
      iterate: {
        maxRounds: 1,
        onDisagreement: "stop",
      },
    };

    const doer = makeDoerRunner();
    const approver = makeApprovingReviewer();
    const rejecter = makeRejectingReviewer();

    const registry = makeRegistry({
      anthropic: doer,
      openai: approver,   // 1 approve
      google: rejecter,   // 1 reject → quorum of 2 not met
    });

    const phaseResult = await runPhase(
      executeReviewPhase(phase, {}, { voiceRegistry: registry })
    );

    expect(phaseResult.verdict).toBe("request_changes");
    expect(phaseResult.roundsUsed).toBe(1);

    const approvals = phaseResult.reviewerFeedback.filter((fb) => fb.verdict === "approved");
    const rejections = phaseResult.reviewerFeedback.filter((fb) => fb.verdict === "request_changes");
    expect(approvals).toHaveLength(1);
    expect(rejections).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 3c. executeReviewPhase — quorum met on round 2 after feedback
// ---------------------------------------------------------------------------

describe("review-pipeline-e2e: quorum met on round 2", () => {
  it("returns verdict 'approved' and roundsUsed === 2", async () => {
    const phase: ReviewPhase = {
      id: "review",
      kind: "review",
      title: "Code Review",
      doer: { lineage: "anthropic" },
      reviewer: {
        require: 2,
        crossLineage: false,
        candidates: [
          { lineage: "openai" },
          { lineage: "google" },
        ],
      },
      iterate: {
        maxRounds: 3,
        onDisagreement: "continue",
      },
    };

    const doer = makeDoerRunner();

    // Round 1: both reject; Round 2: both approve
    let reviewerCallCount = 0;
    const conditionalReviewer: AgentRunner = {
      async *run() {
        reviewerCallCount++;
        // First two calls are round 1 (2 reviewers × 1 round), next two are round 2
        const text = reviewerCallCount <= 2
          ? "I have concerns, request_changes"
          : "LGTM, looks good, approved";
        yield { type: "message_done" as const, text };
      },
    };

    const registry = makeRegistry({
      anthropic: doer,
      openai: conditionalReviewer,
      google: conditionalReviewer,
    });

    const phaseResult = await runPhase(
      executeReviewPhase(phase, {}, { voiceRegistry: registry })
    );

    expect(phaseResult.verdict).toBe("approved");
    expect(phaseResult.roundsUsed).toBe(2);
    expect(phaseResult.reviewerFeedback.every((fb) => fb.verdict === "approved")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Full VoiceRegistry integration with code-review phase
// ---------------------------------------------------------------------------

describe("review-pipeline-e2e: VoiceRegistry integration", () => {
  it("wires stub runners through createVoiceRegistry and executes the review phase", async () => {
    const result = parseReviewPipeline(CODE_REVIEW_YAML);
    if (!result.ok) throw new Error(result.error);

    const reviewPhase = result.pipeline.phases[0] as ReviewPhase;

    const doer = makeDoerRunner("Implementation complete");
    const openaiReviewer = makeApprovingReviewer();
    const googleReviewer = makeApprovingReviewer();

    // Use the real createVoiceRegistry, injecting stub runners
    const registry = createVoiceRegistry({
      claudeCodeRunner: doer,
      codexRunner: openaiReviewer,
      geminiRunner: googleReviewer,
    });

    // Confirm lineage resolution works
    expect(registry.resolve("anthropic")).toBe(doer);
    expect(registry.resolve("openai")).toBe(openaiReviewer);
    expect(registry.resolve("google")).toBe(googleReviewer);

    const phaseResult = await runPhase(
      executeReviewPhase(
        reviewPhase,
        { task: "Implement a search endpoint" },
        { voiceRegistry: registry }
      )
    );

    expect(phaseResult.verdict).toBe("approved");
    expect(phaseResult.doerOutput).toBe("Implementation complete");
    expect(phaseResult.reviewerFeedback).toHaveLength(2);
    expect(phaseResult.roundsUsed).toBe(1);
  });

  it("resolve('any') returns the anthropic runner when available", () => {
    const doer = makeDoerRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: doer });
    expect(registry.resolve("any")).toBe(doer);
  });
});
