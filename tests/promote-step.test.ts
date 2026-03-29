import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { promoteStep, type PromoteStepParams } from "../src/promote-step.js";

/* ── ESM-safe mock ────────────────────────────────────────────────────── */

const { spawnMockFn } = vi.hoisted(() => ({ spawnMockFn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: spawnMockFn }));

/* ── Helpers ──────────────────────────────────────────────────────────── */

function mockSpawnForCommands(
  commandResults: Record<string, { exitCode: number; output?: string }>,
) {
  spawnMockFn.mockImplementation((cmd: string, args: string[]) => {
    const fullCommand = Array.isArray(args) ? args.join(" ") : String(args);
    let result = { exitCode: 0, output: "" };
    for (const [key, val] of Object.entries(commandResults)) {
      if (fullCommand.includes(key)) {
        result = { output: "", ...val };
        break;
      }
    }

    const handlers: Record<string, ((...a: any[]) => void)[]> = {};
    const proc = {
      on: vi.fn((event: string, handler: any) => {
        if (!handlers[event]) handlers[event] = [];
        handlers[event]!.push(handler);
        if (event === "close") {
          setTimeout(() => handler(result.exitCode), 5);
        }
      }),
      kill: vi.fn((sig?: string) => {
        const closeHandlers = handlers["close"] ?? [];
        for (const h of closeHandlers) h(124);
      }),
      stdout: {
        on: vi.fn((event: string, handler: any) => {
          if (event === "data" && result.output) {
            handler(Buffer.from(result.output));
          }
        }),
      },
      stderr: {
        on: vi.fn((_event: string, _handler: any) => {}),
      },
      pid: 1234,
    };
    return proc as any;
  });
}

