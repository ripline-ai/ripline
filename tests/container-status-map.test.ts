/**
 * Tests for container-status-map — the authoritative mapping between
 * ContainerBuildResult and PipelineRunStatus.
 *
 * Covers Story 6 acceptance criteria:
 *  - Pipeline status in Wintermute correctly reflects container-based execution states
 *  - A failed build is cleaned up and marked as failed with accessible logs
 *  - A timed-out build is killed, cleaned up, and marked as timed-out
 *  - Two concurrent overlapping builds: first to finish merges, second is flagged as needs-conflict-resolution
 *
 * Also validates:
 *  - Every code path in mapContainerBuildToRunStatus
 *  - PROMOTE_STATUS_TO_RUN_STATUS lookup table matches the function's behavior
 *  - preserveFeatureBranch correctness for each scenario
 *  - Edge cases (no promoteResult, no containerResult, etc.)
 */

import { describe, it, expect } from "vitest";
import {
  mapContainerBuildToRunStatus,
  PROMOTE_STATUS_TO_RUN_STATUS,
  type ContainerStatusMapping,
} from "../src/container-status-map.js";
import type { ContainerBuildResult } from "../src/container-build-runner.js";
import type { ContainerResult } from "../src/container-manager.js";
import type { PromoteStepResult } from "../src/promote-step.js";

/* ── Helpers ─────────────────────────────────────────────────────────── */

function makeContainerResult(overrides?: Partial<ContainerResult>): ContainerResult {
  return {
    containerId: "abc123def456",
    exitCode: 0,
    timedOut: false,
    logFile: "/repo/.ripline/runs/run-1/container.log",
    ...overrides,
  };
}

function makePromoteResult(overrides?: Partial<PromoteStepResult>): PromoteStepResult {
  return {
    status: "merged",
    message: "Successfully merged 'build/run-1' into 'main'",
    mergeCommit: "deadbeef12345678",
    ...overrides,
  };
}

/* ── Docker unavailable (fallback) ───────────────────────────────────── */

describe("mapContainerBuildToRunStatus — Docker unavailable", () => {
  it("returns null status when Docker is unavailable (caller handles fallback)", () => {
    const result: ContainerBuildResult = { usedContainer: false };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBeNull();
    expect(mapping.usedContainer).toBe(false);
    expect(mapping.preserveFeatureBranch).toBe(false);
    expect(mapping.summary).toContain("fell back");
    expect(mapping.error).toBeUndefined();
  });
});

/* ── Container spawn / branch creation failure ───────────────────────── */

describe("mapContainerBuildToRunStatus — spawn failure (no containerResult)", () => {
  it("returns errored when container spawn fails before execution", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      error: "Container spawn failed: image not found",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.usedContainer).toBe(true);
    expect(mapping.error).toContain("Container spawn failed");
    expect(mapping.preserveFeatureBranch).toBe(false);
  });

  it("returns errored when feature branch creation fails", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      error: "Failed to create feature branch: checkout failed",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.error).toContain("Failed to create feature branch");
    expect(mapping.preserveFeatureBranch).toBe(false);
  });
});

/* ── Container timed out ─────────────────────────────────────────────── */

describe("mapContainerBuildToRunStatus — container timeout", () => {
  it("returns errored with preserveFeatureBranch when container times out", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult({ exitCode: null, timedOut: true }),
      featureBranch: "build/run-timeout",
      error: "Container timed out after 600s",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.usedContainer).toBe(true);
    expect(mapping.preserveFeatureBranch).toBe(true);
    expect(mapping.summary).toContain("timed out");
    expect(mapping.error).toContain("timed out");
  });

  it("includes log file path in summary for timeout", () => {
    const logFile = "/repo/.ripline/runs/run-to/container.log";
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult({ exitCode: null, timedOut: true, logFile }),
      featureBranch: "build/run-to",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.summary).toContain(logFile);
  });
});

/* ── Container exited non-zero (build failure) ───────────────────────── */

describe("mapContainerBuildToRunStatus — non-zero exit", () => {
  it("returns errored with preserveFeatureBranch on exit code 1", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult({ exitCode: 1 }),
      featureBranch: "build/run-fail",
      error: "Container exited with code 1. Logs available at: /path/to/log",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.preserveFeatureBranch).toBe(true);
    expect(mapping.error).toContain("Container exited with code 1");
  });

  it("handles arbitrary non-zero exit codes", () => {
    for (const code of [2, 127, 137, 255]) {
      const result: ContainerBuildResult = {
        usedContainer: true,
        containerResult: makeContainerResult({ exitCode: code }),
        featureBranch: "build/run-x",
      };
      const mapping = mapContainerBuildToRunStatus(result);

      expect(mapping.status).toBe("errored");
      expect(mapping.summary).toContain(`code ${code}`);
    }
  });

  it("includes log file path in summary for non-zero exit", () => {
    const logFile = "/repo/.ripline/runs/run-e/container.log";
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult({ exitCode: 1, logFile }),
      featureBranch: "build/run-e",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.summary).toContain(logFile);
  });
});

