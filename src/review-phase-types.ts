/**
 * review-phase-types.ts
 *
 * Unified schema that merges review pipeline phase types with Ripline's existing
 * PipelineNode / PipelineDefinition types.
 *
 * Design rules:
 *   - `kind` is the discriminant on PipelinePhase.
 *   - Ripline-native node types are embedded in a unified pipeline with their
 *     existing `type` field accepted directly; `kind` is also accepted as an
 *     alias so callers can use either.
 *   - Nothing in types.ts is removed or modified.
 */

import { z } from "zod";
import type { PipelineDefinition, PipelineEdge } from "./types.js";

// ---------------------------------------------------------------------------
// Lineage & voice
// ---------------------------------------------------------------------------

export type AgentLineage =
  | "anthropic"
  | "openai"
  | "google"
  | "moonshot"
  | "opencode"
  | "any";

export type VoiceSpec = {
  lineage: AgentLineage;
  models?: string[];
};

export type DoerConfig = {
  lineage: AgentLineage;
  models?: string[];
};

export type ReviewerConfig = {
  require: number;
  crossLineage?: boolean;
  candidates: VoiceSpec[];
};

// ---------------------------------------------------------------------------
// Iteration & inputs
// ---------------------------------------------------------------------------

export type PhaseIterateConfig = {
  maxRounds: number;
  onDisagreement: "continue" | "stop";
  shareSessionAcrossRounds?: boolean;
  shareSessionAcrossPhases?: boolean;
};

export type PhaseInputsConfig = {
  include?: string[];
  exclude?: string[];
};

// ---------------------------------------------------------------------------
// Phase types (discriminated by `kind`)
// ---------------------------------------------------------------------------

/** Phase base fields shared across all phase kinds. */
type PhaseBase = {
  id: string;
  title?: string;
  description?: string;
  iterate: PhaseIterateConfig;
  inputs?: PhaseInputsConfig;
};

/**
 * `plan` — single doer produces output; reviewer is optional (quorum = 0 means
 * no review gate).
 */
export type PlanPhase = PhaseBase & {
  kind: "plan";
  doer: DoerConfig;
  reviewer?: ReviewerConfig;
};

/**
 * `review` — doer produces; one or more reviewers critique; quorum gate before
 * next phase.
 */
export type ReviewPhase = PhaseBase & {
  kind: "review";
  doer: DoerConfig;
  reviewer: ReviewerConfig;
};

/**
 * `review_only` — no doer; reviewers evaluate an existing artifact.
 * `artifact` identifies the upstream output being reviewed (e.g. a phase id or
 * artifact key).
 */
export type ReviewOnlyPhase = PhaseBase & {
  kind: "review_only";
  reviewer: ReviewerConfig;
  artifact?: {
    /** Phase id or artifact key whose output is being reviewed. */
    source: string;
    /** Optional human-readable label for the artifact. */
    label?: string;
  };
};

// ---------------------------------------------------------------------------
// Ripline-native node phases wrapped with `kind` discriminant
// ---------------------------------------------------------------------------
//
// Ripline nodes use `type` as their discriminant. To embed them inside a
// ReviewPipelineDefinition `phases` array we accept them under the original
// `type` field AND under `kind` (both are optional aliases for the same
// concept).  At the TypeScript level we model them as intersection types so
// the node's `type` value doubles as the `kind`.

import type {
  LiteralNode,
  InputNode,
  TransformNode,
  AgentNode,
  RunPipelineNode,
  LoopNode,
  CheckpointNode,
  OutputNode,
  EnqueueNode,
  CollectChildrenNode,
} from "./types.js";

/** Ripline node with an optional `kind` alias mirroring `type`. */
type WithKind<T extends { type: string }> = T & { kind?: T["type"] };

