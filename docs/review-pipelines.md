# Review Pipelines

Ripline's review pipeline feature lets you build multi-agent review workflows declaratively in YAML. A review pipeline fans a doer agent's output to N reviewer agents in parallel, evaluates quorum, and retries the doer if reviewers disagree — all without custom orchestration code.

---

## When to use review pipelines

Use review pipelines when:

- You want a second (or third) opinion from a different AI model or family before proceeding.
- You need to enforce that no single AI lineage can approve its own work (`crossLineage: true`).
- You want automatic retry: give the doer reviewer feedback and let it revise.
- You are reviewing an existing artifact (diff, document, PR) without running a generation step (`review_only`).

Use regular agent pipelines when:

- Each step is a single agent call with no review gate.
- You need fine-grained control over session continuity, tool use, or working directory (`runner: claude-code`).
- You are building data pipelines that mix transforms, HTTP calls, and enqueue/collect patterns.

Review phase kinds and regular node types are compatible: you can mix `plan`/`review` phases with `agent`/`transform`/`output` nodes in the same `ReviewPipelineDefinition`.

---

## Loading review pipeline YAMLs programmatically

Ripline exports two functions for loading review pipeline templates from code:

```typescript
import {
  parseReviewPipeline,
  loadReviewPipeline,
  type ParseResult,
} from 'ripline/review-pipeline-parser';
```

### `parseReviewPipeline(yaml: string): ParseResult`

Parses a YAML string into a `ReviewPipelineDefinition`. Returns a discriminated union:

```typescript
type ParseResult =
  | { ok: true;  pipeline: ReviewPipelineDefinition }
  | { ok: false; error: string };
```

Internally this function:

1. Parses the YAML text.
2. Derives edges from the `phases` array (sequential by default, or explicit via `inputs.include`).
3. Derives `entry` from the first phase when not explicitly provided.
4. Validates the result against the Zod schema, returning structured error messages on failure.

```typescript
const result = parseReviewPipeline(`
  id: arch_review
  name: Architecture review
  entry: [plan_arch]
  phases:
    - id: plan_arch
      kind: plan
      description: Draft an architecture for {{ inputs.request }}
      doer:
        lineage: anthropic
      iterate:
        maxRounds: 1
        onDisagreement: stop
    - id: review_arch
      kind: review
      description: Review the architecture.
      doer:
        lineage: anthropic
      reviewer:
        require: 2
        crossLineage: true
        candidates:
          - lineage: google
          - lineage: openai
      iterate:
        maxRounds: 3
        onDisagreement: continue
      inputs:
        include: [plan_arch]
`);

if (!result.ok) {
  console.error('Parse error:', result.error);
  process.exit(1);
}

const pipeline = result.pipeline;
```

### `loadReviewPipeline(filePath: string): Promise<ParseResult>`

Reads a YAML file from disk and parses it. Wraps `parseReviewPipeline` with file I/O.

```typescript
const result = await loadReviewPipeline('./pipelines/arch-review.yaml');
if (!result.ok) {
  throw new Error(result.error);
}
const pipeline = result.pipeline;
```

### Running a parsed pipeline

Once you have a `UnifiedPipelineDefinition`, pass it to Ripline's pipeline executor along with a voice registry:

```typescript
import { createVoiceRegistry } from 'ripline/voice-registry';
import { createClaudeCodeRunner } from 'ripline/claude-code-runner';
import { createGeminiRunner } from 'ripline/gemini-runner';
import { createCodexRunner } from 'ripline/codex-runner';
import { executeReviewPhase } from 'ripline/pipeline/executors/review-phase';

const voiceRegistry = createVoiceRegistry({
  claudeCodeRunner: createClaudeCodeRunner(),
  geminiRunner:     createGeminiRunner(),
  codexRunner:      createCodexRunner(),
});

// For a single review phase:
const reviewPhase = pipeline.phases.find(p => p.id === 'review_arch');
if (reviewPhase?.kind === 'review' || reviewPhase?.kind === 'plan') {
  const result = await executeReviewPhase(
    reviewPhase,
    { request: 'Design a URL shortener for 10k req/s' },
    { voiceRegistry }
  );
  console.log('Verdict:', result.verdict);
  console.log('Rounds used:', result.roundsUsed);
  console.log('Doer output:', result.doerOutput);
}
```