/* ── Container exit 0 + promote "merged" ─────────────────────────────── */

describe("mapContainerBuildToRunStatus — container success + merged", () => {
  it("returns completed when promote merges successfully", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult(),
      promoteResult: makePromoteResult(),
      featureBranch: "build/run-ok",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("completed");
    expect(mapping.usedContainer).toBe(true);
    expect(mapping.preserveFeatureBranch).toBe(false);
    expect(mapping.error).toBeUndefined();
    expect(mapping.summary).toContain("build/run-ok");
  });

  it("does not preserve feature branch on successful merge", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult(),
      promoteResult: makePromoteResult({ status: "merged" }),
      featureBranch: "build/run-merged",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.preserveFeatureBranch).toBe(false);
  });
});

/* ── Container exit 0 + promote "needs-conflict-resolution" ─────────────────────── */

describe("mapContainerBuildToRunStatus — container success + needs-conflict-resolution", () => {
  it("returns needs-conflict-resolution status and preserves feature branch", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult(),
      promoteResult: makePromoteResult({
        status: "needs-conflict-resolution",
        message: "Merge conflict detected when merging 'build/run-mc' into 'main'. Branch preserved.",
        mergeCommit: undefined,
        gitOutput: "CONFLICT (content): src/index.ts",
      }),
      featureBranch: "build/run-mc",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("needs-conflict-resolution");
    expect(mapping.preserveFeatureBranch).toBe(true);
    expect(mapping.error).toContain("Merge conflict");
  });
});

/* ── Container exit 0 + promote "test-failure" ───────────────────────── */

describe("mapContainerBuildToRunStatus — container success + test-failure", () => {
  it("returns errored and preserves feature branch when tests fail", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult(),
      promoteResult: makePromoteResult({
        status: "test-failure",
        message: "Test suite failed on 'build/run-tf'. Merge aborted.",
        mergeCommit: undefined,
        testOutput: "FAIL src/foo.test.ts",
      }),
      featureBranch: "build/run-tf",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.preserveFeatureBranch).toBe(true);
    expect(mapping.error).toContain("Test suite failed");
  });
});

/* ── Container exit 0 + promote "error" ──────────────────────────────── */

describe("mapContainerBuildToRunStatus — container success + promote error", () => {
  it("returns errored without preserving feature branch on git error", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult(),
      promoteResult: makePromoteResult({
        status: "error",
        message: "Failed to checkout target branch 'main'",
        mergeCommit: undefined,
      }),
      featureBranch: "build/run-ge",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.preserveFeatureBranch).toBe(false);
    expect(mapping.error).toContain("Failed to checkout");
  });
});

/* ── Edge cases ──────────────────────────────────────────────────────── */

describe("mapContainerBuildToRunStatus — edge cases", () => {
  it("container exit 0 with error but no promoteResult returns errored", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult({ exitCode: 0 }),
      error: "promoteStep failed: unexpected error",
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("errored");
    expect(mapping.error).toContain("promoteStep failed");
  });

  it("container exit 0 with no promoteResult and no error returns completed", () => {
    const result: ContainerBuildResult = {
      usedContainer: true,
      containerResult: makeContainerResult({ exitCode: 0 }),
    };
    const mapping = mapContainerBuildToRunStatus(result);

    expect(mapping.status).toBe("completed");
    expect(mapping.summary).toContain("no promote step");
  });
});

/* ── PROMOTE_STATUS_TO_RUN_STATUS lookup table ───────────────────────── */

