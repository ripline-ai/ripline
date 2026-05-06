/**
 * review-phase.ts
 *
 * Executes a Chorus `plan` or `review` phase as a Ripline node executor.
 *
 * Execution model:
 *   1. Spawn doer agent with the task prompt (+ optional prior round feedback).
 *   2. Fan out to N reviewer agents in parallel, passing doer output.
 *   3. Evaluate quorum:
 *        - require M approvals of N candidates
 *        - crossLineage=true: approvals must span >= 2 distinct lineages
 *   4. If quorum is not met and iterate.onDisagreement === 'continue' and
 *      rounds remain → feed reviewer feedback back to the doer and retry.
 *   5. If iterate.onDisagreement === 'stop' or max rounds exhausted →
 *      return verdict 'request_changes'.
 *   6. PlanPhase with no reviewer (require: 0) → run doer only, return
 *      'approved' immediately.
 */

import type { AgentLineage, PlanPhase, ReviewPhase } from "../../review-phase-types.js";
import type { AgentRunner, TokenUsage } from "./agent.js";

// ---------------------------------------------------------------------------
// Local interface for VoiceRegistry (the real type may not exist yet)
// ---------------------------------------------------------------------------

/**
 * Minimal interface the executor needs from the voice registry.
 * The concrete VoiceRegistry from voice-registry.ts satisfies this.
 */
export interface VoiceRegistryLike {
  resolve(lineage: AgentLineage): AgentRunner | null;
}

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type ReviewerFeedbackEntry = {
  /** Reviewer slot identifier, e.g. "anthropic-0". */
  lineage: string;
  verdict: "approved" | "request_changes";
  feedback: string;
  usage?: TokenUsage;
};

export type ReviewPhaseResult = {
  verdict: "approved" | "request_changes";
  /** The doer's final output text (from the decisive round). */
  doerOutput: string;
  /** Per-reviewer feedback from the decisive round. */
  reviewerFeedback: ReviewerFeedbackEntry[];
  /** How many rounds were consumed (1 = first try succeeded or no reviewers). */
  roundsUsed: number;
};

// ---------------------------------------------------------------------------
// Streaming event types
// ---------------------------------------------------------------------------

export type ReviewPhaseEvent =
  | { type: 'phase_start';       phaseId: string; kind: 'plan' | 'review' | 'review_only'; round: number }
  | { type: 'participant_start'; phaseId: string; role: 'doer' | 'reviewer'; lineage: AgentLineage }
  | { type: 'text_delta';        phaseId: string; role: 'doer' | 'reviewer'; lineage: AgentLineage; text: string }
  | { type: 'participant_done';  phaseId: string; role: 'doer' | 'reviewer'; lineage: AgentLineage; verdict?: 'approved' | 'request_changes'; feedback?: string; usage?: TokenUsage }
  | { type: 'phase_progress';    phaseId: string; round: number; summary: string }  // disagreement, retrying
  | { type: 'phase_done';        phaseId: string; result: ReviewPhaseResult }
  | { type: 'phase_failed';      phaseId: string; error: string };

// ---------------------------------------------------------------------------
// Executor options
// ---------------------------------------------------------------------------