---

## How quorum works

After the doer runs, all reviewer candidates are launched in parallel (`Promise.all`). Each reviewer receives:

- The phase's original prompt/description as context (the "task").
- The doer's output for this round.

The reviewer is asked to state whether it approves or requests changes. Ripline extracts a verdict from the reviewer's free-form text using keyword matching:

- **Approved** keywords (checked in the last 400 characters, then the full text): `approve`, `approved`, `lgtm`, `looks good to me`, `no concerns`, `ship it`, `ack`.
- **Rejected** keywords: `request changes`, `requesting changes`, `disagree`, `rejected`, `rejecting`, `blocker`, `do not approve`, `don't approve`, `cannot approve`, `can't approve`, `nack`.
- **Ambiguous**: text that matches neither or matches both. Treated as non-approval for quorum purposes.

Quorum is met when:

1. The number of `approved` verdicts is >= `reviewer.require`, AND
2. If `crossLineage: true`, the approving verdicts span at least 2 distinct lineages (ignoring `"any"` resolvers).

If a reviewer candidate's lineage has no runner available in the registry, it is treated as non-approval with a `"No runner available"` explanation.

---

## The retry loop

When quorum is not met, the executor decides whether to retry based on `iterate.onDisagreement`:

**`onDisagreement: "stop"`** — Return `verdict: "request_changes"` immediately. No retry. Use this when you want a single best-effort attempt.

**`onDisagreement: "continue"`** — Build a feedback block from all non-approving reviewers and prepend it to the doer's prompt for the next round:

```
The following reviewers requested changes in the previous round. Please address their feedback:

## Reviewer: google-0 (request_changes)
<reviewer text>

## Reviewer: openai-1 (request_changes)
<reviewer text>
```

The doer then runs again with this feedback in its prompt. Reviewers are re-run on the new output. This continues until quorum is met or `maxRounds` is exhausted.

When `maxRounds` is exhausted without quorum, the executor returns `verdict: "request_changes"` with the doer's final output and the last round's reviewer feedback.

**`ReviewPhaseResult` shape:**

```typescript
type ReviewPhaseResult = {
  verdict:          'approved' | 'request_changes';
  doerOutput:       string;   // doer's output from the decisive round
  reviewerFeedback: Array<{
    lineage:  string;         // slot identifier, e.g. "google-0"
    verdict:  'approved' | 'request_changes';
    feedback: string;         // reviewer's full text response
  }>;
  roundsUsed: number;         // 1 = first try succeeded or no reviewers
};
```

---

## The ship phase config

The top-level `ship` field configures automatic branch/PR creation when the pipeline reaches a successful conclusion. It is optional.

```yaml
ship:
  enabled: true
  branchPattern: ripline/review-{chatId}
  titleTemplate: "Review pipeline: {chatId}"
```

**`ShipConfig` fields:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `enabled` | boolean | Yes | Whether to attempt branch/PR creation after a successful pipeline run. |
| `branchPattern` | string | No | Branch name template. `{chatId}` is interpolated with the run's chat/session identifier. |
| `titleTemplate` | string | No | PR title template. Same `{chatId}` interpolation. |

When `enabled: false` (or `ship` is omitted), no branch or PR is created. The ship action is a post-pipeline hook; the pipeline's output artifacts are still available regardless.

---

## Full end-to-end example

This example defines an architecture review pipeline, loads it programmatically, and runs it against the review phase executor.

### Pipeline YAML (`pipelines/arch-review.yaml`)

