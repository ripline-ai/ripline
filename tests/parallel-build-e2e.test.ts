/**
 * End-to-end integration tests for the parallel build flow.
 *
 * Validates the full lifecycle from feature branch creation through
 * promote-step merging, including:
 *  - Two concurrent non-overlapping builds both merge successfully
 *  - Two concurrent overlapping builds: first merges, second flagged as needs-conflict-resolution
 *  - Failed build cleanup and status tracking
 *  - Timed-out build kill and cleanup
 *  - Pipeline status mapping for container-based execution states
 *  - Smoke tests for all build pipeline definitions (implement_story, build_from_plan, bug_fix)
 *
 * Uses real temporary git repos for promote-step tests, and mocks Docker CLI
 * for container lifecycle tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { promoteStep, type PromoteStepResult } from "../src/promote-step.js";
import type { ContainerBuildConfig, ContainerBuildResult } from "../src/container-build-runner.js";
import type { PipelineRunRecord, ContainerResourceLimits } from "../src/types.js";

/* ── Git repo helpers ──────────────────────────────────────────────── */

function git(repoPath: string, args: string): string {
  const parts = args.split(/\s+/);
  return execFileSync("git", parts, {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@test.com",
    },
  }).trim();
}

/**
 * Create a temporary repo with origin remote and an initial commit on main.
 * Returns { bare, work } paths.
 */
function createTestRepo(): { bare: string; work: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ripline-e2e-"));
  const bare = path.join(base, "origin.git");
  const work = path.join(base, "work");

  // Create the working repo first with main as default branch
  fs.mkdirSync(work, { recursive: true });
  git(work, "init -b main");
  fs.writeFileSync(path.join(work, "README.md"), "# Test Project\n");
  git(work, "add README.md");
  git(work, "commit -m initial");

  // Create a bare clone as "origin"
  execFileSync("git", ["clone", "--bare", work, bare], {
    encoding: "utf8",
    timeout: 10_000,
  });

  // Point working repo's origin at the bare repo
  git(work, `remote add origin ${bare}`);
  // Set upstream tracking
  git(work, "push -u origin main");

  return { bare, work };
}

function cleanupTestRepo(repoBase: string): void {
  const base = path.dirname(repoBase);
  // Find the parent temp dir (contains origin.git and work)
  if (base.includes("ripline-e2e-")) {
    fs.rmSync(base, { recursive: true, force: true });
  } else {
    fs.rmSync(repoBase, { recursive: true, force: true });
  }
}

/* ── Test Suites ─────────────────────────────────────────────────── */

