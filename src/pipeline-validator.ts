/**
 * pipeline-validator — validates pipeline definitions for container-path compatibility.
 *
 * Provides validation utilities used by integration tests and the scheduler
 * to verify that pipeline definitions are structurally sound for container-based
 * execution. Validates:
 *
 * - Required fields (id, nodes, entry) are present
 * - Queue declaration exists for top-level build pipelines
 * - Parallel loops reference valid child pipelines
 * - Retry policies are well-formed
 * - Node types are recognized
 */

import type { PipelineDefinition, PipelineNode, LoopNode, RetryPolicy, RunPipelineNode } from "./types.js";

export type ValidationSeverity = "error" | "warning";

export type ValidationIssue = {
  severity: ValidationSeverity;
  message: string;
  /** The node ID related to the issue, if applicable. */
  nodeId?: string;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  /** Pipeline id, if parseable. */
  pipelineId?: string;
};

/**
 * Validate a pipeline definition for general structural correctness.
 */
export function validatePipelineDefinition(def: PipelineDefinition): ValidationResult {
  const issues: ValidationIssue[] = [];

  // Required top-level fields
  if (!def.id) {
    issues.push({ severity: "error", message: "Pipeline missing required 'id' field" });
  }
  if (!def.nodes || !Array.isArray(def.nodes) || def.nodes.length === 0) {
    issues.push({ severity: "error", message: "Pipeline missing or empty 'nodes' array" });
  }
  if (!def.entry || !Array.isArray(def.entry) || def.entry.length === 0) {
    issues.push({ severity: "error", message: "Pipeline missing or empty 'entry' array" });
  }

  // Verify all entry nodes exist
  if (def.nodes && def.entry) {
    const nodeIds = new Set(def.nodes.map((n) => n.id));
    for (const entryId of def.entry) {
      if (!nodeIds.has(entryId)) {
        issues.push({
          severity: "error",
          message: `Entry node '${entryId}' not found in nodes`,
        });
      }
    }
  }

  // Check node types are known
  const knownTypes = new Set([
    "data", "input", "transform", "agent", "run_pipeline",
    "loop", "switch", "checkpoint", "output", "enqueue",
    "collect_children", "shell",
  ]);

  if (def.nodes) {
    for (const node of def.nodes) {
      if (!knownTypes.has(node.type)) {
        issues.push({
          severity: "warning",
          message: `Unknown node type '${node.type}'`,
          nodeId: node.id,
        });
      }
    }
  }

  // Validate retry policy if present
  if (def.retry) {
    const retryIssues = validateRetryPolicy(def.retry);
    issues.push(...retryIssues);
  }

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    pipelineId: def.id,
  };
}

/**
 * Validate that a pipeline is suitable for container-based execution
 * through the scheduler's build queue.
 */
export function validateContainerBuildPipeline(def: PipelineDefinition): ValidationResult {
  const base = validatePipelineDefinition(def);
  const issues = [...base.issues];

  // Top-level build pipelines should declare a queue
  if (!def.queue) {
    issues.push({
      severity: "warning",
      message: "Pipeline has no 'queue' declaration — will use 'default' queue",
    });
  }

  // Check for parallel loops and validate their child pipeline references
  if (def.nodes) {
    for (const node of def.nodes) {
      if (node.type === "loop") {
        const loopNode = node as LoopNode;
        if (loopNode.mode === "parallel") {
          if (loopNode.body?.pipelineId) {
            // Child pipeline reference — good
          } else if (!loopNode.body?.nodes || loopNode.body.nodes.length === 0) {
            issues.push({
              severity: "warning",
              message: `Parallel loop '${loopNode.id}' has no pipelineId and no inline nodes`,
              nodeId: loopNode.id,
            });
          }
        }
      }

      // Check run_pipeline nodes for pipeline references
      if (node.type === "run_pipeline") {
        const rpNode = node as RunPipelineNode;
        if (!rpNode.pipelineId) {
          issues.push({
            severity: "error",
            message: `run_pipeline node '${rpNode.id}' missing pipelineId`,
            nodeId: rpNode.id,
          });
        }
      }
    }
  }

  return {
    valid: issues.filter((i) => i.severity === "error").length === 0,
    issues,
    pipelineId: def.id,
  };
}

/**
 * Quick smoke test: verify a pipeline definition has the minimum fields
 * needed to be loadable by the pipeline registry and schedulable.
 */
export function smokeTestPipelineDefinition(def: PipelineDefinition): {
  pass: boolean;
  reason?: string;
} {
  if (!def.id) return { pass: false, reason: "Missing pipeline id" };
  if (!def.nodes || def.nodes.length === 0) return { pass: false, reason: "No nodes defined" };
  if (!def.entry || def.entry.length === 0) return { pass: false, reason: "No entry points" };

  // Verify at least one entry node exists in nodes
  const nodeIds = new Set(def.nodes.map((n) => n.id));
  for (const entryId of def.entry) {
    if (!nodeIds.has(entryId)) {
      return { pass: false, reason: `Entry node '${entryId}' missing from nodes` };
    }
  }

  return { pass: true };
}

/**
 * Validate a RetryPolicy for well-formedness.
 */
function validateRetryPolicy(policy: RetryPolicy): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (policy.maxAttempts < 1) {
    issues.push({
      severity: "error",
      message: `Retry policy maxAttempts must be >= 1 (got ${policy.maxAttempts})`,
    });
  }
  if (policy.backoffMs < 0) {
    issues.push({
      severity: "error",
      message: `Retry policy backoffMs must be >= 0 (got ${policy.backoffMs})`,
    });
  }
  if (policy.backoffMultiplier < 1) {
    issues.push({
      severity: "warning",
      message: `Retry policy backoffMultiplier < 1 means decreasing backoff (got ${policy.backoffMultiplier})`,
    });
  }
  if (!policy.retryableCategories || policy.retryableCategories.length === 0) {
    issues.push({
      severity: "warning",
      message: "Retry policy has no retryable categories — retries will never trigger",
    });
  }

  return issues;
}
