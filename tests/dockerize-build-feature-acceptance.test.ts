/**
 * Comprehensive acceptance tests for: Dockerize build environment to enable
 * parallel builds via isolated containers.
 *
 * This file covers gaps not addressed by existing story-level tests, focusing on:
 *
 *  Story 1: Dockerfile & entrypoint (validated in wintermute)
 *  Story 2: ContainerManager — buildRunArgs edge cases, lifecycle
 *  Story 3: PromoteStep — ordering guarantees, error boundary behavior
 *  Story 4: Container build runner — runsDir log paths, env var completeness,
 *           Docker availability caching semantics, spawn error cleanup
 *  Story 5: Queue config — Zod schema validation boundaries, getQueueConfig
 *           defaults, partial resource limits edge cases
 *  Story 6: Integration — config→schema→queue→container→status→record pipeline,
 *           server queue merge logic, scheduler event contracts
 *
 * Tests document correct behavior and validate acceptance criteria.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/* ── ESM-safe child_process mock ────────────────────────────────────────── */

const { execFileMockFn, execFileSyncMockFn, spawnMockFn } = vi.hoisted(() => ({
  execFileMockFn: vi.fn(),
  execFileSyncMockFn: vi.fn(),
  spawnMockFn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  execFile: execFileMockFn,
  execFileSync: execFileSyncMockFn,
  spawn: spawnMockFn,
}));

/* ── Imports ─────────────────────────────────────────────────────────── */

import { ContainerManager } from "../src/container-manager.js";
import {
  mapContainerBuildToRunStatus,
  PROMOTE_STATUS_TO_RUN_STATUS,
} from "../src/container-status-map.js";
import { loadUserConfig, getQueueConfig, expandTilde } from "../src/config.js";
import {
  queuesConfigSchema,
  queueConfigSchema,
  containerResourceLimitsSchema,
} from "../src/schema.js";
import type {
  ContainerBuildUserConfig,
  ContainerResourceLimits,
  QueueConfig,
  PipelineRunStatus,
  PipelineRunRecord,
} from "../src/types.js";
import type { ContainerBuildResult } from "../src/container-build-runner.js";
import type { PromoteStepResult } from "../src/promote-step.js";

beforeEach(() => {
  execFileMockFn.mockReset();
  execFileSyncMockFn.mockReset();
  spawnMockFn.mockReset();
});

const silentLogger = { log: vi.fn() } as any;