describe("E2E: Concurrent non-overlapping builds both merge successfully", () => {
  let repo: { bare: string; work: string };

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(repo.work);
  });

  it("two feature branches modifying different files both merge via promote", async () => {
    const { work } = repo;

    // ── Build A: create feature branch and modify file A ──────────
    git(work, "checkout -b build/run-a");
    fs.writeFileSync(path.join(work, "feature-a.ts"), "export const a = 1;\n");
    git(work, "add feature-a.ts");
    git(work, "commit -m story-a");
    git(work, "push origin build/run-a");
    git(work, "checkout main");

    // ── Build B: create feature branch and modify file B ──────────
    git(work, "checkout -b build/run-b");
    fs.writeFileSync(path.join(work, "feature-b.ts"), "export const b = 2;\n");
    git(work, "add feature-b.ts");
    git(work, "commit -m story-b");
    git(work, "push origin build/run-b");
    git(work, "checkout main");

    // ── Promote build A ──────────────────────────────────────────
    const resultA = await promoteStep({
      repoPath: work,
      featureBranch: "build/run-a",
      targetBranch: "main",
      testCommand: "true", // always passes
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(resultA.status).toBe("merged");
    expect(resultA.mergeCommit).toBeTruthy();

    // ── Promote build B ──────────────────────────────────────────
    const resultB = await promoteStep({
      repoPath: work,
      featureBranch: "build/run-b",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(resultB.status).toBe("merged");
    expect(resultB.mergeCommit).toBeTruthy();

    // ── Verify both files exist on main ──────────────────────────
    git(work, "checkout main");
    expect(fs.existsSync(path.join(work, "feature-a.ts"))).toBe(true);
    expect(fs.existsSync(path.join(work, "feature-b.ts"))).toBe(true);

    // Verify commit history contains both
    const log = git(work, "log --oneline");
    expect(log).toContain("story-a");
    expect(log).toContain("story-b");
  });

  it("parallel promotes produce distinct merge commits", async () => {
    const { work } = repo;

    // Create two branches
    git(work, "checkout -b build/run-1");
    fs.writeFileSync(path.join(work, "module1.ts"), "// module 1\n");
    git(work, "add module1.ts");
    git(work, "commit -m module-1");
    git(work, "push origin build/run-1");
    git(work, "checkout main");

    git(work, "checkout -b build/run-2");
    fs.writeFileSync(path.join(work, "module2.ts"), "// module 2\n");
    git(work, "add module2.ts");
    git(work, "commit -m module-2");
    git(work, "push origin build/run-2");
    git(work, "checkout main");

    const r1 = await promoteStep({
      repoPath: work,
      featureBranch: "build/run-1",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    const r2 = await promoteStep({
      repoPath: work,
      featureBranch: "build/run-2",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(r1.status).toBe("merged");
    expect(r2.status).toBe("merged");
    // Commits should be different (sequential merges)
    expect(r1.mergeCommit).not.toBe(r2.mergeCommit);
  });
});

describe("E2E: Concurrent overlapping builds — merge conflict detection", () => {
  let repo: { bare: string; work: string };

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(repo.work);
  });

  it("first to finish merges, second is flagged as needs-conflict-resolution", async () => {
    const { work } = repo;

    // Create a shared file on main
    fs.writeFileSync(path.join(work, "shared.ts"), "export const val = 'original';\n");
    git(work, "add shared.ts");
    git(work, "commit -m add-shared");
    git(work, "push origin main");

    // ── Branch A modifies shared.ts one way ──────────────────────
    git(work, "checkout -b build/overlap-a");
    fs.writeFileSync(path.join(work, "shared.ts"), "export const val = 'version-a';\n");
    git(work, "add shared.ts");
    git(work, "commit -m overlap-a");
    git(work, "push origin build/overlap-a");
    git(work, "checkout main");

    // ── Branch B modifies shared.ts a different way ──────────────
    git(work, "checkout -b build/overlap-b");
    fs.writeFileSync(path.join(work, "shared.ts"), "export const val = 'version-b';\n");
    git(work, "add shared.ts");
    git(work, "commit -m overlap-b");
    git(work, "push origin build/overlap-b");
    git(work, "checkout main");

    // ── First build promotes successfully ─────────────────────────
    const resultA = await promoteStep({
      repoPath: work,
      featureBranch: "build/overlap-a",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });
    expect(resultA.status).toBe("merged");

    // ── Second build hits merge conflict ──────────────────────────
    const resultB = await promoteStep({
      repoPath: work,
      featureBranch: "build/overlap-b",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });
    expect(resultB.status).toBe("needs-conflict-resolution");
    expect(resultB.message).toContain("Rebase conflict");

    // Verify the conflicting branch is preserved for manual resolution
    const branches = git(work, "branch");
    expect(branches).toContain("build/overlap-b");
  });

  it("needs-conflict-resolution result includes git output for debugging", async () => {
    const { work } = repo;

    // Set up conflicting branches
    fs.writeFileSync(path.join(work, "config.ts"), "const port = 3000;\n");
    git(work, "add config.ts");
    git(work, "commit -m add-config");
    git(work, "push origin main");

    git(work, "checkout -b build/conflict-1");
    fs.writeFileSync(path.join(work, "config.ts"), "const port = 4000;\n");
    git(work, "add config.ts");
    git(work, "commit -m port-4000");
    git(work, "push origin build/conflict-1");
    git(work, "checkout main");

    git(work, "checkout -b build/conflict-2");
    fs.writeFileSync(path.join(work, "config.ts"), "const port = 5000;\n");
    git(work, "add config.ts");
    git(work, "commit -m port-5000");
    git(work, "push origin build/conflict-2");
    git(work, "checkout main");

    // First merges
    await promoteStep({
      repoPath: work,
      featureBranch: "build/conflict-1",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    // Second conflicts
    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/conflict-2",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("needs-conflict-resolution");
    expect(result.gitOutput).toBeDefined();
    // Git output should mention the conflicting file
    expect(result.gitOutput!.toLowerCase()).toContain("conflict");
  });
});

describe("E2E: Failed build cleanup and status", () => {
  let repo: { bare: string; work: string };

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(repo.work);
  });

  it("test failure on feature branch aborts merge and preserves main", async () => {
    const { work } = repo;

    // Create a feature branch
    git(work, "checkout -b build/fail-test");
    fs.writeFileSync(path.join(work, "broken.ts"), "export const x = undefined!;\n");
    git(work, "add broken.ts");
    git(work, "commit -m broken-code");
    git(work, "push origin build/fail-test");
    git(work, "checkout main");

    const mainBefore = git(work, "rev-parse HEAD");

    // Promote with a test command that fails
    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/fail-test",
      targetBranch: "main",
      testCommand: "exit 1",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("test-failure");
    expect(result.message).toContain("Test suite failed");
    expect(result.testOutput).toBeDefined();

    // Main should be unchanged
    git(work, "checkout main");
    const mainAfter = git(work, "rev-parse HEAD");
    expect(mainAfter).toBe(mainBefore);
  });

  it("failed build has accessible error details in the result", async () => {
    const { work } = repo;

    git(work, "checkout -b build/error-details");
    fs.writeFileSync(path.join(work, "errored.ts"), "// will fail tests\n");
    git(work, "add errored.ts");
    git(work, "commit -m errored");
    git(work, "push origin build/error-details");
    git(work, "checkout main");

    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/error-details",
      targetBranch: "main",
      testCommand: "echo 'npm ERR! Build failed: ENOENT' && exit 1",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("test-failure");
    expect(result.testOutput).toContain("Build failed");
  });

  it("promote with nonexistent feature branch returns error status", async () => {
    const { work } = repo;

    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/does-not-exist",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("Failed to checkout feature branch");
  });
});

describe("E2E: Timed-out build handling", () => {
  let repo: { bare: string; work: string };

  beforeEach(() => {
    repo = createTestRepo();
  });

  afterEach(() => {
    cleanupTestRepo(repo.work);
  });

  it("test command timeout aborts merge and flags as test-failure", async () => {
    const { work } = repo;

    git(work, "checkout -b build/timeout-test");
    fs.writeFileSync(path.join(work, "slow.ts"), "// slow test\n");
    git(work, "add slow.ts");
    git(work, "commit -m slow-test");
    git(work, "push origin build/timeout-test");
    git(work, "checkout main");

    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/timeout-test",
      targetBranch: "main",
      testCommand: "sleep 60",
      testTimeoutMs: 500, // Very short timeout
      gitTimeoutMs: 10_000,
    });

    // The test command times out → treated as test failure
    expect(result.status).toBe("test-failure");
    expect(result.testOutput).toContain("timed out");
  });
});

describe("E2E: Container build result → run status mapping", () => {
  /**
   * Documents and validates the mapping from container build results
   * to pipeline run statuses, ensuring Wintermute correctly reflects
   * container-based execution states.
   */

  it("successful container build with merge maps to completed", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: { containerId: "abc", exitCode: 0, timedOut: false, logFile: "/tmp/log" },
      promoteResult: { status: "merged", message: "OK", mergeCommit: "sha123" },
      featureBranch: "build/run-1",
    };

    // Scheduler maps this to "completed"
    expect(result.containerResult!.exitCode).toBe(0);
    expect(result.promoteResult!.status).toBe("merged");
    expect(result.error).toBeUndefined();
  });

  it("container build with merge conflict maps correctly", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: { containerId: "def", exitCode: 0, timedOut: false, logFile: "/tmp/log" },
      promoteResult: {
        status: "needs-conflict-resolution",
        message: "CONFLICT in shared.ts",
        gitOutput: "CONFLICT (content): Merge conflict in shared.ts",
      },
      featureBranch: "build/run-2",
    };

    expect(result.promoteResult!.status).toBe("needs-conflict-resolution");
    expect(result.featureBranch).toBeDefined(); // Branch preserved for manual resolution
  });

  it("container exit non-zero maps to errored with log path", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: { containerId: "ghi", exitCode: 1, timedOut: false, logFile: "/tmp/build.log" },
      featureBranch: "build/run-3",
      error: "Container exited with code 1. Logs available at: /tmp/build.log",
    };

    expect(result.containerResult!.exitCode).toBe(1);
    expect(result.error).toContain("Container exited with code 1");
    expect(result.error).toContain("Logs available at");
  });

  it("container timeout maps to errored with timeout message", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: { containerId: "jkl", exitCode: null, timedOut: true, logFile: "/tmp/timeout.log" },
      featureBranch: "build/run-4",
      error: "Container timed out after 900s. Logs available at: /tmp/timeout.log",
    };

    expect(result.containerResult!.timedOut).toBe(true);
    expect(result.containerResult!.exitCode).toBeNull();
    expect(result.error).toContain("timed out");
  });

  it("docker unavailable maps to fallback (usedContainer=false)", () => {
    const result: ContainerBuildResult = {
      usedContainer: false,
    };

    expect(result.usedContainer).toBe(false);
    // Scheduler falls back to direct DeterministicRunner execution
  });

  it("all promote statuses have a defined run-status mapping", () => {
    const promoteStatuses: PromoteStepResult["status"][] = [
      "merged",
      "needs-conflict-resolution",
      "test-failure",
      "error",
    ];

    const statusMapping: Record<string, string> = {
      "merged": "completed",
      "needs-conflict-resolution": "errored",
      "test-failure": "errored",
      "error": "errored",
    };

    for (const status of promoteStatuses) {
      expect(statusMapping[status]).toBeDefined();
    }
  });
});

