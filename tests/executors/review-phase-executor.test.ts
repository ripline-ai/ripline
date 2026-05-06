/**
 * Tests for executeReviewPhase — the review/plan phase executor.
 *
 * All external calls (doer + reviewer agents) are stubbed via mock AgentRunner
 * objects so tests run without any real AI backend.
 *
 * The executor is now an AsyncGenerator<ReviewPhaseEvent>. Tests collect all
 * events into an array and verify both the event sequence and the final
 * ReviewPhaseResult delivered in the phase_done payload.
 */

import { describe, it, expect, vi } from "vitest";
import type { ReviewPhase, PlanPhase } from "../../src/review-phase-types.js";
import type { AgentRunner, AgentRunParams, AgentEvent } from "../../src/pipeline/executors/agent.js";
import {
  executeReviewPhase,
  type ReviewPhaseExecutorOptions,
  type ReviewPhaseEvent,
  type VoiceRegistryLike,
} from "../../src/pipeline/executors/review-phase.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect all events from the generator into an array.
 * If the generator throws, the error is caught and the already-collected
 * events (including any phase_failed) are returned along with the error.
 */
async function collectEvents(
  gen: AsyncGenerator<ReviewPhaseEvent>
): Promise<{ events: ReviewPhaseEvent[]; error?: Error }> {
  const events: ReviewPhaseEvent[] = [];
  try {
    for await (const event of gen) {
      events.push(event);
    }
  } catch (err) {
    return { events, error: err instanceof Error ? err : new Error(String(err)) };
  }
  return { events };
}

/**
 * Extract the ReviewPhaseResult from the phase_done event in the collected
 * events array. Throws if no phase_done event is found.
 */
function getResult(events: ReviewPhaseEvent[]) {
  const done = events.find((e) => e.type === "phase_done");
  if (!done || done.type !== "phase_done") {
    throw new Error("No phase_done event found in collected events");
  }
  return done.result;
}

/**
 * Create a mock AgentRunner that always yields a message_done with the given
 * text. The returned object also exposes a `mock` vi.fn() that is called on
 * each invocation so tests can assert call counts and captured params.
 */
function makeRunner(text: string): AgentRunner & { mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(async (_params: AgentRunParams) => text);
  const runner: AgentRunner & { mock: ReturnType<typeof vi.fn> } = {
    mock,
    async *run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
      const result = await mock(params);
      yield { type: "message_done" as const, text: result as string };
    },
  };
  return runner;
}

/**
 * Create a mock AgentRunner that yields text_delta events followed by
 * message_done, so text_delta forwarding can be verified.
 */
function makeStreamingRunner(
  chunks: string[]
): AgentRunner & { mock: ReturnType<typeof vi.fn> } {
  const fullText = chunks.join("");
  const mock = vi.fn(async (_params: AgentRunParams) => chunks);
  const runner: AgentRunner & { mock: ReturnType<typeof vi.fn> } = {
    mock,
    async *run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
      await mock(params);
      for (const chunk of chunks) {
        yield { type: "text_delta" as const, text: chunk };
      }
      yield { type: "message_done" as const, text: fullText };
    },
  };
  return runner;
}

/**
 * Build a simple VoiceRegistryLike that maps each lineage to the supplied
 * runner map. Missing lineages resolve to null.
 */
function makeRegistry(
  map: Record<string, AgentRunner>
): VoiceRegistryLike {
  return {
    resolve(lineage) {
      return map[lineage] ?? null;
    },
  };
}

function makeOptions(
  map: Record<string, AgentRunner>
): ReviewPhaseExecutorOptions {
  return { voiceRegistry: makeRegistry(map) };
}

/** A minimal ReviewPhase fixture. */
function reviewPhase(
  overrides: Partial<ReviewPhase> = {}
): ReviewPhase {
  return {
    id: "test-phase",
    kind: "review",
    title: "Test phase",
    description: "Do the thing",
    doer: { lineage: "anthropic" },
    reviewer: {
      require: 1,
      crossLineage: false,
      candidates: [{ lineage: "openai" }],
    },
    iterate: {
      maxRounds: 3,
      onDisagreement: "continue",
    },
    ...overrides,
  };
}