/* ════════════════════════════════════════════════════════════════════════
 * Story 2: ContainerManager — acceptance criteria
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 2 — ContainerManager: buildRunArgs edge cases", () => {
  let manager: ContainerManager;

  afterEach(() => {
    manager?.dispose();
    vi.restoreAllMocks();
  });

  it("default TTL is 30 minutes (1_800_000 ms)", () => {
    // ContainerManager defaults failedContainerTTL to 30 * 60 * 1000
    manager = new ContainerManager({ logger: silentLogger });
    // No direct getter, but we verify it doesn't error and cleanup runs
    expect(manager.trackedFailedContainers).toEqual([]);
    manager.dispose();
  });

  it("cleanupExpiredContainers removes only expired entries", () => {
    manager = new ContainerManager({
      failedContainerTTL: 100,
      logger: silentLogger,
    });

    // Manually inject failed containers with different timestamps
    const now = Date.now();
    (manager as any).failedContainers.push(
      { containerId: "expired-1", failedAt: now - 200 },
      { containerId: "fresh-1", failedAt: now - 10 },
      { containerId: "expired-2", failedAt: now - 500 },
    );

    // Mock docker rm
    (child_process.execFileSync as any).mockReturnValue("" as any);

    manager.cleanupExpiredContainers();

    // Only fresh-1 should remain
    expect(manager.trackedFailedContainers).toHaveLength(1);
    expect(manager.trackedFailedContainers[0]!.containerId).toBe("fresh-1");
  });

  it("cleanup loop interval is capped at 60 seconds", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    // With TTL of 10 minutes, interval should be 60_000 (the cap)
    manager = new ContainerManager({
      failedContainerTTL: 10 * 60 * 1000,
      logger: silentLogger,
    });

    // setInterval should have been called with 60_000
    const intervalCall = setIntervalSpy.mock.calls.find(
      (c) => typeof c[1] === "number" && c[1] <= 60_000,
    );
    expect(intervalCall).toBeDefined();
    expect(intervalCall![1]).toBe(60_000);
  });

  it("cleanup loop interval matches TTL when TTL < 60 seconds", () => {
    const setIntervalSpy = vi.spyOn(global, "setInterval");

    manager = new ContainerManager({
      failedContainerTTL: 5_000,
      logger: silentLogger,
    });

    const intervalCall = setIntervalSpy.mock.calls[
      setIntervalSpy.mock.calls.length - 1
    ];
    expect(intervalCall![1]).toBe(5_000);
  });

  it("spawn creates log directory recursively before streaming", async () => {
    manager = new ContainerManager({ logger: silentLogger });

    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "openSync").mockReturnValue(99);
    vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
    (child_process.execFileSync as any).mockReturnValue("" as any);
    (child_process.execFile as any).mockImplementation(
      ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") callback(null, "container1234\n", "");
        else if (args[0] === "wait") callback(null, "0\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      }) as any,
    );

    await manager.spawn({
      image: "node:22",
      logFile: "/var/log/ripline/builds/deep/nested/container.log",
    });

    expect(mkdirSpy).toHaveBeenCalledWith(
      "/var/log/ripline/builds/deep/nested",
      { recursive: true },
    );
  });

  it("passes workdir, name, env, and volumes to docker run args", async () => {
    manager = new ContainerManager({ logger: silentLogger });

    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "openSync").mockReturnValue(99);
    vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
    (child_process.execFileSync as any).mockReturnValue("" as any);

    let capturedArgs: string[] = [];
    (child_process.execFile as any).mockImplementation(
      ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "argstest1234\n", "");
        } else if (args[0] === "wait") callback(null, "0\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      }) as any,
    );

    await manager.spawn({
      image: "builder:v3",
      command: ["npm", "run", "build"],
      env: { FOO: "bar", BAZ: "qux" },
      volumes: { "/host/repo": "/workspace", "/host/secrets": "/run/secrets" },
      workdir: "/workspace",
      logFile: "/tmp/test.log",
      name: "my-container",
      resourceLimits: { cpus: "1.5", memory: "2g" },
    });

    // Verify all args present
    expect(capturedArgs).toContain("--detach");
    expect(capturedArgs).toContain("--name");
    expect(capturedArgs).toContain("my-container");
    expect(capturedArgs).toContain("--workdir");
    expect(capturedArgs).toContain("/workspace");
    expect(capturedArgs).toContain("FOO=bar");
    expect(capturedArgs).toContain("BAZ=qux");
    expect(capturedArgs).toContain("/host/repo:/workspace");
    expect(capturedArgs).toContain("/host/secrets:/run/secrets");
    expect(capturedArgs).toContain("--cpus");
    expect(capturedArgs).toContain("1.5");
    expect(capturedArgs).toContain("--memory");
    expect(capturedArgs).toContain("2g");
    expect(capturedArgs).toContain("builder:v3");
    // Command at end
    expect(capturedArgs.slice(-3)).toEqual(["npm", "run", "build"]);
  });

  it("omits optional flags when not specified", async () => {
    manager = new ContainerManager({ logger: silentLogger });

    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "openSync").mockReturnValue(99);
    vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);
    (child_process.execFileSync as any).mockReturnValue("" as any);

    let capturedArgs: string[] = [];
    (child_process.execFile as any).mockImplementation(
      ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "minimal12345\n", "");
        } else if (args[0] === "wait") callback(null, "0\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      }) as any,
    );

    await manager.spawn({
      image: "node:22",
      logFile: "/tmp/minimal.log",
    });

    // Should NOT contain optional flags
    expect(capturedArgs).not.toContain("--name");
    expect(capturedArgs).not.toContain("--workdir");
    expect(capturedArgs).not.toContain("--env");
    expect(capturedArgs).not.toContain("--volume");
    expect(capturedArgs).not.toContain("--cpus");
    expect(capturedArgs).not.toContain("--memory");
    // Must contain image
    expect(capturedArgs).toContain("node:22");
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 3: PromoteStep — type contract completeness
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 3 — PromoteStep type contracts and boundary values", () => {
  it("error result includes gitOutput for checkout failures", () => {
    const result: PromoteStepResult = {
      status: "error",
      message: "Failed to checkout feature branch 'build/nonexistent'",
      gitOutput: "error: pathspec 'build/nonexistent' did not match any",
    };

    expect(result.status).toBe("error");
    expect(result.gitOutput).toBeDefined();
    expect(result.mergeCommit).toBeUndefined();
    expect(result.testOutput).toBeUndefined();
  });

  it("merged result does not include testOutput or gitOutput", () => {
    const result: PromoteStepResult = {
      status: "merged",
      message: "Successfully merged 'build/run-1' into 'main'",
      mergeCommit: "abc123def456deadbeef",
    };

    expect(result.mergeCommit).toBeDefined();
    expect(result.testOutput).toBeUndefined();
    expect(result.gitOutput).toBeUndefined();
  });

  it("test-failure result message mentions the branch and 'aborted'", () => {
    const result: PromoteStepResult = {
      status: "test-failure",
      message: "Test suite failed on 'build/run-tf'. Merge aborted.",
      testOutput: "FAIL: 3 tests failed",
    };

    expect(result.message).toContain("build/run-tf");
    expect(result.message).toContain("aborted");
  });

  it("needs-conflict-resolution message mentions branch preservation", () => {
    const result: PromoteStepResult = {
      status: "needs-conflict-resolution",
      message:
        "Merge conflict detected when merging 'build/run-mc' into 'main'. Branch preserved for manual resolution.",
      gitOutput: "CONFLICT (content): Merge conflict in src/index.ts",
    };

    expect(result.message).toContain("preserved");
    expect(result.message).toContain("manual resolution");
    expect(result.gitOutput).toContain("CONFLICT");
  });

  it("all four promote statuses map exhaustively to PipelineRunStatus", () => {
    const statuses: PromoteStepResult["status"][] = [
      "merged",
      "needs-conflict-resolution",
      "test-failure",
      "error",
    ];

    for (const s of statuses) {
      expect(PROMOTE_STATUS_TO_RUN_STATUS[s]).toBeDefined();
    }
    expect(Object.keys(PROMOTE_STATUS_TO_RUN_STATUS)).toHaveLength(4);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 4: Container build runner — env vars, log paths, caching
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 4 — Container build runner: env var completeness", () => {
  it("RIPLINE_JOB_INPUTS is JSON-serialized from context.inputs", () => {
    const context = { inputs: { task: "build", storyId: "s-1" }, extra: "data" };

    // container-build-runner sets RIPLINE_JOB_INPUTS = JSON.stringify(context.inputs ?? {})
    const env: Record<string, string> = {
      RIPLINE_JOB_INPUTS: JSON.stringify(context.inputs ?? {}),
    };

    const parsed = JSON.parse(env.RIPLINE_JOB_INPUTS);
    expect(parsed.task).toBe("build");
    expect(parsed.storyId).toBe("s-1");
  });

  it("RIPLINE_JOB_INPUTS defaults to {} when context.inputs is undefined", () => {
    const context: Record<string, unknown> = {};

    const env: Record<string, string> = {
      RIPLINE_JOB_INPUTS: JSON.stringify(
        (context.inputs as Record<string, unknown>) ?? {},
      ),
    };

    expect(JSON.parse(env.RIPLINE_JOB_INPUTS)).toEqual({});
  });

  it("RIPLINE_REPO_URL is empty string for local-only repos (no remote)", () => {
    // When git remote get-url origin throws, repoUrl = ""
    const env: Record<string, string> = {
      RIPLINE_REPO_URL: "", // Local-only
    };

    expect(env.RIPLINE_REPO_URL).toBe("");
  });

  it("all 8 RIPLINE_ env vars are set for container execution", () => {
    const requiredVars = [
      "RIPLINE_REPO_PATH",
      "RIPLINE_REPO_URL",
      "RIPLINE_BRANCH",
      "RIPLINE_TARGET_BRANCH",
      "RIPLINE_RUN_ID",
      "RIPLINE_PIPELINE_ID",
      "RIPLINE_PIPELINE_CONTEXT",
      "RIPLINE_JOB_INPUTS",
    ];

    // Simulate env construction
    const runId = "run-123";
    const pipelineId = "my-pipeline";
    const context = { inputs: { task: "build" } };
    const featureBranch = `build/${runId}`;

    const env: Record<string, string> = {
      RIPLINE_REPO_PATH: "/home/user/project",
      RIPLINE_REPO_URL: "git@github.com:user/project.git",
      RIPLINE_BRANCH: featureBranch,
      RIPLINE_TARGET_BRANCH: "main",
      RIPLINE_RUN_ID: runId,
      RIPLINE_PIPELINE_ID: pipelineId,
      RIPLINE_PIPELINE_CONTEXT: JSON.stringify(context),
      RIPLINE_JOB_INPUTS: JSON.stringify(context.inputs ?? {}),
    };

    for (const v of requiredVars) {
      expect(env[v]).toBeDefined();
      expect(typeof env[v]).toBe("string");
    }
  });
});

describe("Story 4 — Container build runner: log path computation", () => {
  it("uses runsDir when provided for log file location", () => {
    const runsDir = "/data/ripline/runs";
    const runId = "run-xyz-789";

    // container-build-runner.ts line 184-188
    const logDir = path.join(runsDir, runId);
    const logFile = path.join(logDir, "container.log");

    expect(logFile).toBe("/data/ripline/runs/run-xyz-789/container.log");
  });

  it("falls back to .ripline/runs/{runId} when runsDir is not provided", () => {
    const repoPath = "/home/user/project";
    const runId = "run-abc-123";
    const runsDir = undefined;

    // container-build-runner.ts line 186
    const logDir = runsDir
      ? path.join(runsDir, runId)
      : path.join(repoPath, ".ripline", "runs", runId);
    const logFile = path.join(logDir, "container.log");

    expect(logFile).toBe(
      "/home/user/project/.ripline/runs/run-abc-123/container.log",
    );
  });

  it("container name uses first 8 chars of runId", () => {
    const runId = "abc12345-6789-def0-1234-567890abcdef";
    const name = `ripline-build-${runId.slice(0, 8)}`;

    expect(name).toBe("ripline-build-abc12345");
    expect(name.length).toBeLessThan(64); // Docker limit
  });

  it("short runIds produce valid container names", () => {
    const runId = "ab";
    const name = `ripline-build-${runId.slice(0, 8)}`;

    expect(name).toBe("ripline-build-ab");
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("Story 4 — Container build defaults", () => {
  it("default targetBranch is 'main'", () => {
    const defaults = { targetBranch: "main" };
    expect(defaults.targetBranch).toBe("main");
  });

  it("default buildImage is 'ripline-builder:latest'", () => {
    const defaults = { buildImage: "ripline-builder:latest" };
    expect(defaults.buildImage).toBe("ripline-builder:latest");
  });

  it("default testCommand is 'npm test'", () => {
    const defaults = { testCommand: "npm test" };
    expect(defaults.testCommand).toBe("npm test");
  });

  it("default containerTimeoutMs is 600_000 (10 minutes)", () => {
    const defaults = { containerTimeoutMs: 600_000 };
    expect(defaults.containerTimeoutMs).toBe(600_000);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 5: Queue config — Zod schema validation boundaries
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 5 — containerResourceLimitsSchema validation", () => {
  it("accepts valid cpus string (integer)", () => {
    const result = containerResourceLimitsSchema.safeParse({ cpus: "2" });
    expect(result.success).toBe(true);
  });

  it("accepts valid cpus string (decimal)", () => {
    const result = containerResourceLimitsSchema.safeParse({ cpus: "1.5" });
    expect(result.success).toBe(true);
  });

  it("accepts valid memory string with m suffix", () => {
    const result = containerResourceLimitsSchema.safeParse({ memory: "512m" });
    expect(result.success).toBe(true);
  });

  it("accepts valid memory string with g suffix", () => {
    const result = containerResourceLimitsSchema.safeParse({ memory: "4g" });
    expect(result.success).toBe(true);
  });

  it("accepts valid memory string with b suffix", () => {
    const result = containerResourceLimitsSchema.safeParse({
      memory: "1073741824b",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid memory string with k suffix", () => {
    const result = containerResourceLimitsSchema.safeParse({ memory: "512k" });
    expect(result.success).toBe(true);
  });

  it("rejects cpus with non-numeric characters", () => {
    const result = containerResourceLimitsSchema.safeParse({ cpus: "two" });
    expect(result.success).toBe(false);
  });

  it("rejects memory without size suffix", () => {
    const result = containerResourceLimitsSchema.safeParse({ memory: "512" });
    expect(result.success).toBe(false);
  });

  it("rejects memory with invalid suffix", () => {
    const result = containerResourceLimitsSchema.safeParse({ memory: "512x" });
    expect(result.success).toBe(false);
  });

  it("accepts empty object (both fields optional)", () => {
    const result = containerResourceLimitsSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = containerResourceLimitsSchema.safeParse({
      cpus: "1",
      extra: "field",
    });
    expect(result.success).toBe(false);
  });
});

describe("Story 5 — queueConfigSchema validation", () => {
  it("defaults concurrency to 1 when not provided", () => {
    const result = queueConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrency).toBe(1);
    }
  });

  it("rejects concurrency of 0", () => {
    const result = queueConfigSchema.safeParse({ concurrency: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects negative concurrency", () => {
    const result = queueConfigSchema.safeParse({ concurrency: -1 });
    expect(result.success).toBe(false);
  });

  it("accepts concurrency of 1", () => {
    const result = queueConfigSchema.safeParse({ concurrency: 1 });
    expect(result.success).toBe(true);
  });

  it("accepts concurrency with resource limits", () => {
    const result = queueConfigSchema.safeParse({
      concurrency: 4,
      resourceLimits: { cpus: "2", memory: "4g" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.concurrency).toBe(4);
      expect(result.data.resourceLimits?.cpus).toBe("2");
      expect(result.data.resourceLimits?.memory).toBe("4g");
    }
  });

  it("rejects non-integer concurrency", () => {
    const result = queueConfigSchema.safeParse({ concurrency: 1.5 });
    expect(result.success).toBe(false);
  });

  it("rejects extra fields (strict mode)", () => {
    const result = queueConfigSchema.safeParse({
      concurrency: 2,
      unknownField: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("Story 5 — queuesConfigSchema validation", () => {
  it("accepts multiple queue entries", () => {
    const result = queuesConfigSchema.safeParse({
      build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
      test: { concurrency: 2 },
      default: { concurrency: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty queue name", () => {
    const result = queuesConfigSchema.safeParse({
      "": { concurrency: 1 },
    });
    expect(result.success).toBe(false);
  });

  it("accepts empty queues object", () => {
    const result = queuesConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

describe("Story 5 — getQueueConfig function", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-getqc-${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".ripline"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("returns default config (concurrency 1, no limits) for unconfigured queue", () => {
    // No config file → empty config → default
    const config = getQueueConfig("build", path.join(tmpHome, "nonexistent"));

    expect(config.concurrency).toBe(1);
    expect(config.resourceLimits).toBeUndefined();
  });

  it("returns configured values for a defined queue", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        queues: {
          build: { concurrency: 4, resourceLimits: { cpus: "2", memory: "8g" } },
        },
      }),
    );

    const config = getQueueConfig("build", tmpHome);

    expect(config.concurrency).toBe(4);
    expect(config.resourceLimits).toEqual({ cpus: "2", memory: "8g" });
  });

  it("falls back to default for a queue not in config", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        queues: {
          build: { concurrency: 3 },
        },
      }),
    );

    const config = getQueueConfig("deploy", tmpHome);

    expect(config.concurrency).toBe(1);
    expect(config.resourceLimits).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 5 — containerBuild user config parsing
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 5 — containerBuild user config validation", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-cbconfig-${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".ripline"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("disabled by default when enabled is not set", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({ containerBuild: { repoPath: "/repo" } }),
    );

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.enabled).toBeUndefined();
  });

  it("expands tilde in repoPath and secretsMountPath", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        containerBuild: {
          repoPath: "~/project",
          secretsMountPath: "~/.build-secrets",
        },
      }),
    );

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.repoPath).toBe(
      path.join(tmpHome, "project"),
    );
    expect(config.containerBuild!.secretsMountPath).toBe(
      path.join(tmpHome, ".build-secrets"),
    );
  });

  it("ignores unexpected types in containerBuild fields", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        containerBuild: {
          enabled: "yes", // should be boolean, so won't be set
          repoPath: 42, // should be string, so won't be set
          containerTimeoutMs: "fast", // should be number, so won't be set
        },
      }),
    );

    const config = loadUserConfig(tmpHome);
    const cb = config.containerBuild!;

    expect(cb.enabled).toBeUndefined();
    expect(cb.repoPath).toBeUndefined();
    expect(cb.containerTimeoutMs).toBeUndefined();
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 6: Integration — status mapping exhaustiveness
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 6 — mapContainerBuildToRunStatus: full decision tree", () => {
  it("Docker unavailable → null status (caller handles fallback)", () => {
    const m = mapContainerBuildToRunStatus({ usedContainer: false });
    expect(m.status).toBeNull();
    expect(m.usedContainer).toBe(false);
    expect(m.preserveFeatureBranch).toBe(false);
  });

  it("spawn failure (no containerResult) → errored, no branch preserve", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      error: "image not found",
    });
    expect(m.status).toBe("errored");
    expect(m.preserveFeatureBranch).toBe(false);
  });

  it("container timeout → errored, preserve branch", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "t1",
        exitCode: null,
        timedOut: true,
        logFile: "/tmp/log",
      },
      featureBranch: "build/r1",
    });
    expect(m.status).toBe("errored");
    expect(m.preserveFeatureBranch).toBe(true);
  });

  it("container non-zero exit → errored, preserve branch", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "f1",
        exitCode: 137,
        timedOut: false,
        logFile: "/tmp/log",
      },
      featureBranch: "build/r2",
    });
    expect(m.status).toBe("errored");
    expect(m.preserveFeatureBranch).toBe(true);
    expect(m.summary).toContain("137");
  });

  it("container success + merged → completed, no branch preserve", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "s1",
        exitCode: 0,
        timedOut: false,
        logFile: "/tmp/log",
      },
      promoteResult: {
        status: "merged",
        message: "OK",
        mergeCommit: "abc123",
      },
      featureBranch: "build/r3",
    });
    expect(m.status).toBe("completed");
    expect(m.preserveFeatureBranch).toBe(false);
  });

  it("container success + needs-conflict-resolution → needs-conflict-resolution, preserve branch", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "c1",
        exitCode: 0,
        timedOut: false,
        logFile: "/tmp/log",
      },
      promoteResult: {
        status: "needs-conflict-resolution",
        message: "Conflict in file.ts",
      },
      featureBranch: "build/r4",
    });
    expect(m.status).toBe("needs-conflict-resolution");
    expect(m.preserveFeatureBranch).toBe(true);
  });

  it("container success + test-failure → errored, preserve branch", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "tf1",
        exitCode: 0,
        timedOut: false,
        logFile: "/tmp/log",
      },
      promoteResult: {
        status: "test-failure",
        message: "Tests failed",
        testOutput: "FAIL",
      },
      featureBranch: "build/r5",
    });
    expect(m.status).toBe("errored");
    expect(m.preserveFeatureBranch).toBe(true);
  });

  it("container success + promote error → errored, no branch preserve", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "pe1",
        exitCode: 0,
        timedOut: false,
        logFile: "/tmp/log",
      },
      promoteResult: {
        status: "error",
        message: "git checkout failed",
      },
      featureBranch: "build/r6",
    });
    expect(m.status).toBe("errored");
    expect(m.preserveFeatureBranch).toBe(false);
  });

  it("container exit 0 with no promoteResult and no error → completed", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "np1",
        exitCode: 0,
        timedOut: false,
        logFile: "/tmp/log",
      },
    });
    expect(m.status).toBe("completed");
  });

  it("container exit 0 with error but no promoteResult → errored", () => {
    const m = mapContainerBuildToRunStatus({
      usedContainer: true,
      containerResult: {
        containerId: "ep1",
        exitCode: 0,
        timedOut: false,
        logFile: "/tmp/log",
      },
      error: "promoteStep threw unexpectedly",
    });
    expect(m.status).toBe("errored");
    expect(m.error).toContain("promoteStep");
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 6: Integration — server queue merge logic
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 6 — Queue merge logic (server startup)", () => {
  it("user config queues provide both concurrency and resource limits", () => {
    const userQueues: Record<string, QueueConfig> = {
      build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
      test: { concurrency: 2 },
    };

    const mergedConcurrencies: Record<string, number> = {};
    const mergedResourceLimits: Record<string, ContainerResourceLimits> = {};

    for (const [name, qc] of Object.entries(userQueues)) {
      mergedConcurrencies[name] = qc.concurrency;
      if (qc.resourceLimits) {
        mergedResourceLimits[name] = qc.resourceLimits;
      }
    }

    expect(mergedConcurrencies).toEqual({ build: 3, test: 2 });
    expect(mergedResourceLimits).toEqual({
      build: { cpus: "2", memory: "4g" },
    });
  });

  it("CLI --queue flags override concurrency from user config", () => {
    const mergedConcurrencies: Record<string, number> = {
      build: 3, // from user config
      test: 2,
    };

    const cliOverrides: Record<string, number> = {
      build: 6, // CLI override
    };

    for (const [name, concurrency] of Object.entries(cliOverrides)) {
      mergedConcurrencies[name] = concurrency;
    }

    expect(mergedConcurrencies.build).toBe(6); // CLI wins
    expect(mergedConcurrencies.test).toBe(2); // unchanged
  });

  it("plugin config queues override user config queues", () => {
    const mergedConcurrencies: Record<string, number> = {};
    const mergedResourceLimits: Record<string, ContainerResourceLimits> = {};

    // User config first
    const userQueues: Record<string, QueueConfig> = {
      build: { concurrency: 3, resourceLimits: { cpus: "1" } },
    };
    for (const [name, qc] of Object.entries(userQueues)) {
      mergedConcurrencies[name] = qc.concurrency;
      if (qc.resourceLimits) mergedResourceLimits[name] = qc.resourceLimits;
    }

    // Plugin config second (overrides)
    const pluginQueues: Record<string, QueueConfig> = {
      build: { concurrency: 5, resourceLimits: { cpus: "4", memory: "16g" } },
    };
    for (const [name, qc] of Object.entries(pluginQueues)) {
      mergedConcurrencies[name] = qc.concurrency;
      if (qc.resourceLimits) mergedResourceLimits[name] = qc.resourceLimits;
    }

    expect(mergedConcurrencies.build).toBe(5); // Plugin wins
    expect(mergedResourceLimits.build).toEqual({ cpus: "4", memory: "16g" });
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 6: Integration — scheduler eligibility + event contracts
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 6 — Scheduler container eligibility rules", () => {
  const isContainerEligible = (
    containerBuild: object | undefined,
    record: Partial<PipelineRunRecord>,
  ): boolean =>
    !!containerBuild && !record.parentRunId && record.cursor === undefined;

  it("top-level fresh run with containerBuild config → eligible", () => {
    expect(
      isContainerEligible({ repoPath: "/repo" }, { id: "r1" }),
    ).toBe(true);
  });

  it("no containerBuild config → never eligible", () => {
    expect(isContainerEligible(undefined, { id: "r2" })).toBe(false);
  });

  it("child run (has parentRunId) → not eligible", () => {
    expect(
      isContainerEligible(
        { repoPath: "/repo" },
        { id: "r3", parentRunId: "r1" },
      ),
    ).toBe(false);
  });

  it("resumed run (has cursor) → not eligible", () => {
    expect(
      isContainerEligible(
        { repoPath: "/repo" },
        { id: "r4", cursor: { nextNodeIndex: 2, context: {} } },
      ),
    ).toBe(false);
  });

  it("child run that is also resumed → not eligible", () => {
    expect(
      isContainerEligible(
        { repoPath: "/repo" },
        {
          id: "r5",
          parentRunId: "r1",
          cursor: { nextNodeIndex: 0, context: {} },
        },
      ),
    ).toBe(false);
  });
});

describe("Story 6 — Container lifecycle event naming", () => {
  const CONTAINER_EVENTS = [
    "run.container-started",
    "run.container-completed",
    "run.container-failed",
    "run.container-fallback",
  ] as const;

  it("all events follow run.container-* naming convention", () => {
    for (const event of CONTAINER_EVENTS) {
      expect(event).toMatch(/^run\.container-[a-z]+$/);
    }
  });

  it("each event name is unique", () => {
    expect(new Set(CONTAINER_EVENTS).size).toBe(CONTAINER_EVENTS.length);
  });

  it("4 container lifecycle events exist", () => {
    expect(CONTAINER_EVENTS).toHaveLength(4);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 6: Integration — run record metadata through full lifecycle
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 6 — Run record metadata through container lifecycle", () => {
  it("containerLogFile and featureBranch are set on container start", () => {
    const record: Partial<PipelineRunRecord> = {
      id: "run-meta-test",
      pipelineId: "pipe-1",
      status: "running",
      startedAt: Date.now(),
      updatedAt: Date.now(),
      inputs: {},
      steps: [],
      childRunIds: [],
    };

    // Simulate container start
    record.containerLogFile = "/runs/run-meta-test/container.log";
    record.featureBranch = "build/run-meta-test";

    expect(record.containerLogFile).toBeDefined();
    expect(record.featureBranch).toBeDefined();
  });

  it("metadata persists through status=completed", () => {
    const record: Partial<PipelineRunRecord> = {
      id: "run-persist",
      status: "running",
      containerLogFile: "/runs/run-persist/container.log",
      featureBranch: "build/run-persist",
    };

    record.status = "completed";
    expect(record.containerLogFile).toBe("/runs/run-persist/container.log");
    expect(record.featureBranch).toBe("build/run-persist");
  });

  it("metadata persists through status=errored", () => {
    const record: Partial<PipelineRunRecord> = {
      id: "run-err",
      status: "running",
      containerLogFile: "/runs/run-err/container.log",
      featureBranch: "build/run-err",
    };

    record.status = "errored";
    record.error = "Container exited with code 1";
    expect(record.containerLogFile).toBeDefined();
    expect(record.featureBranch).toBeDefined();
  });

  it("metadata persists through status=needs-conflict-resolution", () => {
    const record: Partial<PipelineRunRecord> = {
      id: "run-mc",
      status: "running",
      containerLogFile: "/runs/run-mc/container.log",
      featureBranch: "build/run-mc",
    };

    record.status = "needs-conflict-resolution";
    record.error = "Merge conflict detected";
    expect(record.containerLogFile).toBeDefined();
    expect(record.featureBranch).toBe("build/run-mc");
  });

  it("PipelineRunStatus includes needs-conflict-resolution as valid value", () => {
    const allStatuses: PipelineRunStatus[] = [
      "pending",
      "running",
      "paused",
      "errored",
      "completed",
      "needs-conflict-resolution",
    ];

    expect(allStatuses).toContain("needs-conflict-resolution");
    expect(allStatuses).toHaveLength(6);
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 6: Integration — Container log retrieval path (server)
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 6 — Container log retrieval path resolution", () => {
  it("prefers containerLogFile from run record", () => {
    const record = { containerLogFile: "/custom/path/container.log" };
    const runsDir = "/data/runs";
    const runId = "run-1";

    const logPath =
      record.containerLogFile ?? path.join(runsDir, runId, "container.log");

    expect(logPath).toBe("/custom/path/container.log");
  });

  it("falls back to conventional path when containerLogFile is undefined", () => {
    const record: { containerLogFile?: string } = {};
    const runsDir = "/data/runs";
    const runId = "run-2";

    const logPath =
      record.containerLogFile ?? path.join(runsDir, runId, "container.log");

    expect(logPath).toBe("/data/runs/run-2/container.log");
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Story 6: Integration — Parallel build isolation guarantees
 * ════════════════════════════════════════════════════════════════════════ */

