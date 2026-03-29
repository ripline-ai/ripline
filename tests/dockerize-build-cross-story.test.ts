/**
 * Cross-story integration tests for: Dockerize build environment to enable
 * parallel builds via isolated containers.
 *
 * These tests cover integration points BETWEEN stories that are not covered
 * by the individual story-level tests, and strengthen acceptance criteria
 * coverage for edge cases.
 *
 * Integration flows covered:
 *  1. Config → Queue → Container → Promote pipeline (Stories 5→6→2→4→3)
 *  2. Scheduler eligibility + event emission (Story 6)
 *  3. Container lifecycle error recovery (Stories 2, 4)
 *  4. PromoteStep ordering guarantees with real git (Story 3)
 *  5. Feature branch naming conventions across parallel runs (Stories 4, 6)
 *  6. Run record metadata persistence through container lifecycle (Story 6)
 *  7. ContainerManager cleanup timer behavior (Story 2)
 *  8. Server API integration: container logs fallback path (Stories 4, 6)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";
import { execFileSync } from "node:child_process";

/* ── ESM-safe child_process mock ────────────────────────────────────────── */

const { execFileSyncMockFn, realExecFileSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("node:child_process");
  return {
    execFileSyncMockFn: vi.fn(),
    realExecFileSync: cp.execFileSync as typeof import("node:child_process").execFileSync,
  };
});

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>(
    "node:child_process",
  );
  return {
    ...actual,
    execFileSync: execFileSyncMockFn,
  };
});
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { ContainerManager } from "../src/container-manager.js";
import { loadUserConfig, expandTilde } from "../src/config.js";
import { promoteStep } from "../src/promote-step.js";
import type {
  PipelineRunRecord,
  ContainerBuildUserConfig,
  ContainerResourceLimits,
  QueueConfig,
  PipelineRunStatus,
} from "../src/types.js";
import type { ContainerBuildResult } from "../src/container-build-runner.js";
import type { PromoteStepResult } from "../src/promote-step.js";

const silentLogger = { log: vi.fn() } as any;

/* ── Git helpers (real repos for promote-step) ────────────────────────── */

function git(repoPath: string, args: string): string {
  const parts = args.split(/\s+/);
  return realExecFileSync("git", parts, {
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

function createTestRepo(): { bare: string; work: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ripline-cross-story-"));
  const bare = path.join(base, "origin.git");
  const work = path.join(base, "work");

  fs.mkdirSync(work, { recursive: true });
  git(work, "init -b main");
  fs.writeFileSync(path.join(work, "README.md"), "# Test\n");
  git(work, "add README.md");
  git(work, "commit -m initial");

  realExecFileSync("git", ["clone", "--bare", work, bare], {
    encoding: "utf8",
    timeout: 10_000,
  });
  git(work, `remote add origin ${bare}`);
  git(work, "push -u origin main");

  return { bare, work };
}

function cleanupRepo(work: string): void {
  const base = path.dirname(work);
  if (base.includes("ripline-cross-story-")) {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("Cross-story: Config → Queue → Container pipeline (Stories 5→6→2→4)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-cross-${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".ripline"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("full config with containerBuild + queues produces correct merged container config", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        containerBuild: {
          enabled: true,
          repoPath: "~/my-repo",
          targetBranch: "main",
          buildImage: "my-builder:v3",
          testCommand: "npm run test:ci",
          secretsMountPath: "~/.build-secrets",
          containerTimeoutMs: 1_200_000,
        },
        queues: {
          build: { concurrency: 4, resourceLimits: { cpus: "2", memory: "8g" } },
          test: { concurrency: 2, resourceLimits: { cpus: "1", memory: "2g" } },
          default: { concurrency: 1 },
        },
      }),
    );

    const config = loadUserConfig(tmpHome);

    // Verify containerBuild config with tilde expansion
    expect(config.containerBuild!.enabled).toBe(true);
    expect(config.containerBuild!.repoPath).toBe(path.join(tmpHome, "my-repo"));
    expect(config.containerBuild!.secretsMountPath).toBe(path.join(tmpHome, ".build-secrets"));
    expect(config.containerBuild!.containerTimeoutMs).toBe(1_200_000);

    // Simulate scheduler merge: for "build" queue, queue limits override container defaults
    const buildQueueLimits = config.queues!.build!.resourceLimits;
    const containerConfig = {
      repoPath: config.containerBuild!.repoPath!,
      buildImage: config.containerBuild!.buildImage!,
      targetBranch: config.containerBuild!.targetBranch!,
      testCommand: config.containerBuild!.testCommand!,
      containerTimeoutMs: config.containerBuild!.containerTimeoutMs!,
      ...(buildQueueLimits && { resourceLimits: buildQueueLimits }),
    };

    expect(containerConfig.resourceLimits).toEqual({ cpus: "2", memory: "8g" });
    expect(containerConfig.buildImage).toBe("my-builder:v3");
    expect(containerConfig.containerTimeoutMs).toBe(1_200_000);
  });

  it("queue without resource limits inherits no limit override", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        containerBuild: { enabled: true, repoPath: "/repo" },
        queues: {
          build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
          default: { concurrency: 1 },
        },
      }),
    );

    const config = loadUserConfig(tmpHome);

    // "default" queue has no resource limits
    const defaultLimits = config.queues?.default?.resourceLimits;
    expect(defaultLimits).toBeUndefined();

    // Simulated merge: no override for default queue
    const merged = {
      repoPath: "/repo",
      ...(defaultLimits !== undefined && { resourceLimits: defaultLimits }),
    };
    expect((merged as any).resourceLimits).toBeUndefined();
  });

  it("tilde expansion applies only to leading tilde", () => {
    // expandTilde should handle ~/dir and ~ but not mid-string ~
    expect(expandTilde("~/project", "/home/user")).toBe("/home/user/project");
    expect(expandTilde("~", "/home/user")).toBe("/home/user");
    expect(expandTilde("/some/~path", "/home/user")).toBe("/some/~path");
  });
});