export type RiplineLiteralPhase = WithKind<LiteralNode>;
export type RiplineInputPhase = WithKind<InputNode>;
export type RiplineTransformPhase = WithKind<TransformNode>;
export type RiplineAgentPhase = WithKind<AgentNode>;
export type RiplineRunPipelinePhase = WithKind<RunPipelineNode>;
export type RiplineLoopPhase = WithKind<LoopNode>;
export type RiplineCheckpointPhase = WithKind<CheckpointNode>;
export type RiplineOutputPhase = WithKind<OutputNode>;
export type RiplineEnqueuePhase = WithKind<EnqueueNode>;
export type RiplineCollectChildrenPhase = WithKind<CollectChildrenNode>;

// ---------------------------------------------------------------------------
// PipelinePhase — discriminated union
// ---------------------------------------------------------------------------

/**
 * A phase inside a ReviewPipelineDefinition.  It is either a review phase
 * (discriminated by `kind: 'plan' | 'review' | 'review_only'`) or a
 * Ripline-native node (which carries its own `type` field and an optional
 * `kind` alias).
 */
export type PipelinePhase =
  | PlanPhase
  | ReviewPhase
  | ReviewOnlyPhase
  | RiplineLiteralPhase
  | RiplineInputPhase
  | RiplineTransformPhase
  | RiplineAgentPhase
  | RiplineRunPipelinePhase
  | RiplineLoopPhase
  | RiplineCheckpointPhase
  | RiplineOutputPhase
  | RiplineEnqueuePhase
  | RiplineCollectChildrenPhase;

// ---------------------------------------------------------------------------
// Ship config
// ---------------------------------------------------------------------------

export type ShipConfig = {
  enabled: boolean;
  /** Branch name pattern; supports {chatId} interpolation. */
  branchPattern?: string;
  /** PR title template; supports {chatId} interpolation. */
  titleTemplate?: string;
};

// ---------------------------------------------------------------------------
// ReviewPipelineDefinition
// ---------------------------------------------------------------------------

/**
 * Extends Ripline's PipelineDefinition with review pipeline top-level fields
 * and replaces `nodes` with `phases`.
 *
 * - `nodes` is retained as optional for backward compatibility with existing
 *   Ripline-only pipelines.
 * - `phases` carries the unified phase array (review phases or Ripline nodes).
 * - When both are present, `phases` takes precedence for execution.
 */
export type ReviewPipelineDefinition = Omit<PipelineDefinition, "nodes"> & {
  // Review pipeline top-level fields
  author?: string;
  agreementThreshold?: number;
  onThresholdMet?: "ask" | "auto" | string;
  maxRounds?: number;
  yoloDefault?: boolean;
  estimatedBaselineTokens?: number;
  ship?: ShipConfig;

  // Unified phase list (replaces nodes for review pipeline templates)
  phases: PipelinePhase[];

  // Ripline-native nodes kept for backward compatibility
  nodes?: PipelineDefinition["nodes"];

  // Edges remain optional because review pipeline templates are implicitly sequential
  edges?: PipelineEdge[];
};

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

export const agentLineageSchema = z.enum([
  "anthropic",
  "openai",
  "google",
  "moonshot",
  "opencode",
  "any",
]);

export const voiceSpecSchema = z.object({
  lineage: agentLineageSchema,
  models: z.array(z.string()).optional(),
});

export const doerConfigSchema = z.object({
  lineage: agentLineageSchema,
  models: z.array(z.string()).optional(),
});

export const reviewerConfigSchema = z.object({
  require: z.number().int().min(0),
  crossLineage: z.boolean().optional(),
  candidates: z.array(voiceSpecSchema),
});

export const phaseIterateConfigSchema = z.object({
  maxRounds: z.number().int().min(1),
  onDisagreement: z.enum(["continue", "stop"]),
  shareSessionAcrossRounds: z.boolean().optional(),
  shareSessionAcrossPhases: z.boolean().optional(),
});

export const phaseInputsConfigSchema = z.object({
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

const phaseBaseSchema = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  description: z.string().optional(),
  iterate: phaseIterateConfigSchema,
  inputs: phaseInputsConfigSchema.optional(),
});

export const planPhaseSchema = phaseBaseSchema.extend({
  kind: z.literal("plan"),
  doer: doerConfigSchema,
  reviewer: reviewerConfigSchema.optional(),
});

