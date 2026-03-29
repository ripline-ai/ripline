import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";

export type PromoteStepParams = {
  repoPath: string;
  featureBranch: string;
  targetBranch: string;
  testCommand: string;
  testTimeoutMs?: number;
  gitTimeoutMs?: number;
  remote?: string;
};

export type ConflictedFile = { path: string; content: string };

export type PromoteStepResult = {
  status: "merged" | "needs-conflict-resolution" | "test-failure" | "error";
  message: string;
  mergeCommit?: string;
  testOutput?: string;
  gitOutput?: string;
  conflictedFiles?: ConflictedFile[];
};

export async function promoteStep(params: PromoteStepParams): Promise<PromoteStepResult> {
  const { repoPath, featureBranch, targetBranch, testCommand, testTimeoutMs = 300_000, gitTimeoutMs = 60_000, remote = "origin" } = params;
  const git = (args: string, timeout = gitTimeoutMs) => runCommand(`git ${args}`, repoPath, timeout);
  try {
    await git(`fetch ${remote}`);
    const featureCheckout = await git(`checkout ${featureBranch}`);
    if (featureCheckout.exitCode !== 0) return { status: "error", message: `Failed to checkout feature branch '${featureBranch}'`, gitOutput: featureCheckout.output.slice(-2000) };
    const testResult = await runCommand(testCommand, repoPath, testTimeoutMs);
    if (testResult.exitCode !== 0) { await git(`checkout ${targetBranch}`); return { status: "test-failure", message: `Test suite failed on '${featureBranch}'. Merge aborted.`, testOutput: testResult.output.slice(-4000) }; }
    const targetCheckout = await git(`checkout ${targetBranch}`);
    if (targetCheckout.exitCode !== 0) return { status: "error", message: `Failed to checkout target branch '${targetBranch}'`, gitOutput: targetCheckout.output.slice(-2000) };
    await git(`pull ${remote} ${targetBranch}`);
    const ffResult = await git(`merge --ff-only ${featureBranch}`);
    if (ffResult.exitCode !== 0) {
      const rebaseResult = await rebaseAndMerge(repoPath, featureBranch, targetBranch, gitTimeoutMs);
      if (rebaseResult.conflict) {
        const ret: PromoteStepResult = { status: "needs-conflict-resolution", message: `Rebase conflict detected when merging '${featureBranch}' into '${targetBranch}'. Rebase left in-progress for automated resolution.`, gitOutput: rebaseResult.output.slice(-2000) };
        if (rebaseResult.conflictedFiles !== undefined) ret.conflictedFiles = rebaseResult.conflictedFiles;
        return ret;
      }
      if (!rebaseResult.success) return { status: "error", message: `Failed to merge '${featureBranch}' into '${targetBranch}'`, gitOutput: rebaseResult.output.slice(-2000) };
    }
    const headResult = await git("rev-parse HEAD");
    const mergeCommit = headResult.output.trim();
    await git(`branch -d ${featureBranch}`);
    return { status: "merged", message: `Successfully merged '${featureBranch}' into '${targetBranch}'`, mergeCommit };
  } catch (err) {
    return { status: "error", message: `Unexpected error during promote step: ${err instanceof Error ? err.message : String(err)}` };
  }
}

type RebaseAndMergeResult = { success: boolean; conflict: boolean; output: string; conflictedFiles?: ConflictedFile[] };

async function rebaseAndMerge(repoPath: string, featureBranch: string, targetBranch: string, timeoutMs: number): Promise<RebaseAndMergeResult> {
  const git = (args: string) => runCommand(`git ${args}`, repoPath, timeoutMs);
  await git(`checkout ${targetBranch}`);
  await git(`reset --hard HEAD`);
  const checkoutResult = await git(`checkout ${featureBranch}`);
  if (checkoutResult.exitCode !== 0) return { success: false, conflict: false, output: checkoutResult.output };
  const rebaseResult = await git(`rebase ${targetBranch}`);
  if (rebaseResult.exitCode !== 0) {
    const output = rebaseResult.output.toLowerCase();
    const isConflict = output.includes("conflict") || output.includes("could not apply") || output.includes("merge conflict");
    if (isConflict) {
      // First attempt: abort the failed plain rebase, then retry with -X theirs (prefer feature branch on conflict)
      console.log(`[promote-step] Rebase conflict on '${featureBranch}' — retrying with -X theirs (auto-resolution)`);
      await git("rebase --abort");
      await git(`checkout ${featureBranch}`);
      const xTheirsResult = await git(`rebase -X theirs ${targetBranch}`);
      if (xTheirsResult.exitCode === 0) {
        // Auto-resolution succeeded — fall through to FF merge below
        console.log(`[promote-step] Auto-resolution succeeded for '${featureBranch}' using -X theirs`);
      } else {
        // -X theirs also failed — collect conflicted files and leave rebase in-progress for manual resolution
        console.log(`[promote-step] Auto-resolution failed for '${featureBranch}' — leaving rebase in-progress for manual review`);
        const conflictListResult = await git("diff --name-only --diff-filter=U");
        const conflictedPaths = conflictListResult.output.split("\n").map((p: string) => p.trim()).filter(Boolean);
        const conflictedFiles: ConflictedFile[] = [];
        for (const filePath of conflictedPaths) {
          try { conflictedFiles.push({ path: filePath, content: readFileSync(join(repoPath, filePath), "utf-8") }); }
          catch { conflictedFiles.push({ path: filePath, content: "" }); }
        }
        return { success: false, conflict: true, output: xTheirsResult.output, conflictedFiles };
      }
    } else {
      await git("rebase --abort");
      await git(`checkout ${targetBranch}`);
      return { success: false, conflict: false, output: rebaseResult.output };
    }
  }
  await git(`checkout ${targetBranch}`);
  const mergeResult = await git(`merge --ff-only ${featureBranch}`);
  if (mergeResult.exitCode !== 0) return { success: false, conflict: false, output: mergeResult.output };
  return { success: true, conflict: false, output: mergeResult.output };
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const proc = spawn("sh", ["-c", command], { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));
    const timer = setTimeout(() => { proc.kill("SIGTERM"); resolve({ exitCode: 124, output: chunks.join("") + `\n[timed out after ${timeoutMs / 1000}s]` }); }, timeoutMs);
    proc.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, output: chunks.join("") }); });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}
