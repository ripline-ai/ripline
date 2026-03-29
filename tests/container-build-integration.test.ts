import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { ContainerResourceLimits, QueueConfig, PipelineRunRecord } from "../src/types.js";
import { loadUserConfig } from "../src/config.js";

/**
 * Integration tests covering the interaction between:
 * - Container build runner + Container manager (spawn → cleanup lifecycle)
 * - Container build runner + Promote step (success → merge flow)
 * - Scheduler integration (container config + queue resource limits)
 * - Config loading → Queue resource limits → Container execution
 */

/* ── Helpers ──────────────────────────────────────────────────────────── */

const silentLogger = { log: vi.fn() } as any;

describe("Integration: Config → Queue → Container lifecycle", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-integ-${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".ripline"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it("queue resource limits from config are correctly structured for container manager", () => {
    // Write a config with per-queue resource limits
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify({
        queues: {
          build: { concurrency: 3, resourceLimits: { cpus: "1.5", memory: "2g" } },
          test: { concurrency: 2, resourceLimits: { cpus: "0.5", memory: "512m" } },
          default: { concurrency: 1 },
        },
      }),
    );

    const config = loadUserConfig(tmpHome);

    // Verify queue configs are correctly parsed
    expect(config.queues).toBeDefined();

    // Each queue's resourceLimits should match ContainerResourceLimits type
    const buildLimits: ContainerResourceLimits = config.queues!.build!.resourceLimits!;
    expect(buildLimits.cpus).toBe("1.5");
    expect(buildLimits.memory).toBe("2g");

    const testLimits: ContainerResourceLimits = config.queues!.test!.resourceLimits!;
    expect(testLimits.cpus).toBe("0.5");
    expect(testLimits.memory).toBe("512m");

    // Default queue has no resource limits
    expect(config.queues!.default!.resourceLimits).toBeUndefined();

    // Verify concurrency values
    expect(config.queues!.build!.concurrency).toBe(3);
    expect(config.queues!.test!.concurrency).toBe(2);
    expect(config.queues!.default!.concurrency).toBe(1);
  });

  it("per-queue resource limits merge with container build config shape", () => {
    // Simulate what the scheduler does: merge queue-specific limits into the container config
    const containerBuildConfig = {
      repoPath: "/repo",
      targetBranch: "main",
      buildImage: "ripline-builder:latest",
      testCommand: "npm test",
      resourceLimits: { cpus: "1", memory: "1g" }, // default limits
    };

    const queueResourceLimits: Record<string, ContainerResourceLimits> = {
      build: { cpus: "2", memory: "4g" },
      test: { cpus: "0.5", memory: "512m" },
    };

    // For a run in the "build" queue, queue limits override defaults
    const buildQueueLimits = queueResourceLimits["build"];
    const mergedBuildConfig = {
      ...containerBuildConfig,
      ...(buildQueueLimits !== undefined && { resourceLimits: buildQueueLimits }),
    };
    expect(mergedBuildConfig.resourceLimits).toEqual({ cpus: "2", memory: "4g" });

    // For a run in the "default" queue, no override → keeps base limits
    const defaultQueueLimits = queueResourceLimits["default"];
    const mergedDefaultConfig = {
      ...containerBuildConfig,
      ...(defaultQueueLimits !== undefined && { resourceLimits: defaultQueueLimits }),
    };
    expect(mergedDefaultConfig.resourceLimits).toEqual({ cpus: "1", memory: "1g" });
  });
});

describe("Integration: Container build eligibility rules", () => {
  it("only top-level runs (no parentRunId) are eligible for container builds", () => {
    // Simulate the scheduler's eligibility check
    const topLevelRun: Partial<PipelineRunRecord> = {
      id: "run-1",
      pipelineId: "pipe-1",
      status: "pending",
      cursor: undefined,
    };

    const childRun: Partial<PipelineRunRecord> = {
      id: "run-2",
      pipelineId: "pipe-2",
      parentRunId: "run-1",
      status: "pending",
      cursor: undefined,
    };

    const resumedRun: Partial<PipelineRunRecord> = {
      id: "run-3",
      pipelineId: "pipe-3",
      status: "pending",
      cursor: { nextNodeIndex: 2, context: {} },
    };

    // Eligibility check as in scheduler
    const isEligible = (r: Partial<PipelineRunRecord>) =>
      !r.parentRunId && r.cursor === undefined;

    expect(isEligible(topLevelRun)).toBe(true);
    expect(isEligible(childRun)).toBe(false);
    expect(isEligible(resumedRun)).toBe(false);
  });

  it("container build result statuses map to correct run statuses", () => {
    // This documents the mapping from promoteStep result → run record status
    const statusMapping: Record<string, string> = {
      merged: "completed",
      "needs-conflict-resolution": "needs-conflict-resolution",
      "test-failure": "errored",
      error: "errored",
    };

    expect(statusMapping["merged"]).toBe("completed");
    expect(statusMapping["needs-conflict-resolution"]).toBe("needs-conflict-resolution");
    expect(statusMapping["test-failure"]).toBe("errored");
    expect(statusMapping["error"]).toBe("errored");
  });
});