export const reviewPhaseSchema = phaseBaseSchema.extend({
  kind: z.literal("review"),
  doer: doerConfigSchema,
  reviewer: reviewerConfigSchema,
});

export const reviewOnlyPhaseSchema = phaseBaseSchema.extend({
  kind: z.literal("review_only"),
  reviewer: reviewerConfigSchema,
  artifact: z
    .object({
      source: z.string().min(1),
      label: z.string().optional(),
    })
    .optional(),
});

export const shipConfigSchema = z.object({
  enabled: z.boolean(),
  branchPattern: z.string().optional(),
  titleTemplate: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Zod schemas for Ripline-native node phases (with optional `kind` alias)
// ---------------------------------------------------------------------------
//
// We re-declare minimal inline schemas here to avoid a circular dependency on
// schema.ts.  The `kind` field is accepted as an alias for `type` — both are
// optional on the extended form; the required discriminant comes from `type`.

const baseNodeSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  contracts: z
    .object({
      input: z.record(z.string(), z.any()).optional(),
      output: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1),
      delayMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

export const riplineLiteralPhaseSchema = baseNodeSchema.extend({
  type: z.literal("data"),
  kind: z.literal("data").optional(),
  value: z.any(),
});

export const riplineInputPhaseSchema = baseNodeSchema.extend({
  type: z.literal("input"),
  kind: z.literal("input").optional(),
  path: z.string().optional(),
});

export const riplineTransformPhaseSchema = baseNodeSchema.extend({
  type: z.literal("transform"),
  kind: z.literal("transform").optional(),
  expression: z.string().min(1),
  assigns: z.string().optional(),
});

export const riplineAgentPhaseSchema = baseNodeSchema.extend({
  type: z.literal("agent"),
  kind: z.literal("agent").optional(),
  prompt: z.string().min(1),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  resetSession: z.boolean().optional(),
  channel: z.string().optional(),
  deliver: z.boolean().optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  runner: z.literal("claude-code").optional(),
  mode: z.enum(["plan", "execute"]).optional(),
  cwd: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  model: z.string().min(1).optional(),
});

export const riplineRunPipelinePhaseSchema = baseNodeSchema.extend({
  type: z.literal("run_pipeline"),
  kind: z.literal("run_pipeline").optional(),
  pipelineId: z.string().min(1),
  inputMapping: z.record(z.string(), z.string()).optional(),
  mode: z.enum(["child", "inline"]).optional(),
});

// LoopNode body references PipelineNode recursively — use z.any() for the body
// to avoid circular reference complexity while still validating the envelope.
export const riplineLoopPhaseSchema = baseNodeSchema.extend({
  type: z.literal("loop"),
  kind: z.literal("loop").optional(),
  collection: z.string().min(1),
  itemVar: z.string().optional(),
  indexVar: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  exitCondition: z.string().optional(),
  body: z.any(),
});

export const riplineCheckpointPhaseSchema = baseNodeSchema.extend({
  type: z.literal("checkpoint"),
  kind: z.literal("checkpoint").optional(),
  reason: z.string().optional(),
  resumeKey: z.string().optional(),
});

export const riplineOutputPhaseSchema = baseNodeSchema.extend({
  type: z.literal("output"),
  kind: z.literal("output").optional(),
  path: z.string().optional(),
  source: z.string().optional(),
  merge: z.boolean().optional(),
});

export const riplineEnqueuePhaseSchema = baseNodeSchema.extend({
  type: z.literal("enqueue"),
  kind: z.literal("enqueue").optional(),
  pipelineId: z.string().min(1),
  tasksSource: z.string().optional(),
  mode: z.enum(["batch", "per-item"]).optional(),
});

export const riplineCollectChildrenPhaseSchema = baseNodeSchema.extend({
  type: z.literal("collect_children"),
  kind: z.literal("collect_children").optional(),
});

// ---------------------------------------------------------------------------
// Pipeline phase discriminated union schema
// ---------------------------------------------------------------------------
//
// Review phases are discriminated by `kind`; Ripline phases are discriminated
// by `type`.  Zod's discriminatedUnion requires a single shared key, so we
// compose via z.union which still provides clean parse errors at the cost of
// slightly slower compilation for unknown inputs.

export const pipelinePhaseSchema: z.ZodType<PipelinePhase> = z.union([
  // Review-native phases (kind discriminant)
  planPhaseSchema,
  reviewPhaseSchema,
  reviewOnlyPhaseSchema,
  // Ripline-native phases (type discriminant)
  riplineLiteralPhaseSchema,
  riplineInputPhaseSchema,
  riplineTransformPhaseSchema,
  riplineAgentPhaseSchema,
  riplineRunPipelinePhaseSchema,
  riplineLoopPhaseSchema,
  riplineCheckpointPhaseSchema,
  riplineOutputPhaseSchema,
  riplineEnqueuePhaseSchema,
  riplineCollectChildrenPhaseSchema,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
]) as unknown as z.ZodType<PipelinePhase>;

export const edgeSchema = z.object({
  id: z.string().optional(),
  from: z.object({ node: z.string().min(1), port: z.string().optional() }),
  to: z.object({ node: z.string().min(1), port: z.string().optional() }),
  when: z.string().optional(),
});

/**
 * Zod schema for ReviewPipelineDefinition.
 *
 * Validation rules:
 *   - `phases` is required and must be non-empty.
 *   - `nodes` is optional (backward compat).
 *   - `edges` is optional (review pipeline templates are implicitly sequential).
 *   - `entry` is required (Ripline execution model).
 */
export const reviewPipelineDefinitionSchema: z.ZodType<ReviewPipelineDefinition> =
  z
    .object({
      // Core Ripline fields
      id: z.string().min(1),
      version: z.union([z.string(), z.number()]).optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      entry: z.array(z.string().min(1)).min(1),
      contracts: z
        .object({
          input: z.record(z.string(), z.any()).optional(),
          output: z.record(z.string(), z.any()).optional(),
        })
        .optional(),
      tags: z.array(z.string()).optional(),
      metadata: z.record(z.string(), z.any()).optional(),

      // Review pipeline top-level fields
      author: z.string().optional(),
      agreementThreshold: z.number().min(0).max(1).optional(),
      onThresholdMet: z.string().optional(),
      maxRounds: z.number().int().min(1).optional(),
      yoloDefault: z.boolean().optional(),
      estimatedBaselineTokens: z.number().int().positive().optional(),
      ship: shipConfigSchema.optional(),

      // Phases (required in review pipeline definition)
      phases: z.array(pipelinePhaseSchema).min(1),

      // Ripline-native nodes (optional, backward compat)
      nodes: z.array(z.any()).optional(),

      // Edges optional (review pipeline templates are implicitly sequential)
      edges: z.array(edgeSchema).optional(),
    })
    .superRefine((value, ctx) => {
      // Validate that entry phase ids exist in phases
      const phaseIds = new Set<string>();
      const duplicates = new Set<string>();

      for (const phase of value.phases) {
        const id = "id" in phase ? phase.id : undefined;
        if (id !== undefined) {
          if (phaseIds.has(id)) duplicates.add(id);
          phaseIds.add(id);
        }
      }

      for (const id of duplicates) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate phase id: ${id}`,
          path: ["phases"],
        });
      }

      for (const entryId of value.entry) {
        if (!phaseIds.has(entryId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `entry phase not found: ${entryId}`,
            path: ["entry"],
          });
        }
      }

      // Validate edge references when edges are present
      if (value.edges) {
        for (const edge of value.edges) {
          if (!phaseIds.has(edge.from.node)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `edge.from missing phase ${edge.from.node}`,
            });
          }
          if (!phaseIds.has(edge.to.node)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: `edge.to missing phase ${edge.to.node}`,
            });
          }
        }
      }
    }) as unknown as z.ZodType<ReviewPipelineDefinition>;