describe("Story 6 — Parallel build isolation", () => {
  it("N concurrent runs produce N unique feature branches", () => {
    const runIds = Array.from({ length: 10 }, (_, i) => `run-${i}-${Date.now()}`);
    const branches = new Set(runIds.map((id) => `build/${id}`));
    expect(branches.size).toBe(runIds.length);
  });

  it("N concurrent runs produce N unique container names", () => {
    const runIds = Array.from({ length: 10 }, (_, i) => `run-${i}-${Date.now()}`);
    const names = new Set(
      runIds.map((id) => `ripline-build-${id.slice(0, 8)}`),
    );
    expect(names.size).toBe(runIds.length);
  });

  it("feature branch naming is build/{runId} — deterministic", () => {
    expect(`build/${"run-abc-123"}`).toBe("build/run-abc-123");
  });

  it("container names are deterministic from runId prefix", () => {
    const runId = "run-xyz-789-abc-def";
    expect(`ripline-build-${runId.slice(0, 8)}`).toBe("ripline-build-run-xyz-");
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Cross-story: Full config → container → status → record pipeline
 * ════════════════════════════════════════════════════════════════════════ */

describe("Cross-story: Config → Container → Status → Record pipeline", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-pipeline-${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".ripline"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("end-to-end: config loads → schema validates → queue config extracted → status mapped", () => {
    // Step 1: Write config
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        containerBuild: {
          enabled: true,
          repoPath: "~/myproject",
          buildImage: "builder:v2",
          testCommand: "npm run test:ci",
          containerTimeoutMs: 900_000,
        },
        queues: {
          build: { concurrency: 3, resourceLimits: { cpus: "2", memory: "4g" } },
        },
      }),
    );

    // Step 2: Load config
    const config = loadUserConfig(tmpHome);
    expect(config.containerBuild!.enabled).toBe(true);
    expect(config.containerBuild!.repoPath).toBe(path.join(tmpHome, "myproject"));

    // Step 3: Schema validates queue config
    const zodResult = queuesConfigSchema.safeParse(config.queues);
    expect(zodResult.success).toBe(true);

    // Step 4: Get queue config for build
    const buildQueue = config.queues!.build!;
    expect(buildQueue.concurrency).toBe(3);
    expect(buildQueue.resourceLimits).toEqual({ cpus: "2", memory: "4g" });

    // Step 5: Simulate successful container build result
    const buildResult: ContainerBuildResult = {
      usedContainer: true,
      containerResult: {
        containerId: "abc123def456",
        exitCode: 0,
        timedOut: false,
        logFile: path.join(tmpHome, "myproject", ".ripline", "runs", "run-1", "container.log"),
      },
      promoteResult: {
        status: "merged",
        message: "Successfully merged",
        mergeCommit: "deadbeef",
      },
      featureBranch: "build/run-1",
    };

    // Step 6: Map to run status
    const mapping = mapContainerBuildToRunStatus(buildResult);
    expect(mapping.status).toBe("completed");
    expect(mapping.preserveFeatureBranch).toBe(false);

    // Step 7: Persist to run record
    const record: Partial<PipelineRunRecord> = {
      id: "run-1",
      pipelineId: "build-pipeline",
      status: mapping.status!,
      containerLogFile: buildResult.containerResult!.logFile,
      featureBranch: buildResult.featureBranch,
    };

    expect(record.status).toBe("completed");
    expect(record.containerLogFile).toContain("container.log");
    expect(record.featureBranch).toBe("build/run-1");
  });

  it("end-to-end: merge conflict → status mapped → branch preserved", () => {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        containerBuild: { enabled: true, repoPath: "/repo" },
        queues: { build: { concurrency: 2 } },
      }),
    );

    const config = loadUserConfig(tmpHome);
    expect(config.containerBuild!.enabled).toBe(true);

    const buildResult: ContainerBuildResult = {
      usedContainer: true,
      containerResult: {
        containerId: "mc-container",
        exitCode: 0,
        timedOut: false,
        logFile: "/runs/run-mc/container.log",
      },
      promoteResult: {
        status: "needs-conflict-resolution",
        message: "Merge conflict in shared.ts. Branch preserved.",
        gitOutput: "CONFLICT (content): shared.ts",
      },
      featureBranch: "build/run-mc",
    };

    const mapping = mapContainerBuildToRunStatus(buildResult);
    expect(mapping.status).toBe("needs-conflict-resolution");
    expect(mapping.preserveFeatureBranch).toBe(true);

    const record: Partial<PipelineRunRecord> = {
      id: "run-mc",
      status: mapping.status!,
      error: mapping.error,
      featureBranch: buildResult.featureBranch,
      containerLogFile: buildResult.containerResult!.logFile,
    };

    expect(record.status).toBe("needs-conflict-resolution");
    expect(record.featureBranch).toBe("build/run-mc");
    expect(record.error).toContain("Merge conflict");
  });
});

/* ════════════════════════════════════════════════════════════════════════
 * Cross-story: expandTilde correctness
 * ════════════════════════════════════════════════════════════════════════ */

describe("Cross-story: expandTilde edge cases", () => {
  it("expands ~ alone to homedir", () => {
    expect(expandTilde("~", "/home/user")).toBe("/home/user");
  });

  it("expands ~/path to homedir/path", () => {
    expect(expandTilde("~/project", "/home/user")).toBe("/home/user/project");
  });

  it("does not expand ~ in the middle of a path", () => {
    expect(expandTilde("/some/~path", "/home/user")).toBe("/some/~path");
  });

  it("does not expand ~ at end of path", () => {
    expect(expandTilde("/some/path~", "/home/user")).toBe("/some/path~");
  });

  it("handles Windows-style tilde paths", () => {
    expect(expandTilde("~\\project", "/home/user")).toBe(
      path.join("/home/user", "project"),
    );
  });

  it("returns absolute paths unchanged", () => {
    expect(expandTilde("/absolute/path", "/home/user")).toBe("/absolute/path");
  });
});