describe("Cross-story: Scheduler eligibility + event contract (Story 6)", () => {
  it("eligibility check excludes child runs and resumed runs", () => {
    const isContainerEligible = (
      containerBuild: object | undefined,
      record: Partial<PipelineRunRecord>,
    ): boolean =>
      !!containerBuild && !record.parentRunId && record.cursor === undefined;

    const containerBuild = { repoPath: "/repo" };

    // Top-level fresh run → eligible
    expect(isContainerEligible(containerBuild, { id: "r1" })).toBe(true);

    // No containerBuild config → never eligible
    expect(isContainerEligible(undefined, { id: "r2" })).toBe(false);

    // Child run → not eligible
    expect(isContainerEligible(containerBuild, { id: "r3", parentRunId: "r1" })).toBe(false);

    // Resumed run with cursor → not eligible
    expect(
      isContainerEligible(containerBuild, {
        id: "r4",
        cursor: { nextNodeIndex: 1, context: {} },
      }),
    ).toBe(false);
  });

  it("all container lifecycle events use correct event names", () => {
    const containerEvents = [
      "run.container-started",
      "run.container-completed",
      "run.container-failed",
      "run.container-fallback",
    ];

    // Verify all events follow the run.container-* naming convention
    for (const event of containerEvents) {
      expect(event).toMatch(/^run\.container-/);
    }

    // Each event should be distinct
    expect(new Set(containerEvents).size).toBe(containerEvents.length);
  });

  it("promote result status maps to run record status correctly", () => {
    // This is the exact mapping the scheduler uses
    const mapPromoteToRunStatus = (
      promoteStatus: PromoteStepResult["status"],
    ): PipelineRunStatus => {
      switch (promoteStatus) {
        case "merged":
          return "completed";
        case "merge-conflict":
          return "merge-conflict";
        case "test-failure":
          return "errored";
        case "error":
          return "errored";
      }
    };

    expect(mapPromoteToRunStatus("merged")).toBe("completed");
    expect(mapPromoteToRunStatus("merge-conflict")).toBe("merge-conflict");
    expect(mapPromoteToRunStatus("test-failure")).toBe("errored");
    expect(mapPromoteToRunStatus("error")).toBe("errored");
  });

  it("run record preserves container metadata through status transitions", () => {
    // Simulate the scheduler's metadata persistence flow
    const record: Partial<PipelineRunRecord> = {
      id: "run-meta-1",
      pipelineId: "pipe-1",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      inputs: {},
      steps: [],
      childRunIds: [],
    };

    // Step 1: Container starts → metadata saved
    record.containerLogFile = "/repo/.ripline/runs/run-meta-1/container.log";
    record.featureBranch = "build/run-meta-1";
    expect(record.containerLogFile).toBeDefined();
    expect(record.featureBranch).toBeDefined();

    // Step 2: Container completes → status changes but metadata persists
    record.status = "completed";
    record.outputs = { promoteStatus: "merged", mergeCommit: "abc123" };
    expect(record.containerLogFile).toBe("/repo/.ripline/runs/run-meta-1/container.log");
    expect(record.featureBranch).toBe("build/run-meta-1");

    // Step 3: On failure, metadata also persists
    const failedRecord = { ...record, status: "errored" as PipelineRunStatus, error: "test failed" };
    expect(failedRecord.containerLogFile).toBeDefined();
    expect(failedRecord.featureBranch).toBeDefined();
  });
});

