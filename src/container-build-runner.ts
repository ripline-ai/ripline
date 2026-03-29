/**
 * container-build-runner — orchestrates container-based pipeline execution.
 *
 * Workflow:
 * 1. Check Docker availability (fall back to direct execution if unavailable)
 * 2. Create a feature branch `build/{pipelineRunId}` on the host repo
 * 3. Spawn a container via ContainerManager with repo/branch/context env vars
 * 4. On success, invoke promoteStep to merge the feature branch
 * 5. On failure, mark the run as failed with container logs accessible
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { ContainerManager, type ContainerResult } from "./container-manager.js";
import { promoteStep, type PromoteStepResult } from "./promote-step.js";
import { createLogger, type Logger } from "./log.js";

/* ── Types ──────────────────────────────────────────────────────────── */

export interface ContainerBuildConfig {
  /** Absolute path to the host git repository. */
  repoPath: string;
  /** Target branch to merge into (e.g. "main"). Default "main". */
  targetBranch?: string;
  /** Docker image to use for builds. Default "ripline-builder:latest". */
  buildImage?: string;
  /** Shell command to run the project test suite during promote. Default "npm test". */
  testCommand?: string;
  /** Path on host to mount as secrets inside the container. */
  secretsMountPath?: string;
  /** Timeout in ms for the container. Default 600_000 (10 min). */
  containerTimeoutMs?: number;
  /** Resource limits (CPU, memory) for each container. */
  resourceLimits?: { cpus?: string; memory?: string };
  /** Logger instance. */
  logger?: Logger;
  /** Absolute path to the runs directory (for co-locating container logs with run records). */
  runsDir?: string;
}

export interface ContainerBuildResult {
  /** Whether container-based execution was used (false = fell back to direct). */
  usedContainer: boolean;
  /** Container result (only set if usedContainer is true). */
  containerResult?: ContainerResult;
  /** Promote step result (only set on container success). */
  promoteResult?: PromoteStepResult;
  /** The feature branch name created for this build. */
  featureBranch?: string;
  /** Error message if container execution failed. */
  error?: string;
}

/* ── Docker availability check ──────────────────────────────────────── */

let _dockerAvailable: boolean | null = null;

export function isDockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5_000 });
    _dockerAvailable = true;
  } catch {
    _dockerAvailable = false;
  }
  return _dockerAvailable;
}

/** Reset the cached Docker availability check (for testing). */
export function resetDockerAvailableCache(): void {
  _dockerAvailable = null;
}

/* ── Feature branch helpers ─────────────────────────────────────────── */

function gitSync(repoPath: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 30_000,
  }).trim();
}

/**
 * Create a feature branch `build/{runId}` from the current HEAD of targetBranch.
 * Returns the branch name.
 */
export function createFeatureBranch(
  repoPath: string,
  runId: string,
  targetBranch: string,
): string {
  const branchName = `build/${runId}`;
  // Ensure we're on the target branch and up to date
  gitSync(repoPath, ["checkout", targetBranch]);
  try {
    gitSync(repoPath, ["pull", "origin", targetBranch]);
  } catch {
    // Remote may not exist in local-only setups — continue
  }
  // Create and checkout the feature branch
  gitSync(repoPath, ["checkout", "-b", branchName]);
  return branchName;
}

/* ── Main entry point ───────────────────────────────────────────────── */

/**
 * Attempt to run a pipeline build inside a Docker container.
 *
 * Returns a result indicating whether container execution was used.
 * If Docker is unavailable, returns { usedContainer: false } so the
 * caller can fall back to direct execution.
 */
