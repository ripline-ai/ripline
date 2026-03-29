import { spawn } from "node:child_process";

/**
 * promoteStep — post-build merge workflow for feature branches.
 *
 * 1. Fetch latest from remote
 * 2. Checkout the feature branch and run the project's test suite
 * 3. Abort if tests fail (before any merge is attempted)
 * 4. Checkout the target branch (up-to-date)
 * 5. Attempt fast-forward merge of the feature branch
 * 6. Fall back to rebase if FF not possible
 * 7. Detect and flag merge conflicts (status 'merge-conflict', branch preserved)
 * 8. Clean up the feature branch after successful merge
 */

export type PromoteStepParams = {
  /** Absolute path to the git repository on the host. */
  repoPath: string;
  /** Name of the feature branch to merge (e.g. "feature/my-change"). */
  featureBranch: string;
  /** Name of the target branch to merge into (e.g. "main"). */
  targetBranch: string;
  /** Shell command to run the project test suite (e.g. "npm test"). */
  testCommand: string;
  /** Timeout in milliseconds for the test command. Default 300_000 (5 min). */
  testTimeoutMs?: number;
  /** Timeout in milliseconds for individual git operations. Default 60_000 (1 min). */
  gitTimeoutMs?: number;
  /** Remote name. Default "origin". */
  remote?: string;
};

export type PromoteStepResult = {
  status: "merged" | "merge-conflict" | "test-failure" | "error";
  /** Human-readable summary of what happened. */
  message: string;
  /** The merge commit SHA (only set on success). */
  mergeCommit?: string;
  /** Truncated output from the test run (only set on test failure). */
  testOutput?: string;
  /** Truncated output from the failed git operation (only set on conflict/error). */
  gitOutput?: string;
};

/**
 * Execute the promote (merge) step for a pipeline run.
 *
 * Flow: pull feature branch → run tests → merge into target.
 * On merge conflict the feature branch is left intact so the user can resolve manually.
 * On success the feature branch is deleted locally.
 */
export async function promoteStep(params: PromoteStepParams): Promise<PromoteStepResult> {
  const {
    repoPath,
    featureBranch,
    targetBranch,
    testCommand,
    testTimeoutMs = 300_000,
    gitTimeoutMs = 60_000,
    remote = "origin",
  } = params;

  const git = (args: string, timeout = gitTimeoutMs) =>
    runCommand(`git ${args}`, repoPath, timeout);

  try {
    // ── 1. Fetch latest refs from remote ──────────────────────────────
    await git(`fetch ${remote}`);

    // ── 2. Checkout feature branch ────────────────────────────────────
    const featureCheckout = await git(`checkout ${featureBranch}`);
    if (featureCheckout.exitCode !== 0) {
      return {
        status: "error",
        message: `Failed to checkout feature branch '${featureBranch}'`,
        gitOutput: featureCheckout.output.slice(-2000),
      };
    }

    // ── 3. Run project test suite on the feature branch ───────────────
    //    Tests must pass BEFORE we attempt any merge.
    const testResult = await runCommand(testCommand, repoPath, testTimeoutMs);

    if (testResult.exitCode !== 0) {
      // Switch back to target so repo is in a clean state
      await git(`checkout ${targetBranch}`);
      return {
        status: "test-failure",
        message: `Test suite failed on '${featureBranch}'. Merge aborted.`,
        testOutput: testResult.output.slice(-4000),
      };
    }

    // ── 4. Checkout target branch and ensure it's up to date ──────────
    const targetCheckout = await git(`checkout ${targetBranch}`);
    if (targetCheckout.exitCode !== 0) {
      return {
        status: "error",
        message: `Failed to checkout target branch '${targetBranch}'`,
        gitOutput: targetCheckout.output.slice(-2000),
      };
    }

    await git(`pull ${remote} ${targetBranch}`);

    // ── 5. Attempt fast-forward merge ─────────────────────────────────
    const ffResult = await git(`merge --ff-only ${featureBranch}`);

    if (ffResult.exitCode !== 0) {
      // ── 6. FF not possible — try rebase of feature onto target, then FF merge
      const rebaseResult = await rebaseAndMerge(
        repoPath,
        featureBranch,
        targetBranch,
        gitTimeoutMs,
      );

      if (rebaseResult.conflict) {
        // ── 7. Merge conflict — flag and preserve branch ──────────────
        return {
          status: "merge-conflict",
          message: `Merge conflict detected when merging '${featureBranch}' into '${targetBranch}'. Branch preserved for manual resolution.`,
          gitOutput: rebaseResult.output.slice(-2000),
        };
      }

      if (!rebaseResult.success) {
        return {
          status: "error",
          message: `Failed to merge '${featureBranch}' into '${targetBranch}'`,
          gitOutput: rebaseResult.output.slice(-2000),
        };
      }
    }

    // ── 8. Get the merge/HEAD commit SHA ──────────────────────────────
    const headResult = await git("rev-parse HEAD");
    const mergeCommit = headResult.output.trim();

    // ── 9. Clean up — delete the feature branch locally ───────────────
    await git(`branch -d ${featureBranch}`);

    return {
      status: "merged",
      message: `Successfully merged '${featureBranch}' into '${targetBranch}'`,
      mergeCommit,
    };
  } catch (err) {
    return {
      status: "error",
      message: `Unexpected error during promote step: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type RebaseAndMergeResult = {
  success: boolean;
  conflict: boolean;
  output: string;
};

/**
 * Attempt to rebase the feature branch onto the target, then fast-forward merge.
 * If conflicts are detected during rebase, abort and report.
 */
async function rebaseAndMerge(
  repoPath: string,
  featureBranch: string,
  targetBranch: string,
  timeoutMs: number,
): Promise<RebaseAndMergeResult> {
  const git = (args: string) => runCommand(`git ${args}`, repoPath, timeoutMs);

  // Ensure we're on target branch (may have been dirtied by failed ff merge attempt)
  await git(`checkout ${targetBranch}`);
  await git(`reset --hard HEAD`);

  // Checkout feature branch for rebasing
  const checkoutResult = await git(`checkout ${featureBranch}`);
  if (checkoutResult.exitCode !== 0) {
    return { success: false, conflict: false, output: checkoutResult.output };
  }

  // Attempt rebase onto target
  const rebaseResult = await git(`rebase ${targetBranch}`);

  if (rebaseResult.exitCode !== 0) {
    const output = rebaseResult.output.toLowerCase();
    const isConflict =
      output.includes("conflict") ||
      output.includes("could not apply") ||
      output.includes("merge conflict");

    // Abort the in-progress rebase
    await git("rebase --abort");

    // Return to target branch — leave feature branch intact for manual resolution
    await git(`checkout ${targetBranch}`);

    return { success: false, conflict: isConflict, output: rebaseResult.output };
  }

  // Rebase succeeded — switch to target and fast-forward merge
  await git(`checkout ${targetBranch}`);
  const mergeResult = await git(`merge --ff-only ${featureBranch}`);

  if (mergeResult.exitCode !== 0) {
    return { success: false, conflict: false, output: mergeResult.output };
  }

  return { success: true, conflict: false, output: mergeResult.output };
}

/**
 * Run a shell command in the given cwd. Returns exit code + combined stdout/stderr.
 * Never throws on non-zero exit — caller decides what to do.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      resolve({ exitCode: 124, output: chunks.join("") + `\n[timed out after ${timeoutMs / 1000}s]` });
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: chunks.join("") });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
