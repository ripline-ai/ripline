/**
 * container-status-map — maps container build results to pipeline run statuses.
 *
 * Provides a single source of truth for how ContainerBuildResult fields
 * translate into PipelineRunStatus values, ensuring Wintermute's pipeline
 * status display correctly reflects container-based execution states.
 *
 * Mapping rules:
 *   container exit 0 + promote "merged"         → "completed"
 *   container exit 0 + promote "needs-conflict-resolution"  → "needs-conflict-resolution"
 *   container exit 0 + promote "test-failure"     → "errored"
 *   container exit 0 + promote "error"            → "errored"
 *   container exit non-zero (build failure)       → "errored"
 *   container timed out                           → "errored"
 *   docker unavailable (fallback to direct)       → null  (caller handles)
 */

import type { ContainerBuildResult } from "./container-build-runner.js";
import type { PipelineRunStatus } from "./types.js";

/**
 * Result of mapping a container build outcome to a pipeline status.
 */
export type ContainerStatusMapping = {
  /** The pipeline run status to assign. null means "not handled by container path". */
  status: PipelineRunStatus | null;
  /** Whether the run used container-based execution. */
  usedContainer: boolean;
  /** Human-readable summary of the outcome for logging/display. */
  summary: string;
  /** Error message (if any) for the run record. */
  error?: string;
  /** Whether the feature branch should be preserved (for manual needs-conflict-resolution resolution). */
  preserveFeatureBranch: boolean;
};

/**
 * Map a ContainerBuildResult to a pipeline run status and metadata.
 *
 * This is the authoritative mapping used by the scheduler and exposed
 * for integration tests to verify status correctness.
 */
export function mapContainerBuildToRunStatus(
  result: ContainerBuildResult,
): ContainerStatusMapping {
  // Docker unavailable → caller falls back to direct execution
  if (!result.usedContainer) {
    return {
      status: null,
      usedContainer: false,
      summary: "Docker unavailable — fell back to direct execution",
      preserveFeatureBranch: false,
    };
  }

  // Container spawn or branch creation failed before execution
  if (result.error && !result.containerResult) {
    return {
      status: "errored",
      usedContainer: true,
      summary: result.error,
      error: result.error,
      preserveFeatureBranch: false,
    };
  }

  // Container timed out
  if (result.containerResult?.timedOut) {
    return {
      status: "errored",
      usedContainer: true,
      summary: `Container timed out. Logs: ${result.containerResult.logFile}`,
      error: result.error ?? "Container timed out",
      preserveFeatureBranch: true,
    };
  }

  // Container exited non-zero (build failure)
  if (result.containerResult && result.containerResult.exitCode !== 0) {
    return {
      status: "errored",
      usedContainer: true,
      summary: `Container exited with code ${result.containerResult.exitCode}. Logs: ${result.containerResult.logFile}`,
      error: result.error ?? `Container exited with code ${result.containerResult.exitCode}`,
      preserveFeatureBranch: true,
    };
  }

  // Container succeeded (exit 0) — check promote result
  if (result.promoteResult) {
    switch (result.promoteResult.status) {
      case "merged":
        return {
          status: "completed",
          usedContainer: true,
          summary: `Merged ${result.featureBranch ?? "feature branch"} successfully`,
          preserveFeatureBranch: false,
        };

      case "needs-conflict-resolution":
        return {
          status: "needs-conflict-resolution",
          usedContainer: true,
          summary: result.promoteResult.message,
          error: result.promoteResult.message,
          preserveFeatureBranch: true,
        };

      case "test-failure":
        return {
          status: "errored",
          usedContainer: true,
          summary: result.promoteResult.message,
          error: result.promoteResult.message,
          preserveFeatureBranch: true,
        };

      case "error":
        return {
          status: "errored",
          usedContainer: true,
          summary: result.promoteResult.message,
          error: result.promoteResult.message,
          preserveFeatureBranch: false,
        };
    }
  }

  // Container succeeded but no promote result (shouldn't happen in normal flow)
  if (result.error) {
    return {
      status: "errored",
      usedContainer: true,
      summary: result.error,
      error: result.error,
      preserveFeatureBranch: false,
    };
  }

  // Fallback: container exit 0 with no promote and no error — treat as completed
  return {
    status: "completed",
    usedContainer: true,
    summary: "Container completed (no promote step)",
    preserveFeatureBranch: false,
  };
}

/**
 * All possible PromoteStepResult statuses and their corresponding run statuses.
 * Useful for exhaustiveness checks in tests.
 */
export const PROMOTE_STATUS_TO_RUN_STATUS: Record<string, PipelineRunStatus> = {
  "merged": "completed",
  "needs-conflict-resolution": "needs-conflict-resolution",
  "test-failure": "errored",
  "error": "errored",
};