describe("PROMOTE_STATUS_TO_RUN_STATUS", () => {
  it("maps 'merged' to 'completed'", () => {
    expect(PROMOTE_STATUS_TO_RUN_STATUS["merged"]).toBe("completed");
  });

  it("maps 'needs-conflict-resolution' to 'needs-conflict-resolution'", () => {
    expect(PROMOTE_STATUS_TO_RUN_STATUS["needs-conflict-resolution"]).toBe("needs-conflict-resolution");
  });

  it("maps 'test-failure' to 'errored'", () => {
    expect(PROMOTE_STATUS_TO_RUN_STATUS["test-failure"]).toBe("errored");
  });

  it("maps 'error' to 'errored'", () => {
    expect(PROMOTE_STATUS_TO_RUN_STATUS["error"]).toBe("errored");
  });

  it("covers all four promote statuses", () => {
    expect(Object.keys(PROMOTE_STATUS_TO_RUN_STATUS).sort()).toEqual([
      "error",
      "merged",
      "needs-conflict-resolution",
      "test-failure",
    ]);
  });

  it("matches mapContainerBuildToRunStatus for every promote status", () => {
    const promoteStatuses: Array<PromoteStepResult["status"]> = [
      "merged",
      "needs-conflict-resolution",
      "test-failure",
      "error",
    ];

    for (const status of promoteStatuses) {
      const result: ContainerBuildResult = {
        usedContainer: true,
        containerResult: makeContainerResult(),
        promoteResult: makePromoteResult({ status, message: `Test ${status}` }),
        featureBranch: `build/run-${status}`,
      };
      const mapping = mapContainerBuildToRunStatus(result);

      expect(mapping.status).toBe(PROMOTE_STATUS_TO_RUN_STATUS[status]);
    }
  });
});

/* ── preserveFeatureBranch correctness across all scenarios ──────────── */

describe("preserveFeatureBranch correctness", () => {
  const scenarios: Array<{
    name: string;
    result: ContainerBuildResult;
    expectedPreserve: boolean;
  }> = [
    {
      name: "Docker unavailable",
      result: { usedContainer: false },
      expectedPreserve: false,
    },
    {
      name: "spawn failure",
      result: { usedContainer: true, error: "spawn failed" },
      expectedPreserve: false,
    },
    {
      name: "timeout",
      result: {
        usedContainer: true,
        containerResult: makeContainerResult({ timedOut: true, exitCode: null }),
        featureBranch: "build/x",
      },
      expectedPreserve: true,
    },
    {
      name: "non-zero exit",
      result: {
        usedContainer: true,
        containerResult: makeContainerResult({ exitCode: 1 }),
        featureBranch: "build/x",
      },
      expectedPreserve: true,
    },
    {
      name: "merged",
      result: {
        usedContainer: true,
        containerResult: makeContainerResult(),
        promoteResult: makePromoteResult({ status: "merged" }),
        featureBranch: "build/x",
      },
      expectedPreserve: false,
    },
    {
      name: "needs-conflict-resolution",
      result: {
        usedContainer: true,
        containerResult: makeContainerResult(),
        promoteResult: makePromoteResult({ status: "needs-conflict-resolution" }),
        featureBranch: "build/x",
      },
      expectedPreserve: true,
    },
    {
      name: "test-failure",
      result: {
        usedContainer: true,
        containerResult: makeContainerResult(),
        promoteResult: makePromoteResult({ status: "test-failure" }),
        featureBranch: "build/x",
      },
      expectedPreserve: true,
    },
    {
      name: "promote error",
      result: {
        usedContainer: true,
        containerResult: makeContainerResult(),
        promoteResult: makePromoteResult({ status: "error" }),
        featureBranch: "build/x",
      },
      expectedPreserve: false,
    },
  ];

  for (const { name, result, expectedPreserve } of scenarios) {
    it(`preserveFeatureBranch is ${expectedPreserve} for: ${name}`, () => {
      const mapping = mapContainerBuildToRunStatus(result);
      expect(mapping.preserveFeatureBranch).toBe(expectedPreserve);
    });
  }
});

/* ── ContainerStatusMapping shape validation ─────────────────────────── */

describe("ContainerStatusMapping shape", () => {
  it("always includes status, usedContainer, summary, and preserveFeatureBranch", () => {
    const scenarios: ContainerBuildResult[] = [
      { usedContainer: false },
      { usedContainer: true, error: "fail" },
      {
        usedContainer: true,
        containerResult: makeContainerResult(),
        promoteResult: makePromoteResult(),
        featureBranch: "build/x",
      },
    ];

    for (const result of scenarios) {
      const mapping = mapContainerBuildToRunStatus(result);
      expect(mapping).toHaveProperty("status");
      expect(mapping).toHaveProperty("usedContainer");
      expect(mapping).toHaveProperty("summary");
      expect(mapping).toHaveProperty("preserveFeatureBranch");
      expect(typeof mapping.usedContainer).toBe("boolean");
      expect(typeof mapping.summary).toBe("string");
      expect(typeof mapping.preserveFeatureBranch).toBe("boolean");
    }
  });
});