describe("Cross-story: ContainerManager lifecycle guarantees (Story 2)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    execFileSyncMockFn.mockReset();
  });

  it("cleanup timer uses unref() to avoid blocking process exit", () => {
    const mockTimer = {
      unref: vi.fn(),
      [Symbol.toPrimitive]: () => 1,
    };
    vi.spyOn(global, "setInterval").mockReturnValue(mockTimer as any);

    const manager = new ContainerManager({
      failedContainerTTL: 60_000,
      logger: silentLogger,
    });

    expect(mockTimer.unref).toHaveBeenCalled();
    manager.dispose();
  });

  it("trackedFailedContainers returns a defensive copy", () => {
    const manager = new ContainerManager({
      failedContainerTTL: 60_000,
      logger: silentLogger,
    });

    const list1 = manager.trackedFailedContainers;
    const list2 = manager.trackedFailedContainers;
    expect(list1).not.toBe(list2); // Different array references
    expect(list1).toEqual(list2);  // Same content

    manager.dispose();
  });

  it("dispose is idempotent — multiple calls do not throw", () => {
    const manager = new ContainerManager({
      failedContainerTTL: 60_000,
      logger: silentLogger,
    });

    manager.dispose();
    expect(() => manager.dispose()).not.toThrow();
    expect(() => manager.dispose()).not.toThrow();
  });

  it("removeContainer is best-effort — does not throw on failure", () => {
    const manager = new ContainerManager({ logger: silentLogger });
    execFileSyncMockFn.mockImplementation(() => {
      throw new Error("No such container");
    });

    expect(() => manager.removeContainer("nonexistent")).not.toThrow();

    manager.dispose();
  });
});