export type ReviewPhaseExecutorOptions = {
  voiceRegistry: VoiceRegistryLike;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Extract a boolean verdict from free-form reviewer text.
 * Mirrors the Chorus verdictFromReviewerText heuristic.
 *
 * Returns:
 *   true  = approved
 *   false = request_changes / disagreed
 *   null  = ambiguous (treated as non-approval for quorum purposes)
 */
function verdictFromReviewerText(content: string): boolean | null {
  const stripped = content.replace(/##\s*DONE\s*$/i, "").trim();

  const negatives =
    /\b(request changes|requesting changes|disagree|reject(?:ed|ing)?|blocker|(?:do not|don['']?t) (?:approve|merge)|(?:cannot|can['']?t) (?:approve|merge)|nack)\b/;
  const positives =
    /\b(approve(?:d|s)?|lgtm|looks good to me|no concerns|ship it|ack)\b/;

  const tail = stripped.slice(-400).toLowerCase();
  if (negatives.test(tail)) return false;
  if (positives.test(tail)) return true;

  const whole = stripped.toLowerCase();
  if (negatives.test(whole)) return false;
  if (positives.test(whole)) return true;

  return null;
}

/**
 * Build a text block summarising reviewer feedback for injecting into the
 * next round's doer prompt so the doer can address the disagreements.
 */
function buildFeedbackBlock(feedback: ReviewerFeedbackEntry[]): string {
  const lines: string[] = [
    "The following reviewers requested changes in the previous round. Please address their feedback:\n",
  ];
  for (const entry of feedback) {
    const header = `## Reviewer: ${entry.lineage} (${entry.verdict})`;
    lines.push(header, entry.feedback, "");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// mergeGenerators — merge concurrent AsyncGenerators into one stream
// ---------------------------------------------------------------------------

/**
 * Merge multiple AsyncGenerators into a single AsyncGenerator that yields
 * items as they arrive from any source. Generators run concurrently.
 *
 * Uses a shared queue with promise-resolve callbacks to interleave events
 * from all generators without buffering the entire output of any one.
 */
async function* mergeGenerators<T>(
  ...gens: AsyncGenerator<T>[]
): AsyncGenerator<T> {
  // Queue of resolved values waiting to be yielded.
  const queue: (T | typeof DONE)[] = [];
  let resolve: (() => void) | null = null;
  let remaining = gens.length;

  const DONE_SENTINEL = Symbol("done");
  type DoneSentinel = typeof DONE_SENTINEL;
  const DONE = DONE_SENTINEL as DoneSentinel;

  // For each generator, drain it in a background microtask and push
  // items into the shared queue.
  const drainGen = async (gen: AsyncGenerator<T>): Promise<void> => {
    try {
      for await (const item of gen) {
        queue.push(item);
        // Wake the consumer if it's waiting.
        if (resolve) {
          const r = resolve;
          resolve = null;
          r();
        }
      }
    } finally {
      remaining--;
      // Signal consumer when last generator finishes.
      if (resolve) {
        const r = resolve;
        resolve = null;
        r();
      }
    }
  };

  // Start all drains concurrently.
  const drains = gens.map(drainGen);

  // Consume from queue, waiting when empty.
  while (remaining > 0 || queue.length > 0) {
    if (queue.length === 0) {
      // Wait for an item or a generator to finish.
      await new Promise<void>((res) => {
        resolve = res;
      });
      continue;
    }
    const item = queue.shift()!;
    if (item === (DONE as unknown)) continue; // shouldn't happen
    yield item as T;
  }

  // Await all drains so unhandled rejections surface.
  await Promise.all(drains);
}

// ---------------------------------------------------------------------------
// Per-reviewer invocation — now yields ReviewPhaseEvent
// ---------------------------------------------------------------------------

async function* runReviewerStreaming(
  phaseId: string,
  slotId: string,
  lineage: AgentLineage,
  runner: AgentRunner,
  doerOutput: string,
  phasePrompt: string,
  signal: AbortSignal
): AsyncGenerator<ReviewPhaseEvent> {
  const reviewerPrompt = [
    `You are reviewing the following output produced by a peer agent.`,
    ``,
    `## Task`,
    phasePrompt,
    ``,
    `## Doer Output`,
    doerOutput,
    ``,
    `Evaluate the output. State whether you APPROVE or REQUEST CHANGES.`,
    `Be concise. Provide your verdict and specific feedback.`,
  ].join("\n");

  yield { type: 'participant_start', phaseId, role: 'reviewer', lineage };

  let text = "";
  let usage: TokenUsage | undefined;

  const gen = runner.run({
    agentId: `reviewer-${slotId}`,
    prompt: reviewerPrompt,
    resetSession: true,
  }, signal.aborted ? signal : undefined);

  for await (const event of gen) {
    if (event.type === "text_delta") {
      text += event.text;
      yield { type: 'text_delta', phaseId, role: 'reviewer', lineage, text: event.text };
    } else if (event.type === "message_done") {
      text = event.text;
      usage = event.usage;
      break;
    } else if (event.type === "error") {
      throw new Error(`Agent error [${event.kind}]: ${event.message}`);
    }
  }

  const approved = verdictFromReviewerText(text);
  const verdict: 'approved' | 'request_changes' = approved === true ? "approved" : "request_changes";

  yield {
    type: 'participant_done',
    phaseId,
    role: 'reviewer',
    lineage,
    verdict,
    feedback: text,
    ...(usage !== undefined && { usage }),
  };
}

// ---------------------------------------------------------------------------
// Quorum evaluation
// ---------------------------------------------------------------------------

type ReviewerOutcome = {
  slotId: string;
  lineage: AgentLineage;
  approved: boolean | null;
  feedback: string;
  usage?: TokenUsage;
};

type QuorumResult = {
  quorumMet: boolean;
  approvalCount: number;
  outcomes: ReviewerOutcome[];
};

function evaluateQuorum(
  outcomes: ReviewerOutcome[],
  require: number,
  crossLineage: boolean
): QuorumResult {
  const approvals = outcomes.filter((o) => o.approved === true);
  const approvalCount = approvals.length;

  if (approvalCount < require) {
    return { quorumMet: false, approvalCount, outcomes };
  }

  if (crossLineage) {
    const uniqueLineages = new Set(
      approvals
        .map((o) => o.lineage)
        .filter((l) => l !== "any")
    );
    // Need at least 2 distinct non-"any" lineages in the approvals.
    // If the resolved lineages are all "any" (all fell back), treat as
    // single lineage — quorum requires real diversity.
    const effectiveUniqueCount =
      uniqueLineages.size === 0 ? 1 : uniqueLineages.size;

    if (effectiveUniqueCount < 2) {
      return { quorumMet: false, approvalCount, outcomes };
    }
  }

  return { quorumMet: true, approvalCount, outcomes };
}

// ---------------------------------------------------------------------------
// Main executor — AsyncGenerator<ReviewPhaseEvent>
// ---------------------------------------------------------------------------

/**
 * Executes a Chorus plan or review phase, streaming events as execution
 * progresses.
 *
 * @param phase      - PlanPhase or ReviewPhase from review-phase-types.ts
 * @param inputs     - Inputs available to the phase (used for prompt interpolation)
 * @param options    - Executor options including the voice registry
 * @param signal     - Optional AbortSignal for cancellation
 */
export async function* executeReviewPhase(
  phase: ReviewPhase | PlanPhase,
  inputs: Record<string, unknown>,
  options: ReviewPhaseExecutorOptions,
  signal?: AbortSignal
): AsyncGenerator<ReviewPhaseEvent> {
  const { voiceRegistry } = options;
  const effectiveSignal = signal ?? new AbortController().signal;
  const phaseId = phase.id;
  const phaseKind = phase.kind as 'plan' | 'review' | 'review_only';

  const reviewer = phase.reviewer;
  const iterate = phase.iterate;

  // Build the base doer prompt from the phase description/title.
  const inputSummary =
    Object.keys(inputs).length > 0
      ? `\n\n## Context\n${JSON.stringify(inputs, null, 2)}`
      : "";
  const basePrompt = [
    phase.title ? `# ${phase.title}` : "",
    phase.description ?? "",
    inputSummary,
  ]
    .filter(Boolean)
    .join("\n\n");

  // PlanPhase with no reviewer, or reviewer.require === 0: run doer only.
  const requireCount = reviewer?.require ?? 0;
  const hasCandidates = (reviewer?.candidates.length ?? 0) > 0;
  const isDoerOnly = requireCount === 0 && !hasCandidates;

  const doerLineage = phase.doer.lineage;
  const doerRunner = voiceRegistry.resolve(doerLineage);

  if (!doerRunner) {
    yield {
      type: 'phase_failed',
      phaseId,
      error: `executeReviewPhase: no runner available for doer lineage "${doerLineage}"`,
    };
    throw new Error(
      `executeReviewPhase: no runner available for doer lineage "${doerLineage}"`
    );
  }

  let roundsUsed = 0;
  let lastDoerOutput = "";
  let lastReviewerFeedback: ReviewerFeedbackEntry[] = [];
  let priorFeedbackBlock = "";

  const maxRounds = iterate.maxRounds;

  try {
    for (let round = 1; round <= maxRounds; round++) {
      if (effectiveSignal.aborted) {
        throw new Error("executeReviewPhase: aborted");
      }

      roundsUsed = round;

      // Yield phase_start at the beginning of each round.
      yield { type: 'phase_start', phaseId, kind: phaseKind, round };

      // Build doer prompt: base + any prior-round feedback.
      const doerPrompt =
        priorFeedbackBlock.length > 0
          ? `${basePrompt}\n\n${priorFeedbackBlock}`
          : basePrompt;

      // Stream doer events.
      yield { type: 'participant_start', phaseId, role: 'doer', lineage: doerLineage };

      let doerText = "";
      let doerUsage: TokenUsage | undefined;

      const doerGen = doerRunner.run({
        agentId: `doer-${phaseId}`,
        prompt: doerPrompt,
        resetSession: true,
      });

      for await (const event of doerGen) {
        if (event.type === "text_delta") {
          doerText += event.text;
          yield { type: 'text_delta', phaseId, role: 'doer', lineage: doerLineage, text: event.text };
        } else if (event.type === "message_done") {
          doerText = event.text;
          doerUsage = event.usage;
          break;
        } else if (event.type === "error") {
          throw new Error(`Agent error [${event.kind}]: ${event.message}`);
        }
      }

      lastDoerOutput = doerText;

      yield {
        type: 'participant_done',
        phaseId,
        role: 'doer',
        lineage: doerLineage,
        ...(doerUsage !== undefined && { usage: doerUsage }),
      };

      // Doer-only case: no reviewer gate.
      if (isDoerOnly) {
        const result: ReviewPhaseResult = {
          verdict: "approved",
          doerOutput: lastDoerOutput,
          reviewerFeedback: [],
          roundsUsed,
        };
        yield { type: 'phase_done', phaseId, result };
        return;
      }

      // Fan out to reviewer candidates in parallel, merging event streams.
      const candidates = reviewer!.candidates;
      const phasePromptForReviewers = basePrompt;

      // Collect outcomes alongside streaming events.
      // We build per-reviewer generators and merge them, but also need to
      // capture the outcome for quorum evaluation. We do this by wrapping
      // each reviewer generator to capture its participant_done payload.
      const outcomes: ReviewerOutcome[] = new Array(candidates.length);

      // Build per-reviewer generators that also capture outcomes.
      const reviewerGens = candidates.map((candidate, idx) => {
        const slotId = `${candidate.lineage}-${idx}`;
        const reviewerLineage = candidate.lineage;
        const reviewerRunner = voiceRegistry.resolve(reviewerLineage);

        if (!reviewerRunner) {
          // No runner available — emit synthetic events and treat as non-approval.
          const syntheticGen = (async function* (): AsyncGenerator<ReviewPhaseEvent> {
            const feedback = `No runner available for lineage "${reviewerLineage}"`;
            yield { type: 'participant_start' as const, phaseId, role: 'reviewer' as const, lineage: reviewerLineage };
            yield {
              type: 'participant_done' as const,
              phaseId,
              role: 'reviewer' as const,
              lineage: reviewerLineage,
              verdict: 'request_changes' as const,
              feedback,
            };
            outcomes[idx] = {
              slotId,
              lineage: reviewerLineage,
              approved: null,
              feedback,
            };
          })();
          return syntheticGen;
        }

        // Wrap the streaming reviewer to also capture outcome from participant_done.
        const wrappedGen = (async function* (): AsyncGenerator<ReviewPhaseEvent> {
          const gen = runReviewerStreaming(
            phaseId,
            slotId,
            reviewerLineage,
            reviewerRunner,
            lastDoerOutput,
            phasePromptForReviewers,
            effectiveSignal
          );
          for await (const event of gen) {
            yield event;
            if (event.type === 'participant_done' && event.role === 'reviewer') {
              outcomes[idx] = {
                slotId,
                lineage: reviewerLineage,
                approved: event.verdict === 'approved' ? true : event.verdict === 'request_changes' ? false : null,
                feedback: event.feedback ?? "",
                ...(event.usage !== undefined && { usage: event.usage }),
              };
            }
          }
        })();
        return wrappedGen;
      });

      // Yield all reviewer events as they arrive (concurrent).
      for await (const event of mergeGenerators(...reviewerGens)) {
        yield event;
      }

      // Build feedback entries for this round.
      lastReviewerFeedback = outcomes.map((o): ReviewerFeedbackEntry => ({
        lineage: o.slotId,
        verdict: o.approved === true ? "approved" : "request_changes",
        feedback: o.feedback,
        ...(o.usage !== undefined && { usage: o.usage }),
      }));

      // Evaluate quorum.
      const quorum = evaluateQuorum(
        outcomes,
        reviewer!.require,
        reviewer!.crossLineage ?? false
      );

      if (quorum.quorumMet) {
        const result: ReviewPhaseResult = {
          verdict: "approved",
          doerOutput: lastDoerOutput,
          reviewerFeedback: lastReviewerFeedback,
          roundsUsed,
        };
        yield { type: 'phase_done', phaseId, result };
        return;
      }

      // Quorum not met — decide whether to retry.
      const canRetry =
        iterate.onDisagreement === "continue" && round < maxRounds;

      if (!canRetry) {
        // Stop immediately or out of rounds.
        const result: ReviewPhaseResult = {
          verdict: "request_changes",
          doerOutput: lastDoerOutput,
          reviewerFeedback: lastReviewerFeedback,
          roundsUsed,
        };
        yield { type: 'phase_done', phaseId, result };
        return;
      }

      // Build feedback block for the next round's doer prompt.
      const disagreements = lastReviewerFeedback.filter(
        (e) => e.verdict === "request_changes"
      );
      priorFeedbackBlock = buildFeedbackBlock(disagreements);

      // Emit progress event summarising the disagreement.
      const summary = disagreements
        .map((d) => `${d.lineage}: ${d.feedback.slice(0, 200)}`)
        .join("; ");
      yield { type: 'phase_progress', phaseId, round, summary };
    }

    // Exhausted all rounds without quorum.
    const result: ReviewPhaseResult = {
      verdict: "request_changes",
      doerOutput: lastDoerOutput,
      reviewerFeedback: lastReviewerFeedback,
      roundsUsed,
    };
    yield { type: 'phase_done', phaseId, result };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    yield { type: 'phase_failed', phaseId, error: message };
    throw error;
  }
}