```yaml
id: arch_review
name: Architecture review
version: 1
description: >
  Draft an architecture, then review it with two independent AI CLIs.
  Retry the doer up to 3 times on disagreement.

ship:
  enabled: true
  branchPattern: ripline/arch-{chatId}
  titleTemplate: "Architecture review for {chatId}"

phases:
  - id: plan_arch
    kind: plan
    title: Draft architecture
    description: |
      You are a senior software architect. The request is:

      {{ inputs.request }}

      Write a concise architecture document covering:
      - System components and their responsibilities
      - Data flow between components
      - Key technology choices and rationale
      - Known risks and open questions

      Use clear markdown headings.
    doer:
      lineage: anthropic
      models:
        - claude-opus-4-5
    iterate:
      maxRounds: 1
      onDisagreement: stop

  - id: review_arch
    kind: review
    title: Architecture review
    description: |
      Review the architecture document produced in the previous step.
      Evaluate it for:
      - Completeness: are all major components addressed?
      - Correctness: are the technology choices sound?
      - Risk coverage: are risks realistic and addressed?

      End your response with either APPROVE or REQUEST CHANGES,
      followed by a brief rationale and (if requesting changes)
      specific, actionable feedback.
    doer:
      lineage: anthropic
    reviewer:
      require: 2
      crossLineage: true
      candidates:
        - lineage: google
        - lineage: openai
    iterate:
      maxRounds: 3
      onDisagreement: continue
    inputs:
      include: [plan_arch]

contracts:
  input:
    type: object
    properties:
      request: { type: string }
    required: [request]
```

### Running it

```typescript
import { loadReviewPipeline } from 'ripline/review-pipeline-parser';
import { createVoiceRegistry } from 'ripline/voice-registry';
import { createClaudeCodeRunner } from 'ripline/claude-code-runner';
import { createGeminiRunner } from 'ripline/gemini-runner';
import { createCodexRunner } from 'ripline/codex-runner';
import { executeReviewPhase } from 'ripline/pipeline/executors/review-phase';
import type { PlanPhase, ReviewPhase } from 'ripline/review-phase-types';

async function runArchReview(request: string) {
  // 1. Load and parse the pipeline YAML
  const parseResult = await loadReviewPipeline('./pipelines/arch-review.yaml');
  if (!parseResult.ok) {
    throw new Error(`Pipeline parse error: ${parseResult.error}`);
  }
  const pipeline = parseResult.pipeline;

  // 2. Set up the voice registry with available runners
  const voiceRegistry = createVoiceRegistry({
    claudeCodeRunner: createClaudeCodeRunner({
      // Uses ANTHROPIC_API_KEY from env
    }),
    geminiRunner: createGeminiRunner({
      // Uses GEMINI_API_KEY or GOOGLE_GENAI_API_KEY from env
    }),
    codexRunner: createCodexRunner({
      // Uses OPENAI_API_KEY from env
    }),
  });

  // 3. Execute each phase in order
  const inputs = { request };
  const phaseOutputs: Record<string, string> = {};

  for (const phase of pipeline.phases) {
    if (phase.kind !== 'plan' && phase.kind !== 'review') {
      continue; // skip non-review phases (e.g. output nodes)
    }

    console.log(`\n--- Running phase: ${phase.id} (${phase.kind}) ---`);

    const result = await executeReviewPhase(
      phase as PlanPhase | ReviewPhase,
      { ...inputs, ...phaseOutputs },
      { voiceRegistry }
    );

    phaseOutputs[phase.id] = result.doerOutput;

    console.log(`Verdict: ${result.verdict}`);
    console.log(`Rounds used: ${result.roundsUsed}`);

    if (result.verdict === 'request_changes') {
      console.error(`Phase ${phase.id} ended without approval after ${result.roundsUsed} rounds.`);
      process.exit(1);
    }
  }

  console.log('\n--- Pipeline complete ---');
  console.log('Final architecture document:');
  console.log(phaseOutputs['review_arch'] ?? phaseOutputs['plan_arch']);
}

runArchReview('Design a URL shortening service that handles 10k req/s').catch(console.error);
```

### What happens at runtime

1. `plan_arch` runs the `anthropic` Claude runner with the architecture prompt. Because `iterate.maxRounds` is 1 and there is no reviewer, it completes in one round and returns the draft document.

2. `review_arch` receives the `plan_arch` output as additional context (via `inputs.include`). The `anthropic` doer runs first to produce a revised/confirmed architecture. Then `google` (Gemini) and `openai` (Codex) reviewers run in parallel.

3. If both reviewers approve, the phase returns `verdict: "approved"` after round 1.

4. If either reviewer requests changes, the executor builds a feedback block from their responses and re-runs the `anthropic` doer. Reviewers re-evaluate the new output. This repeats up to `maxRounds: 3`.

5. After approval (or exhaustion of rounds), the pipeline is complete and the final architecture document is available in `phaseOutputs['review_arch']`.