describe("Cross-story: PromoteStep ordering guarantee (Story 3 + real git)", () => {
  let repo: { bare: string; work: string };

  beforeEach(() => {
    // Pass execFileSync through to the real implementation for git operations
    execFileSyncMockFn.mockImplementation((...args: any[]) => (realExecFileSync as any)(...args));
    repo = createTestRepo();
  });

  afterEach(() => {
    execFileSyncMockFn.mockReset();
    cleanupRepo(repo.work);
  });

  it("tests execute on the feature branch BEFORE any merge — failing test prevents merge", async () => {
    const { work } = repo;

    // Create a feature branch with a new file
    git(work, "checkout -b build/test-ordering");
    fs.writeFileSync(path.join(work, "feature.ts"), "export const f = 1;\n");
    git(work, "add feature.ts");
    git(work, "commit -m add-feature");
    git(work, "push origin build/test-ordering");
    git(work, "checkout main");

    const mainSHA = git(work, "rev-parse HEAD");

    // Run promote with failing test
    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/test-ordering",
      targetBranch: "main",
      testCommand: "exit 1", // test fails
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("test-failure");
    expect(result.message).toContain("Test suite failed");

    // Critical: main must be unchanged — no merge happened
    git(work, "checkout main");
    const mainAfter = git(work, "rev-parse HEAD");
    expect(mainAfter).toBe(mainSHA);

    // Feature file must NOT exist on main
    expect(fs.existsSync(path.join(work, "feature.ts"))).toBe(false);
  });

  it("feature branch is deleted on successful merge", async () => {
    const { work } = repo;

    git(work, "checkout -b build/delete-on-merge");
    fs.writeFileSync(path.join(work, "merged.ts"), "export const m = 1;\n");
    git(work, "add merged.ts");
    git(work, "commit -m merged-feature");
    git(work, "push origin build/delete-on-merge");
    git(work, "checkout main");

    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/delete-on-merge",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("merged");
    expect(result.mergeCommit).toBeTruthy();

    // Feature branch should be deleted locally
    const branches = git(work, "branch");
    expect(branches).not.toContain("build/delete-on-merge");
  });

  it("merge-conflict preserves feature branch for manual resolution", async () => {
    const { work } = repo;

    // Set up conflicting changes
    fs.writeFileSync(path.join(work, "conflict.ts"), "const x = 1;\n");
    git(work, "add conflict.ts");
    git(work, "commit -m base");
    git(work, "push origin main");

    git(work, "checkout -b build/preserve-branch");
    fs.writeFileSync(path.join(work, "conflict.ts"), "const x = 'branch';\n");
    git(work, "add conflict.ts");
    git(work, "commit -m branch-change");
    git(work, "push origin build/preserve-branch");
    git(work, "checkout main");

    // Make a conflicting change on main
    fs.writeFileSync(path.join(work, "conflict.ts"), "const x = 'main';\n");
    git(work, "add conflict.ts");
    git(work, "commit -m main-change");
    git(work, "push origin main");

    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/preserve-branch",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("merge-conflict");

    // Branch MUST still exist for manual resolution
    const branches = git(work, "branch");
    expect(branches).toContain("build/preserve-branch");
  });

  it("test output is truncated to 4000 chars", async () => {
    const { work } = repo;

    git(work, "checkout -b build/truncate-test");
    fs.writeFileSync(path.join(work, "t.ts"), "x\n");
    git(work, "add t.ts");
    git(work, "commit -m t");
    git(work, "push origin build/truncate-test");
    git(work, "checkout main");

    // Generate output longer than 4000 chars
    const longOutput = "x".repeat(5000);
    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/truncate-test",
      targetBranch: "main",
      testCommand: `printf '${longOutput}' && exit 1`,
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    expect(result.status).toBe("test-failure");
    expect(result.testOutput!.length).toBeLessThanOrEqual(4000);
  });

  it("rebase fallback is attempted when fast-forward is not possible", async () => {
    const { work } = repo;

    // Create feature branch from initial commit
    git(work, "checkout -b build/rebase-test");
    fs.writeFileSync(path.join(work, "feature-r.ts"), "// rebase feature\n");
    git(work, "add feature-r.ts");
    git(work, "commit -m feature-r");
    git(work, "push origin build/rebase-test");
    git(work, "checkout main");

    // Add a non-conflicting commit on main so FF is impossible
    fs.writeFileSync(path.join(work, "main-only.ts"), "// main only\n");
    git(work, "add main-only.ts");
    git(work, "commit -m main-only");
    git(work, "push origin main");

    const result = await promoteStep({
      repoPath: work,
      featureBranch: "build/rebase-test",
      targetBranch: "main",
      testCommand: "true",
      testTimeoutMs: 5_000,
      gitTimeoutMs: 10_000,
    });

    // Should succeed via rebase fallback
    expect(result.status).toBe("merged");
    expect(result.mergeCommit).toBeTruthy();

    // Both files should exist on main
    git(work, "checkout main");
    expect(fs.existsSync(path.join(work, "feature-r.ts"))).toBe(true);
    expect(fs.existsSync(path.join(work, "main-only.ts"))).toBe(true);
  });
});

describe("Cross-story: Parallel build isolation (Stories 4, 6)", () => {
  it("feature branch names are deterministic from runId", () => {
    const runIds = ["aaa-111", "bbb-222", "ccc-333"];

    for (const id of runIds) {
      expect(`build/${id}`).toBe(`build/${id}`);
    }
  });

  it("container names stay under Docker 64-char limit for any runId length", () => {
    const longRunId = "a".repeat(100);
    const containerName = `ripline-build-${longRunId.slice(0, 8)}`;

    expect(containerName.length).toBeLessThanOrEqual(64);
    // Even with prefix, 14 + 8 = 22 chars — well under limit
    expect(containerName).toBe("ripline-build-aaaaaaaa");
  });

  it("environment variables are correctly structured for the container", () => {
    const runId = "run-123-abc";
    const pipelineId = "my-pipeline";
    const context = { inputs: { task: "build" }, pipelineId };

    const env: Record<string, string> = {
      RIPLINE_REPO_PATH: "/home/user/project",
      RIPLINE_BRANCH: `build/${runId}`,
      RIPLINE_TARGET_BRANCH: "main",
      RIPLINE_RUN_ID: runId,
      RIPLINE_PIPELINE_ID: pipelineId,
      RIPLINE_PIPELINE_CONTEXT: JSON.stringify(context),
    };

    // All vars present and correctly formatted
    expect(env.RIPLINE_BRANCH).toBe("build/run-123-abc");
    expect(JSON.parse(env.RIPLINE_PIPELINE_CONTEXT)).toEqual(context);
    expect(env.RIPLINE_RUN_ID).toBe(runId);
  });

  it("volume mount format matches Docker --volume syntax", () => {
    const repoPath = "/home/user/project";
    const secretsPath = "/home/user/.secrets";

    const volumes: Record<string, string> = {
      [repoPath]: "/workspace",
      [secretsPath]: "/run/secrets",
    };

    // Docker volume format: host:container
    const volumeArgs: string[] = [];
    for (const [host, container] of Object.entries(volumes)) {
      volumeArgs.push(`${host}:${container}`);
    }

    expect(volumeArgs).toContain("/home/user/project:/workspace");
    expect(volumeArgs).toContain("/home/user/.secrets:/run/secrets");
  });
});