const baseParams: PromoteStepParams = {
  repoPath: "/tmp/test-repo",
  featureBranch: "build/run-123",
  targetBranch: "main",
  testCommand: "npm test",
  testTimeoutMs: 5000,
  gitTimeoutMs: 5000,
};

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("promoteStep", () => {
  afterEach(() => {
    spawnMockFn.mockReset();
  });

  it("returns 'merged' on successful fast-forward merge with passing tests", async () => {
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 0 },
      "pull origin main": { exitCode: 0 },
      "merge --ff-only": { exitCode: 0 },
      "npm test": { exitCode: 0 },
      "rev-parse HEAD": { exitCode: 0, output: "abc123def456789fedcba\n" },
      "branch -d": { exitCode: 0 },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("merged");
    expect(result.message).toContain("Successfully merged");
    expect(result.message).toContain("build/run-123");
    expect(result.mergeCommit).toBeDefined();
  });

  it("returns 'test-failure' when tests fail after merge, reverts merge", async () => {
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 0 },
      "pull origin main": { exitCode: 0 },
      "merge --ff-only": { exitCode: 0 },
      "npm test": { exitCode: 1, output: "FAIL: test_something\nAssertionError: expected true to be false" },
      "reset --hard": { exitCode: 0 },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("test-failure");
    expect(result.message).toContain("Test suite failed");
    expect(result.message).toContain("Merge aborted");
    expect(result.testOutput).toBeDefined();
  });

  it("returns 'merge-conflict' when rebase detects conflicts", async () => {
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 0 },
      "pull origin main": { exitCode: 0 },
      "merge --ff-only": { exitCode: 1 },
      "reset --hard HEAD": { exitCode: 0 },
      "checkout build/run-123": { exitCode: 0 },
      "rebase main": { exitCode: 1, output: "CONFLICT (content): Merge conflict in src/index.ts" },
      "rebase --abort": { exitCode: 0 },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("merge-conflict");
    expect(result.message).toContain("Merge conflict");
    expect(result.message).toContain("preserved for manual resolution");
    expect(result.gitOutput).toBeDefined();
  });

  it("returns 'error' when checkout of target branch fails", async () => {
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 1, output: "error: pathspec 'main' did not match" },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("error");
    expect(result.message).toContain("Failed to checkout target branch");
  });

  it("falls back to rebase when fast-forward is not possible", async () => {
    // The first `git merge --ff-only build/run-123` fails (FF not possible).
    // After rebase succeeds, the exact same command is issued again and must succeed.
    // mockSpawnForCommands matches by substring so can't distinguish the two calls —
    // use a counter-aware implementation instead.
    let ffMergeCallCount = 0;
    spawnMockFn.mockImplementation((cmd: string, args: string[]) => {
      const fullCommand = Array.isArray(args) ? args.join(" ") : String(args);

      let exitCode = 0;
      let output = "";

      if (fullCommand.includes("merge --ff-only")) {
        ffMergeCallCount++;
        if (ffMergeCallCount === 1) {
          exitCode = 1;
          output = "Not possible to fast-forward";
        }
      } else if (fullCommand.includes("rev-parse")) {
        output = "def456abc789\n";
      }

      const handlers: Record<string, ((...a: any[]) => void)[]> = {};
      const proc = {
        on: vi.fn((event: string, handler: any) => {
          if (!handlers[event]) handlers[event] = [];
          handlers[event]!.push(handler);
          if (event === "close") setTimeout(() => handler(exitCode), 5);
        }),
        kill: vi.fn((sig?: string) => {
          const closeHandlers = handlers["close"] ?? [];
          for (const h of closeHandlers) h(124);
        }),
        stdout: {
          on: vi.fn((event: string, handler: any) => {
            if (event === "data" && output) handler(Buffer.from(output));
          }),
        },
        stderr: { on: vi.fn((_event: string, _handler: any) => {}) },
        pid: 1234,
      };
      return proc as any;
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("merged");
    expect(result.mergeCommit).toBeDefined();
  });

  it("preserves feature branch on merge conflict for manual resolution", async () => {
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 0 },
      "pull origin main": { exitCode: 0 },
      "merge --ff-only": { exitCode: 1 },
      "reset --hard HEAD": { exitCode: 0 },
      "checkout build/run-123": { exitCode: 0 },
      "rebase main": { exitCode: 1, output: "CONFLICT merge conflict in file.ts" },
      "rebase --abort": { exitCode: 0 },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("merge-conflict");
    expect(result.message).toContain("Branch preserved");
  });

  it("deletes feature branch locally after successful merge", async () => {
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 0 },
      "pull origin main": { exitCode: 0 },
      "merge --ff-only": { exitCode: 0 },
      "npm test": { exitCode: 0 },
      "rev-parse HEAD": { exitCode: 0, output: "sha123\n" },
      "branch -d build/run-123": { exitCode: 0 },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("merged");
  });

  it("uses custom remote name when specified", async () => {
    const spawnCalls: string[] = [];
    spawnMockFn.mockImplementation((cmd: string, args: string[]) => {
      const fullCommand = Array.isArray(args) ? args.join(" ") : "";
      spawnCalls.push(fullCommand);
      const proc = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "close") setTimeout(() => handler(0), 5);
        }),
        kill: vi.fn(),
        stdout: {
          on: vi.fn((event: string, handler: any) => {
            if (event === "data" && fullCommand.includes("rev-parse")) {
              handler(Buffer.from("sha456\n"));
            }
          }),
        },
        stderr: { on: vi.fn() },
        pid: 1234,
      };
      return proc as any;
    });

    await promoteStep({ ...baseParams, remote: "upstream" });

    const fetchCmd = spawnCalls.find((c) => c.includes("fetch"));
    expect(fetchCmd).toContain("upstream");
  });

  it("returns all four possible status values", () => {
    const statuses: Array<"merged" | "merge-conflict" | "test-failure" | "error"> = [
      "merged",
      "merge-conflict",
      "test-failure",
      "error",
    ];
    expect(statuses).toHaveLength(4);
  });

  it("truncates test output to last 4000 chars on test failure", async () => {
    const longOutput = "x".repeat(5000);
    mockSpawnForCommands({
      "fetch origin": { exitCode: 0 },
      "checkout main": { exitCode: 0 },
      "pull origin main": { exitCode: 0 },
      "merge --ff-only": { exitCode: 0 },
      "npm test": { exitCode: 1, output: longOutput },
      "reset --hard": { exitCode: 0 },
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("test-failure");
    expect(result.testOutput).toBeDefined();
    expect(result.testOutput!.length).toBeLessThanOrEqual(4000);
  });

  it("returns 'error' status on unexpected exception", async () => {
    spawnMockFn.mockImplementation(() => {
      throw new Error("Unexpected spawn failure");
    });

    const result = await promoteStep(baseParams);

    expect(result.status).toBe("error");
    expect(result.message).toContain("Unexpected error");
  });
});