/** A minimal PlanPhase fixture (no reviewer). */
function planPhase(
  overrides: Partial<PlanPhase> = {}
): PlanPhase {
  return {
    id: "plan-phase",
    kind: "plan",
    title: "Plan something",
    doer: { lineage: "anthropic" },
    iterate: {
      maxRounds: 1,
      onDisagreement: "stop",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: PlanPhase (doer-only)
// ---------------------------------------------------------------------------

describe("executeReviewPhase — PlanPhase (no reviewer)", () => {
  it("runs doer only and returns approved immediately", async () => {
    const doer = makeRunner("Here is the plan output.");
    const { events } = await collectEvents(
      executeReviewPhase(planPhase(), {}, makeOptions({ anthropic: doer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
    expect(result.doerOutput).toBe("Here is the plan output.");
    expect(result.reviewerFeedback).toHaveLength(0);
    expect(result.roundsUsed).toBe(1);
    expect(doer.mock).toHaveBeenCalledOnce();
  });

  it("emits phase_start then participant_start(doer) then participant_done(doer) then phase_done", async () => {
    const doer = makeRunner("plan output");
    const { events } = await collectEvents(
      executeReviewPhase(planPhase(), {}, makeOptions({ anthropic: doer }))
    );

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("phase_start");
    expect(types).toContain("participant_start");
    expect(types).toContain("participant_done");
    expect(types[types.length - 1]).toBe("phase_done");

    const phaseStart = events.find((e) => e.type === "phase_start");
    expect(phaseStart).toMatchObject({ type: "phase_start", phaseId: "plan-phase", kind: "plan", round: 1 });
  });

  it("returns approved for PlanPhase with reviewer.require: 0 and no candidates", async () => {
    const phase: PlanPhase = planPhase({
      reviewer: { require: 0, candidates: [] },
    });
    const doer = makeRunner("Output with require 0");

    const { events } = await collectEvents(
      executeReviewPhase(phase, { context: "some input" }, makeOptions({ anthropic: doer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
    expect(result.doerOutput).toBe("Output with require 0");
    expect(result.reviewerFeedback).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: text_delta forwarding
// ---------------------------------------------------------------------------

describe("executeReviewPhase — text_delta forwarding", () => {
  it("forwards doer text_delta events without buffering", async () => {
    const doer = makeStreamingRunner(["Hello", " ", "world"]);
    const { events } = await collectEvents(
      executeReviewPhase(planPhase(), {}, makeOptions({ anthropic: doer }))
    );

    const deltas = events.filter(
      (e): e is Extract<ReviewPhaseEvent, { type: "text_delta" }> =>
        e.type === "text_delta" && e.role === "doer"
    );
    expect(deltas.map((d) => d.text)).toEqual(["Hello", " ", "world"]);
  });

  it("forwards reviewer text_delta events", async () => {
    const doer = makeRunner("doer output");
    const reviewer = makeStreamingRunner(["lgtm", " — ", "approve"]);

    const { events } = await collectEvents(
      executeReviewPhase(
        reviewPhase(),
        {},
        makeOptions({ anthropic: doer, openai: reviewer })
      )
    );

    const reviewerDeltas = events.filter(
      (e): e is Extract<ReviewPhaseEvent, { type: "text_delta" }> =>
        e.type === "text_delta" && e.role === "reviewer"
    );
    expect(reviewerDeltas.map((d) => d.text)).toEqual(["lgtm", " — ", "approve"]);
  });
});

// ---------------------------------------------------------------------------
// Tests: ReviewPhase — unanimous approval
// ---------------------------------------------------------------------------

describe("executeReviewPhase — unanimous approval", () => {
  it("returns approved on first round when all reviewers approve", async () => {
    const doer = makeRunner("The implementation is correct.");
    const reviewer = makeRunner("lgtm — approve");

    const { events } = await collectEvents(
      executeReviewPhase(reviewPhase(), {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
    expect(result.doerOutput).toBe("The implementation is correct.");
    expect(result.reviewerFeedback).toHaveLength(1);
    expect(result.reviewerFeedback[0]?.verdict).toBe("approved");
    expect(result.roundsUsed).toBe(1);
  });

  it("emits participant_done for reviewer with correct verdict", async () => {
    const doer = makeRunner("Good implementation.");
    const reviewer = makeRunner("Approved. No concerns found.");

    const { events } = await collectEvents(
      executeReviewPhase(reviewPhase(), {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const reviewerDone = events.find(
      (e): e is Extract<ReviewPhaseEvent, { type: "participant_done" }> =>
        e.type === "participant_done" && e.role === "reviewer"
    );
    expect(reviewerDone).toBeDefined();
    expect(reviewerDone?.verdict).toBe("approved");
    expect(reviewerDone?.feedback).toContain("Approved");
  });

  it("includes reviewer feedback text in result", async () => {
    const doer = makeRunner("Good implementation.");
    const reviewer = makeRunner("Approved. No concerns found.");

    const { events } = await collectEvents(
      executeReviewPhase(reviewPhase(), {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const result = getResult(events);
    expect(result.reviewerFeedback[0]?.feedback).toContain("Approved");
  });
});

// ---------------------------------------------------------------------------
// Tests: participant_done carries usage
// ---------------------------------------------------------------------------

describe("executeReviewPhase — usage in participant_done", () => {
  it("forwards usage from reviewer message_done to participant_done event", async () => {
    const doer = makeRunner("output");
    const reviewerWithUsage: AgentRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield {
          type: "message_done" as const,
          text: "approve — lgtm",
          usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
        };
      },
    };

    const { events } = await collectEvents(
      executeReviewPhase(
        reviewPhase(),
        {},
        makeOptions({ anthropic: doer, openai: reviewerWithUsage })
      )
    );

    const reviewerDone = events.find(
      (e): e is Extract<ReviewPhaseEvent, { type: "participant_done" }> =>
        e.type === "participant_done" && e.role === "reviewer"
    );
    expect(reviewerDone?.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("forwards usage into ReviewerFeedbackEntry in ReviewPhaseResult", async () => {
    const doer = makeRunner("output");
    const reviewerWithUsage: AgentRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        yield {
          type: "message_done" as const,
          text: "approve — lgtm",
          usage: { inputTokens: 200, outputTokens: 75 },
        };
      },
    };

    const { events } = await collectEvents(
      executeReviewPhase(
        reviewPhase(),
        {},
        makeOptions({ anthropic: doer, openai: reviewerWithUsage })
      )
    );

    const result = getResult(events);
    expect(result.reviewerFeedback[0]?.usage).toMatchObject({ inputTokens: 200, outputTokens: 75 });
  });
});

// ---------------------------------------------------------------------------
// Tests: Quorum logic
// ---------------------------------------------------------------------------

describe("executeReviewPhase — quorum (M of N)", () => {
  it("requires at least M approvals: met when exactly M reviewers approve", async () => {
    // 2 of 3 required; reviewers: approve, approve, disagree
    const phase = reviewPhase({
      reviewer: {
        require: 2,
        crossLineage: false,
        candidates: [
          { lineage: "openai" },
          { lineage: "google" },
          { lineage: "moonshot" },
        ],
      },
    });

    const doer = makeRunner("Done.");
    const approver = makeRunner("approve — looks good");
    const rejecter = makeRunner("request changes — needs work");

    const { events } = await collectEvents(
      executeReviewPhase(
        phase,
        {},
        makeOptions({
          anthropic: doer,
          openai: approver,
          google: approver,
          moonshot: rejecter,
        })
      )
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
    expect(result.roundsUsed).toBe(1);
  });

  it("fails quorum when fewer than M reviewers approve", async () => {
    const phase = reviewPhase({
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
    });

    const doer = makeRunner("output");
    const rejecter = makeRunner("request changes — needs rework");

    const { events } = await collectEvents(
      executeReviewPhase(
        phase,
        {},
        makeOptions({ anthropic: doer, openai: rejecter, google: rejecter })
      )
    );

    const result = getResult(events);
    expect(result.verdict).toBe("request_changes");
    expect(result.roundsUsed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: crossLineage quorum
// ---------------------------------------------------------------------------

describe("executeReviewPhase — crossLineage quorum", () => {
  it("approves when require=2 and approvals come from 2 distinct lineages", async () => {
    const phase = reviewPhase({
      reviewer: {
        require: 2,
        crossLineage: true,
        candidates: [
          { lineage: "openai" },
          { lineage: "google" },
        ],
      },
      iterate: { maxRounds: 1, onDisagreement: "stop" },
    });

    const doer = makeRunner("output");
    const approver = makeRunner("approve — lgtm");

    const { events } = await collectEvents(
      executeReviewPhase(
        phase,
        {},
        makeOptions({ anthropic: doer, openai: approver, google: approver })
      )
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
  });

  it("fails crossLineage quorum when all approvals come from same lineage (same runner)", async () => {
    // Two candidates but both resolve to the same lineage key "openai"
    // Since approvals don't span 2 distinct lineages, quorum fails.
    const phase = reviewPhase({
      reviewer: {
        require: 2,
        crossLineage: true,
        candidates: [
          { lineage: "openai" },
          { lineage: "openai" }, // duplicate lineage
        ],
      },
      iterate: { maxRounds: 1, onDisagreement: "stop" },
    });

    const doer = makeRunner("output");
    const openaiApprover = makeRunner("approve — lgtm");

    const { events } = await collectEvents(
      executeReviewPhase(
        phase,
        {},
        makeOptions({ anthropic: doer, openai: openaiApprover })
      )
    );

    // Both approvals are from "openai" lineage — crossLineage requires >= 2 distinct
    const result = getResult(events);
    expect(result.verdict).toBe("request_changes");
  });

  it("does not require crossLineage when crossLineage is false", async () => {
    const phase = reviewPhase({
      reviewer: {
        require: 2,
        crossLineage: false,
        candidates: [
          { lineage: "openai" },
          { lineage: "openai" },
        ],
      },
      iterate: { maxRounds: 1, onDisagreement: "stop" },
    });

    const doer = makeRunner("output");
    const approver = makeRunner("approve — lgtm");

    const { events } = await collectEvents(
      executeReviewPhase(
        phase,
        {},
        makeOptions({ anthropic: doer, openai: approver })
      )
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
  });
});

// ---------------------------------------------------------------------------
// Tests: retry on disagreement
// ---------------------------------------------------------------------------

describe("executeReviewPhase — retry on disagreement", () => {
  it("retries on disagreement when onDisagreement=continue and rounds remain", async () => {
    const phase = reviewPhase({
      iterate: { maxRounds: 3, onDisagreement: "continue" },
    });

    const doer = makeRunner("Revised output.");

    let reviewerCallCount = 0;
    const reviewer: AgentRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        reviewerCallCount++;
        const text = reviewerCallCount < 3
          ? "request changes — not there yet"
          : "approve — looks good now";
        yield { type: "message_done" as const, text };
      },
    };

    const { events } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("approved");
    expect(result.roundsUsed).toBe(3);
    expect(doer.mock).toHaveBeenCalledTimes(3);
    expect(reviewerCallCount).toBe(3);
  });

  it("emits phase_progress events on disagreement when retrying", async () => {
    const phase = reviewPhase({
      iterate: { maxRounds: 3, onDisagreement: "continue" },
    });

    const doer = makeRunner("output");
    let call = 0;
    const reviewer: AgentRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        call++;
        const text = call < 3
          ? "request changes — not done yet"
          : "approve — looks good";
        yield { type: "message_done" as const, text };
      },
    };

    const { events } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const progressEvents = events.filter((e) => e.type === "phase_progress");
    // 2 rounds of disagreement before approval on round 3
    expect(progressEvents).toHaveLength(2);
    expect(progressEvents[0]).toMatchObject({ type: "phase_progress", phaseId: "test-phase", round: 1 });
    expect(progressEvents[1]).toMatchObject({ type: "phase_progress", phaseId: "test-phase", round: 2 });
  });

  it("passes reviewer feedback to doer on retry rounds", async () => {
    const phase = reviewPhase({
      iterate: { maxRounds: 2, onDisagreement: "continue" },
    });

    const capturedPrompts: string[] = [];
    const doer: AgentRunner = {
      async *run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
        capturedPrompts.push(params.prompt);
        yield { type: "message_done" as const, text: "output" };
      },
    };

    let reviewerCall = 0;
    const reviewer: AgentRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        reviewerCall++;
        const text = reviewerCall === 1
          ? "request changes — missing error handling"
          : "approve — addressed concerns";
        yield { type: "message_done" as const, text };
      },
    };

    await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    // Round 2 doer prompt should include prior feedback block
    expect(capturedPrompts).toHaveLength(2);
    const round2Prompt = capturedPrompts[1] ?? "";
    expect(round2Prompt).toContain("requested changes");
    expect(round2Prompt).toContain("request changes — missing error handling");
  });

  it("stops immediately when onDisagreement=stop even with rounds remaining", async () => {
    const phase = reviewPhase({
      iterate: { maxRounds: 5, onDisagreement: "stop" },
    });

    const doer = makeRunner("output");
    const reviewer = makeRunner("request changes — nack");

    const { events } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("request_changes");
    expect(result.roundsUsed).toBe(1);

    // No phase_progress events — stopped immediately
    const progressEvents = events.filter((e) => e.type === "phase_progress");
    expect(progressEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests: max rounds exceeded
// ---------------------------------------------------------------------------

describe("executeReviewPhase — max rounds exceeded", () => {
  it("returns request_changes when quorum never met after maxRounds", async () => {
    const phase = reviewPhase({
      iterate: { maxRounds: 2, onDisagreement: "continue" },
    });

    const doer = makeRunner("output");
    const reviewer = makeRunner("request changes — still wrong");

    const { events } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("request_changes");
    expect(result.roundsUsed).toBe(2);
  });

  it("returns reviewer feedback from the final round", async () => {
    const phase = reviewPhase({
      iterate: { maxRounds: 2, onDisagreement: "continue" },
    });

    const doer = makeRunner("output");
    let call = 0;
    const reviewer: AgentRunner = {
      async *run(): AsyncGenerator<AgentEvent> {
        call++;
        yield { type: "message_done" as const, text: `request changes — round ${call} feedback` };
      },
    };

    const { events } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const result = getResult(events);
    expect(result.verdict).toBe("request_changes");
    // Should contain round 2 feedback (final round)
    expect(result.reviewerFeedback[0]?.feedback).toContain("round 2");
  });
});

// ---------------------------------------------------------------------------
// Tests: event sequence structure
// ---------------------------------------------------------------------------

describe("executeReviewPhase — event sequence", () => {
  it("emits events in the correct order for a single-round approval", async () => {
    const doer = makeRunner("Implementation done.");
    const reviewer = makeRunner("approve — lgtm");

    const { events } = await collectEvents(
      executeReviewPhase(reviewPhase(), {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    const types = events.map((e) => e.type);

    // phase_start comes first
    expect(types[0]).toBe("phase_start");

    // participant_start(doer) before participant_done(doer)
    const doerStartIdx = types.indexOf("participant_start");
    const doerDoneIdx = types.findIndex(
      (t, i) => t === "participant_done" && (events[i] as { role?: string }).role === "doer"
    );
    expect(doerStartIdx).toBeLessThan(doerDoneIdx);

    // reviewer participant_start before participant_done
    const reviewerStartIdx = types.findIndex(
      (t, i) => t === "participant_start" && (events[i] as { role?: string }).role === "reviewer"
    );
    const reviewerDoneIdx = types.findIndex(
      (t, i) => t === "participant_done" && (events[i] as { role?: string }).role === "reviewer"
    );
    expect(reviewerStartIdx).toBeLessThan(reviewerDoneIdx);

    // phase_done is last
    expect(types[types.length - 1]).toBe("phase_done");
  });

  it("emits correct phaseId on all events", async () => {
    const doer = makeRunner("output");
    const reviewer = makeRunner("approve — lgtm");

    const { events } = await collectEvents(
      executeReviewPhase(reviewPhase(), {}, makeOptions({ anthropic: doer, openai: reviewer }))
    );

    for (const event of events) {
      if ("phaseId" in event) {
        expect(event.phaseId).toBe("test-phase");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: missing runner edge cases
// ---------------------------------------------------------------------------

describe("executeReviewPhase — missing runners", () => {
  it("throws when doer lineage has no registered runner", async () => {
    const phase = reviewPhase({ doer: { lineage: "google" } });

    const { error } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: makeRunner("x") }))
    );

    expect(error).toBeDefined();
    expect(error?.message).toMatch(/no runner available for doer lineage "google"/);
  });

  it("emits phase_failed when doer lineage has no registered runner", async () => {
    const phase = reviewPhase({ doer: { lineage: "google" } });

    const { events } = await collectEvents(
      executeReviewPhase(phase, {}, makeOptions({ anthropic: makeRunner("x") }))
    );

    const failed = events.find((e) => e.type === "phase_failed");
    expect(failed).toBeDefined();
    expect((failed as Extract<ReviewPhaseEvent, { type: "phase_failed" }>).error).toMatch(
      /no runner available for doer lineage "google"/
    );
  });

  it("treats missing reviewer runner as non-approval (null outcome)", async () => {
    const phase = reviewPhase({
      reviewer: {
        require: 1,
        crossLineage: false,
        candidates: [{ lineage: "moonshot" }], // no moonshot runner registered
      },
      iterate: { maxRounds: 1, onDisagreement: "stop" },
    });

    const doer = makeRunner("output");

    const { events } = await collectEvents(
      // Only register anthropic (doer), NOT moonshot (reviewer)
      executeReviewPhase(phase, {}, makeOptions({ anthropic: doer }))
    );

    const result = getResult(events);
    // Reviewer couldn't run → treated as non-approval → quorum fails
    expect(result.verdict).toBe("request_changes");
    expect(result.reviewerFeedback[0]?.verdict).toBe("request_changes");
    expect(result.reviewerFeedback[0]?.feedback).toContain("No runner available");
  });
});

// ---------------------------------------------------------------------------
// Tests: abort signal
// ---------------------------------------------------------------------------

describe("executeReviewPhase — abort signal", () => {
  it("throws when signal is already aborted before execution starts", async () => {
    const controller = new AbortController();
    controller.abort();

    const doer = makeRunner("output");

    const { error } = await collectEvents(
      executeReviewPhase(
        reviewPhase(),
        {},
        makeOptions({ anthropic: doer, openai: makeRunner("approve") }),
        controller.signal
      )
    );

    expect(error).toBeDefined();
    expect(error?.message).toMatch(/aborted/);
  });
});

// ---------------------------------------------------------------------------
// Tests: inputs are included in prompt context
// ---------------------------------------------------------------------------

describe("executeReviewPhase — inputs", () => {
  it("embeds inputs into the doer prompt as JSON context block", async () => {
    const capturedPrompts: string[] = [];
    const doer: AgentRunner = {
      async *run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
        capturedPrompts.push(params.prompt);
        yield { type: "message_done" as const, text: "done" };
      },
    };
    const reviewer = makeRunner("approve — lgtm");

    await collectEvents(
      executeReviewPhase(
        reviewPhase(),
        { repoPath: "/home/user/project", feature: "auth" },
        makeOptions({ anthropic: doer, openai: reviewer })
      )
    );

    expect(capturedPrompts[0]).toContain("repoPath");
    expect(capturedPrompts[0]).toContain("/home/user/project");
    expect(capturedPrompts[0]).toContain("feature");
    expect(capturedPrompts[0]).toContain("auth");
  });
});