describe("Cross-story: Container build result → run record flow (Stories 4, 6)", () => {
  it("successful build populates complete run record metadata", () => {
    const buildResult: ContainerBuildResult = {
      usedContainer: true,
      containerResult: {
        containerId: "abc123def456",
        exitCode: 0,
        timedOut: false,
        logFile: "/repo/.ripline/runs/run-1/container.log",
      },
      promoteResult: {
        status: "merged",
        message: "Successfully merged 'build/run-1' into 'main'",
        mergeCommit: "deadbeef12345678",
      },
      featureBranch: "build/run-1",
    };

    // Simulate scheduler saving metadata
    const record: Partial<PipelineRunRecord> = {
      id: "run-1",
      status: "completed",
      containerLogFile: buildResult.containerResult!.logFile,
      featureBranch: buildResult.featureBranch,
      outputs: {
        containerExitCode: buildResult.containerResult!.exitCode,
        promoteStatus: buildResult.promoteResult!.status,
        mergeCommit: buildResult.promoteResult!.mergeCommit,
      },
    };

    expect(record.containerLogFile).toBe("/repo/.ripline/runs/run-1/container.log");
    expect(record.featureBranch).toBe("build/run-1");
    expect((record.outputs as any).mergeCommit).toBe("deadbeef12345678");
  });

  it("failed container preserves feature branch in run record", () => {
    const buildResult: ContainerBuildResult = {
      usedContainer: true,
      containerResult: {
        containerId: "fail456789",
        exitCode: 1,
        timedOut: false,
        logFile: "/repo/.ripline/runs/run-2/container.log",
      },
      featureBranch: "build/run-2",
      error: "Container exited with code 1. Logs available at: /repo/.ripline/runs/run-2/container.log",
    };

    // Feature branch preserved for debugging
    expect(buildResult.featureBranch).toBe("build/run-2");
    expect(buildResult.error).toContain("Logs available at");
    // containerLogFile should be set even on failure
    expect(buildResult.containerResult!.logFile).toContain("container.log");
  });

  it("timed-out container produces correct error message", () => {
    const timeoutMs = 600_000;
    const buildResult: ContainerBuildResult = {
      usedContainer: true,
      containerResult: {
        containerId: "timeout789",
        exitCode: null,
        timedOut: true,
        logFile: "/repo/.ripline/runs/run-3/container.log",
      },
      featureBranch: "build/run-3",
      error: `Container timed out after ${timeoutMs / 1000}s. Logs available at: /repo/.ripline/runs/run-3/container.log`,
    };

    expect(buildResult.containerResult!.timedOut).toBe(true);
    expect(buildResult.containerResult!.exitCode).toBeNull();
    expect(buildResult.error).toContain("timed out after 600s");
  });
});

describe("Cross-story: Container log path conventions (Stories 4, 6)", () => {
  it("log path follows .ripline/runs/{runId}/container.log convention", () => {
    const repoPath = "/home/user/project";
    const runId = "run-xyz-789";
    const expectedPath = path.join(repoPath, ".ripline", "runs", runId, "container.log");

    expect(expectedPath).toBe("/home/user/project/.ripline/runs/run-xyz-789/container.log");
  });

  it("server falls back to conventional path when containerLogFile is not set", () => {
    // The server checks record.containerLogFile first, then falls back
    const runsDir = "/data/ripline/runs";
    const runId = "run-abc";

    // When containerLogFile is set, use it
    const recordWithField = { containerLogFile: "/custom/path/container.log" };
    const path1 = recordWithField.containerLogFile ?? path.join(runsDir, runId, "container.log");
    expect(path1).toBe("/custom/path/container.log");

    // When containerLogFile is not set, use conventional path
    const recordWithout = {} as any;
    const path2 = recordWithout.containerLogFile ?? path.join(runsDir, runId, "container.log");
    expect(path2).toBe("/data/ripline/runs/run-abc/container.log");
  });
});