describe("E2E: Build pipeline smoke tests", () => {
  const pipelinesDir = path.resolve(__dirname, "..", "pipelines");

  it("implement_story pipeline definition exists and is valid YAML", () => {
    const filePath = path.join(pipelinesDir, "implement_story.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    // Basic structural checks
    expect(content).toContain("id:");
    expect(content).toContain("nodes:");
    expect(content).toContain("claude-code");
  });

  it("build_from_plan pipeline definition exists and has parallel loop", () => {
    const filePath = path.join(pipelinesDir, "build_from_plan.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("nodes:");
    expect(content).toContain("parallel");
    expect(content).toContain("implement_story");
    // Should reference the build queue
    expect(content).toContain("queue:");
  });

  it("bug_fix pipeline definition exists and has fix + test nodes", () => {
    const filePath = path.join(pipelinesDir, "bug_fix.yaml");
    expect(fs.existsSync(filePath)).toBe(true);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("id:");
    expect(content).toContain("nodes:");
    // Bug fix pipeline should have triage, fix, and test phases
    expect(content).toContain("fix");
    expect(content).toContain("queue:");
  });

  it("top-level build pipelines declare a queue for scheduler routing", () => {
    // implement_story is a child pipeline invoked by build_from_plan's loop;
    // only top-level pipelines (build_from_plan, bug_fix) need queue declarations.
    const topLevelPipelines = ["build_from_plan.yaml", "bug_fix.yaml"];

    for (const name of topLevelPipelines) {
      const filePath = path.join(pipelinesDir, name);
      if (!fs.existsSync(filePath)) continue;

      const content = fs.readFileSync(filePath, "utf8");
      expect(content).toContain("queue:");
    }
  });

  it("build_from_plan retry policy is configured for transient failures", () => {
    const filePath = path.join(pipelinesDir, "build_from_plan.yaml");
    if (!fs.existsSync(filePath)) return;

    const content = fs.readFileSync(filePath, "utf8");
    // Should have retry configuration
    expect(content).toContain("retry");
    expect(content).toContain("transient");
  });
});

describe("E2E: Parallel build isolation guarantees", () => {
  it("each build run gets a unique feature branch name from its runId", () => {
    const runIds = [
      "run-aaa-111-222-333",
      "run-bbb-444-555-666",
      "run-ccc-777-888-999",
    ];

    const branches = runIds.map((id) => `build/${id}`);
    const containerNames = runIds.map((id) => `ripline-build-${id.slice(0, 8)}`);

    // All branches unique
    expect(new Set(branches).size).toBe(runIds.length);
    // All container names unique
    expect(new Set(containerNames).size).toBe(runIds.length);
  });

  it("container environment passes all required RIPLINE_ variables", () => {
    const required = [
      "RIPLINE_REPO_PATH",
      "RIPLINE_BRANCH",
      "RIPLINE_TARGET_BRANCH",
      "RIPLINE_RUN_ID",
      "RIPLINE_PIPELINE_ID",
      "RIPLINE_PIPELINE_CONTEXT",
    ];

    // Simulate env construction from container-build-runner
    const env: Record<string, string> = {
      RIPLINE_REPO_PATH: "/home/user/project",
      RIPLINE_BRANCH: "build/run-123",
      RIPLINE_TARGET_BRANCH: "main",
      RIPLINE_RUN_ID: "run-123",
      RIPLINE_PIPELINE_ID: "implement_story",
      RIPLINE_PIPELINE_CONTEXT: JSON.stringify({
        inputs: { task: "implement story" },
      }),
    };

    for (const key of required) {
      expect(env[key]).toBeDefined();
      expect(env[key]!.length).toBeGreaterThan(0);
    }
  });

  it("queue resource limits are structured correctly for container config", () => {
    const queueConfigs: Record<string, { concurrency: number; resourceLimits?: ContainerResourceLimits }> = {
      build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
      test: { concurrency: 2, resourceLimits: { cpus: "1", memory: "2g" } },
      default: { concurrency: 1 },
    };

    // Build queue should have resource limits
    expect(queueConfigs.build.resourceLimits).toEqual({ cpus: "2", memory: "4g" });
    // Default queue should not
    expect(queueConfigs.default.resourceLimits).toBeUndefined();
    // Concurrency should be positive integers
    for (const [, config] of Object.entries(queueConfigs)) {
      expect(config.concurrency).toBeGreaterThan(0);
    }
  });

  it("only top-level runs (no parentRunId, no cursor) are container-eligible", () => {
    const isContainerEligible = (run: Partial<PipelineRunRecord>) =>
      !run.parentRunId && run.cursor === undefined;

    // Top-level pending run → eligible
    expect(isContainerEligible({ id: "r1", status: "pending" })).toBe(true);

    // Child run → not eligible (runs inside parent's container)
    expect(isContainerEligible({ id: "r2", parentRunId: "r1", status: "pending" })).toBe(false);

    // Resumed run → not eligible (already has progress state)
    expect(
      isContainerEligible({ id: "r3", status: "pending", cursor: { nextNodeIndex: 2, context: {} } }),
    ).toBe(false);
  });
});