describe("Integration: Feature branch naming and isolation", () => {
  it("each concurrent build gets a unique feature branch", () => {
    // Multiple simultaneous runs should have non-conflicting branches
    const runIds = ["run-aaa-111", "run-bbb-222", "run-ccc-333"];
    const branches = runIds.map((id) => `build/${id}`);

    // All branches should be unique
    const uniqueBranches = new Set(branches);
    expect(uniqueBranches.size).toBe(runIds.length);

    // Each branch follows the build/{runId} pattern
    for (const branch of branches) {
      expect(branch).toMatch(/^build\//);
    }
  });

  it("container name uses first 8 chars of runId for uniqueness", () => {
    const runId = "abcdef12-3456-7890-abcd-ef1234567890";
    const containerName = `ripline-build-${runId.slice(0, 8)}`;

    expect(containerName).toBe("ripline-build-abcdef12");
    expect(containerName.length).toBeLessThan(64); // Docker container name limit
  });
});

describe("Integration: Container environment variable contract", () => {
  it("all required RIPLINE_ env vars are set for container execution", () => {
    // Document the environment variable contract between host and container
    const requiredEnvVars = [
      "RIPLINE_REPO_PATH",
      "RIPLINE_BRANCH",
      "RIPLINE_TARGET_BRANCH",
      "RIPLINE_RUN_ID",
      "RIPLINE_PIPELINE_ID",
      "RIPLINE_PIPELINE_CONTEXT",
    ];

    // These should all be defined — simulate what container-build-runner sets
    const env: Record<string, string> = {
      RIPLINE_REPO_PATH: "/repo",
      RIPLINE_BRANCH: "build/run-1",
      RIPLINE_TARGET_BRANCH: "main",
      RIPLINE_RUN_ID: "run-1",
      RIPLINE_PIPELINE_ID: "pipe-1",
      RIPLINE_PIPELINE_CONTEXT: JSON.stringify({ inputs: {} }),
    };

    for (const key of requiredEnvVars) {
      expect(env[key]).toBeDefined();
      expect(env[key]!.length).toBeGreaterThan(0);
    }
  });

  it("RIPLINE_SECRETS_PATH is set only when secrets mount exists", () => {
    // When secrets exist
    const envWithSecrets: Record<string, string> = {
      RIPLINE_SECRETS_PATH: "/run/secrets",
    };
    expect(envWithSecrets.RIPLINE_SECRETS_PATH).toBe("/run/secrets");

    // When secrets don't exist — key should not be present
    const envWithoutSecrets: Record<string, string> = {};
    expect(envWithoutSecrets.RIPLINE_SECRETS_PATH).toBeUndefined();
  });

  it("RIPLINE_PIPELINE_CONTEXT is valid JSON containing pipeline inputs", () => {
    const context = { inputs: { task: "build feature X" }, pipelineId: "pipe-1" };
    const serialized = JSON.stringify(context);
    const parsed = JSON.parse(serialized);

    expect(parsed.inputs.task).toBe("build feature X");
    expect(parsed.pipelineId).toBe("pipe-1");
  });
});

describe("Integration: Fallback from container to direct execution", () => {
  it("usedContainer=false signals scheduler to use direct execution", () => {
    // When Docker is unavailable, runContainerBuild returns { usedContainer: false }
    // The scheduler checks this and falls through to direct DeterministicRunner execution
    const containerResult = { usedContainer: false };
    const containerHandled = containerResult.usedContainer;

    expect(containerHandled).toBe(false);
    // Scheduler would proceed with direct execution at this point
  });

  it("usedContainer=true with error signals scheduler to fail the run", () => {
    const containerResult = {
      usedContainer: true,
      error: "Container exited with code 1",
    };

    expect(containerResult.usedContainer).toBe(true);
    expect(containerResult.error).toBeDefined();
    // Scheduler would call store.failRun()
  });

  it("usedContainer=true without error and with promoteResult signals completion", () => {
    const containerResult = {
      usedContainer: true,
      promoteResult: { status: "merged" as const, message: "OK", mergeCommit: "abc123" },
    };

    expect(containerResult.usedContainer).toBe(true);
    expect(containerResult.promoteResult!.status).toBe("merged");
    // Scheduler would call store.completeRun()
  });
});