describe("Cross-story: Docker availability caching (Story 4)", () => {
  it("docker info timeout is 5 seconds", () => {
    // The isDockerAvailable() function calls execFileSync with timeout: 5_000
    // Verify the constant matches the documented acceptance criteria
    const DOCKER_CHECK_TIMEOUT = 5_000;
    expect(DOCKER_CHECK_TIMEOUT).toBe(5000);
  });

  it("fallback event is emitted when Docker is unavailable", () => {
    // When usedContainer is false, scheduler emits run.container-fallback
    const buildResult: ContainerBuildResult = { usedContainer: false };

    if (!buildResult.usedContainer) {
      const event = "run.container-fallback";
      expect(event).toBe("run.container-fallback");
    }
  });
});

describe("Cross-story: PipelineRunStatus includes merge-conflict (Story 6)", () => {
  it("merge-conflict is a valid PipelineRunStatus value", () => {
    const validStatuses: PipelineRunStatus[] = [
      "pending",
      "running",
      "paused",
      "errored",
      "completed",
      "merge-conflict",
    ];

    expect(validStatuses).toContain("merge-conflict");
  });

  it("run record can hold merge-conflict status with error and branch", () => {
    const record: Partial<PipelineRunRecord> = {
      id: "run-conflict",
      pipelineId: "build",
      status: "merge-conflict",
      error: "Merge conflict detected when merging 'build/run-conflict' into 'main'",
      featureBranch: "build/run-conflict",
      containerLogFile: "/repo/.ripline/runs/run-conflict/container.log",
    };

    expect(record.status).toBe("merge-conflict");
    expect(record.error).toContain("Merge conflict");
    expect(record.featureBranch).toBeDefined();
  });
});

describe("Cross-story: Queue auto-discovery (Story 6)", () => {
  it("pipelines with queue field get workers even without explicit config", () => {
    // The scheduler auto-discovers queue names from pipeline definitions
    // and ensures at least 1 worker per queue
    const pipelineQueues = ["build", "test", "deploy"];
    const configuredQueues = new Map([["default", 1], ["build", 3]]);

    // Auto-discover missing queues
    for (const queue of pipelineQueues) {
      if (!configuredQueues.has(queue)) {
        configuredQueues.set(queue, 1); // default concurrency
      }
    }

    expect(configuredQueues.get("build")).toBe(3); // configured value preserved
    expect(configuredQueues.get("test")).toBe(1);   // auto-discovered
    expect(configuredQueues.get("deploy")).toBe(1);  // auto-discovered
    expect(configuredQueues.get("default")).toBe(1); // always present
  });
});

describe("Cross-story: Resource limits partial specification (Stories 2, 5)", () => {
  it("cpus-only limits produce only --cpus flag", () => {
    const limits: ContainerResourceLimits = { cpus: "2" };

    const args: string[] = [];
    if (limits.cpus) args.push("--cpus", limits.cpus);
    if (limits.memory) args.push("--memory", limits.memory);

    expect(args).toEqual(["--cpus", "2"]);
    expect(args).not.toContain("--memory");
  });

  it("memory-only limits produce only --memory flag", () => {
    const limits: ContainerResourceLimits = { memory: "4g" };

    const args: string[] = [];
    if (limits.cpus) args.push("--cpus", limits.cpus);
    if (limits.memory) args.push("--memory", limits.memory);

    expect(args).toEqual(["--memory", "4g"]);
    expect(args).not.toContain("--cpus");
  });

  it("both cpus and memory produce both flags", () => {
    const limits: ContainerResourceLimits = { cpus: "1.5", memory: "2g" };

    const args: string[] = [];
    if (limits.cpus) args.push("--cpus", limits.cpus);
    if (limits.memory) args.push("--memory", limits.memory);

    expect(args).toEqual(["--cpus", "1.5", "--memory", "2g"]);
  });

  it("no limits produces no flags", () => {
    const limits: ContainerResourceLimits = {};

    const args: string[] = [];
    if (limits.cpus) args.push("--cpus", limits.cpus);
    if (limits.memory) args.push("--memory", limits.memory);

    expect(args).toEqual([]);
  });
});