export async function runContainerBuild(
  runId: string,
  pipelineId: string,
  pipelineContext: Record<string, unknown>,
  config: ContainerBuildConfig,
): Promise<ContainerBuildResult> {
  const {
    repoPath,
    targetBranch = "main",
    buildImage = "ripline-builder:latest",
    testCommand = "npm test",
    secretsMountPath,
    containerTimeoutMs = 600_000,
    resourceLimits,
    logger = createLogger(),
    runsDir,
  } = config;

  // 1. Check Docker availability
  if (!isDockerAvailable()) {
    logger.log("warn", "[container-build] Docker is not available — falling back to direct execution");
    return { usedContainer: false };
  }

  // 2. Create feature branch
  let featureBranch: string;
  try {
    featureBranch = createFeatureBranch(repoPath, runId, targetBranch);
    logger.log("info", `[container-build] Created feature branch: ${featureBranch}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("error", `[container-build] Failed to create feature branch: ${msg}`);
    return {
      usedContainer: true,
      error: `Failed to create feature branch: ${msg}`,
    };
  }

  // 3. Build env vars and volumes for container
  // Detect git remote URL for containers that may need to clone independently
  let repoUrl = "";
  try {
    repoUrl = gitSync(repoPath, ["remote", "get-url", "origin"]);
  } catch {
    // Local-only repo — leave empty
  }

  const env: Record<string, string> = {
    RIPLINE_REPO_PATH: repoPath,
    RIPLINE_REPO_URL: repoUrl,
    RIPLINE_BRANCH: featureBranch,
    RIPLINE_TARGET_BRANCH: targetBranch,
    RIPLINE_RUN_ID: runId,
    RIPLINE_PIPELINE_ID: pipelineId,
    RIPLINE_PIPELINE_CONTEXT: JSON.stringify(pipelineContext),
    RIPLINE_JOB_INPUTS: JSON.stringify(pipelineContext.inputs ?? {}),
  };

  const volumes: Record<string, string> = {
    [repoPath]: "/workspace",
  };

  if (secretsMountPath && fs.existsSync(secretsMountPath)) {
    volumes[secretsMountPath] = "/run/secrets";
    env.RIPLINE_SECRETS_PATH = "/run/secrets";
  }

  // 4. Determine log file path — co-locate with run records when runsDir is available
  const logDir = runsDir
    ? path.join(runsDir, runId)
    : path.join(repoPath, ".ripline", "runs", runId);
  fs.mkdirSync(logDir, { recursive: true });
  const logFile = path.join(logDir, "container.log");

  // 5. Spawn container
  const containerManager = new ContainerManager({ logger });
  let containerResult: ContainerResult;
  try {
    containerResult = await containerManager.spawn({
      image: buildImage,
      env,
      volumes,
      workdir: "/workspace",
      logFile,
      name: `ripline-build-${runId.slice(0, 8)}`,
      timeoutMs: containerTimeoutMs,
      ...(resourceLimits !== undefined && { resourceLimits }),
    });
    logger.log("info", `[container-build] Container exited: code=${containerResult.exitCode}, timedOut=${containerResult.timedOut}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.log("error", `[container-build] Container spawn failed: ${msg}`);
    // Clean up feature branch on spawn failure
    try {
      gitSync(repoPath, ["checkout", targetBranch]);
      gitSync(repoPath, ["branch", "-D", featureBranch]);
    } catch { /* best-effort */ }
    containerManager.dispose();
    return {
      usedContainer: true,
      featureBranch,
      error: `Container spawn failed: ${msg}`,
    };
  }

  // 6. Handle container result
  if (containerResult.exitCode === 0) {
    // Container succeeded — invoke promoteStep to merge feature branch
    logger.log("info", `[container-build] Container succeeded, running promoteStep`);
    let promoteResult: PromoteStepResult;
    try {
      promoteResult = await promoteStep({
        repoPath,
        featureBranch,
        targetBranch,
        testCommand,
      });
      logger.log("info", `[container-build] promoteStep result: ${promoteResult.status} — ${promoteResult.message}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.log("error", `[container-build] promoteStep failed: ${msg}`);
      containerManager.dispose();
      return {
        usedContainer: true,
        containerResult,
        featureBranch,
        error: `promoteStep failed: ${msg}`,
      };
    }

    containerManager.dispose();
    return {
      usedContainer: true,
      containerResult,
      promoteResult,
      featureBranch,
    };
  }

  // Container failed
  const failMsg = containerResult.timedOut
    ? `Container timed out after ${containerTimeoutMs / 1000}s`
    : `Container exited with code ${containerResult.exitCode}`;

  logger.log("warn", `[container-build] ${failMsg}. Logs: ${containerResult.logFile}`);

  // Don't delete feature branch on failure — preserve for debugging
  // Switch back to target branch so repo is in a clean state
  try {
    gitSync(repoPath, ["checkout", targetBranch]);
  } catch { /* best-effort */ }

  containerManager.dispose();
  return {
    usedContainer: true,
    containerResult,
    featureBranch,
    error: `${failMsg}. Logs available at: ${containerResult.logFile}`,
  };
}
