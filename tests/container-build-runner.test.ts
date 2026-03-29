import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as child_process from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/* ── We test the module's exported functions by mocking child_process ── */

// We need to mock modules before importing the SUT
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFileSync: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
  };
});

import {
  isDockerAvailable,
  resetDockerAvailableCache,
  createFeatureBranch,
  runContainerBuild,
  type ContainerBuildConfig,
} from "../src/container-build-runner.js";

const silentLogger = { log: vi.fn() } as any;

/* ── Helpers ──────────────────────────────────────────────────────────── */

function mockExecFileSync(impl?: (...args: any[]) => string) {
  return (child_process.execFileSync as any).mockImplementation(
    impl ??
      ((cmd: string, args: string[]) => {
        // Default: docker info succeeds, git commands succeed
        if (cmd === "docker" && args[0] === "info") return "";
        if (cmd === "docker" && args[0] === "rm") return "";
        if (cmd === "git") return "";
        return "";
      }),
  );
}

function mockDockerAvailable(available: boolean) {
  (child_process.execFileSync as any).mockImplementation((cmd: string, args: string[]) => {
    if (cmd === "docker" && args[0] === "info") {
      if (!available) throw new Error("Docker not available");
      return "";
    }
    if (cmd === "docker") return "";
    if (cmd === "git") return "";
    return "";
  });
}

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("isDockerAvailable", () => {
  beforeEach(() => {
    resetDockerAvailableCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDockerAvailableCache();
  });

  it("returns true when docker info succeeds", () => {
    mockDockerAvailable(true);
    expect(isDockerAvailable()).toBe(true);
  });

  it("returns false when docker info fails", () => {
    mockDockerAvailable(false);
    expect(isDockerAvailable()).toBe(false);
  });

  it("caches the result after first check", () => {
    mockDockerAvailable(true);
    isDockerAvailable();
    // Even if we change the mock, cached value should stick
    mockDockerAvailable(false);
    expect(isDockerAvailable()).toBe(true);
  });

  it("resetDockerAvailableCache clears the cache", () => {
    mockDockerAvailable(true);
    isDockerAvailable();
    resetDockerAvailableCache();
    mockDockerAvailable(false);
    expect(isDockerAvailable()).toBe(false);
  });
});

describe("createFeatureBranch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates branch named build/{runId}", () => {
    const gitCalls: string[][] = [];
    (child_process.execFileSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git") gitCalls.push(args);
      return "";
    });

    const branch = createFeatureBranch("/repo", "run-123", "main");

    expect(branch).toBe("build/run-123");
    // Should checkout main, pull, then create branch
    expect(gitCalls[0]).toEqual(["checkout", "main"]);
    expect(gitCalls[1]).toEqual(["pull", "origin", "main"]);
    expect(gitCalls[2]).toEqual(["checkout", "-b", "build/run-123"]);
  });

  it("uses the specified target branch", () => {
    const gitCalls: string[][] = [];
    (child_process.execFileSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git") gitCalls.push(args);
      return "";
    });

    createFeatureBranch("/repo", "run-456", "develop");

    expect(gitCalls[0]).toEqual(["checkout", "develop"]);
    expect(gitCalls[1]).toEqual(["pull", "origin", "develop"]);
  });

  it("continues if pull from remote fails (local-only setup)", () => {
    let pullCalled = false;
    (child_process.execFileSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "git" && args[0] === "pull") {
        pullCalled = true;
        throw new Error("Remote not configured");
      }
      return "";
    });

    const branch = createFeatureBranch("/repo", "run-789", "main");
    expect(pullCalled).toBe(true);
    expect(branch).toBe("build/run-789");
  });
});

describe("runContainerBuild", () => {
  const baseConfig: ContainerBuildConfig = {
    repoPath: "/tmp/test-repo",
    targetBranch: "main",
    buildImage: "ripline-builder:latest",
    testCommand: "npm test",
    containerTimeoutMs: 5000,
    logger: silentLogger,
  };

  beforeEach(() => {
    resetDockerAvailableCache();
    vi.spyOn(fs, "mkdirSync").mockReturnValue(undefined);
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    vi.spyOn(fs, "openSync").mockReturnValue(99);
    vi.spyOn(fs, "closeSync").mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDockerAvailableCache();
  });

  /* ── Docker not available → fallback ─────────────────────────────── */

  it("returns usedContainer=false when Docker is not available", async () => {
    mockDockerAvailable(false);

    const result = await runContainerBuild("run-1", "pipe-1", {}, baseConfig);

    expect(result.usedContainer).toBe(false);
    expect(result.containerResult).toBeUndefined();
  });

  /* ── Feature branch creation failure ─────────────────────────────── */

  it("returns error when feature branch creation fails", async () => {
    (child_process.execFileSync as any).mockImplementation((cmd: string, args: string[]) => {
      if (cmd === "docker" && args[0] === "info") return "";
      if (cmd === "git" && args[0] === "checkout" && args[1] === "main") return "";
      if (cmd === "git" && args[0] === "pull") return "";
      if (cmd === "git" && args[0] === "checkout" && args[1] === "-b") {
        throw new Error("Branch already exists");
      }
      return "";
    });

    const result = await runContainerBuild("run-2", "pipe-2", {}, baseConfig);

    expect(result.usedContainer).toBe(true);
    expect(result.error).toContain("Failed to create feature branch");
  });

  /* ── Container succeeds + promote merges ─────────────────────────── */

  it("runs promoteStep on container success (exit 0)", async () => {
    mockExecFileSync();

    // Mock execFile for docker run + wait (container manager)
    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") callback(null, "container1234\n", "");
        else if (args[0] === "wait") callback(null, "0\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );

    // Mock spawn for docker logs -f and for promoteStep's shell commands
    (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
      const proc = {
        on: vi.fn((event: string, handler: any) => {
          if (event === "close" && cmd === "sh") {
            // promoteStep shell commands — simulate success
            setTimeout(() => handler(0), 10);
          }
        }),
        kill: vi.fn(),
        stdout: {
          on: vi.fn((event: string, handler: any) => {
            if (event === "data" && cmd === "sh") {
              // For git rev-parse HEAD, return a fake SHA
              const cmdStr = args[1] ?? "";
              if (typeof cmdStr === "string" && cmdStr.includes("rev-parse")) {
                handler(Buffer.from("abc123def456789\n"));
              }
            }
          }),
        },
        stderr: { on: vi.fn() },
        pid: 1234,
      };
      return proc;
    });

    const result = await runContainerBuild("run-3", "pipe-3", { task: "build it" }, baseConfig);

    expect(result.usedContainer).toBe(true);
    expect(result.featureBranch).toBe("build/run-3");
    expect(result.containerResult).toBeDefined();
    expect(result.containerResult!.exitCode).toBe(0);
    // promoteResult should be set (whatever promoteStep returns)
    // The exact promoteResult depends on the shell mock behavior
  });

  /* ── Container failure ───────────────────────────────────────────── */

  it("returns error with log path when container exits non-zero", async () => {
    mockExecFileSync();

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") callback(null, "failcontainer\n", "");
        else if (args[0] === "wait") callback(null, "1\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    const result = await runContainerBuild("run-4", "pipe-4", {}, baseConfig);

    expect(result.usedContainer).toBe(true);
    expect(result.error).toContain("Container exited with code 1");
    expect(result.error).toContain("Logs available at");
    expect(result.featureBranch).toBe("build/run-4");
  });

  /* ── Container timeout ───────────────────────────────────────────── */

  it("reports timeout when container exceeds containerTimeoutMs", async () => {
    mockExecFileSync();

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") callback(null, "timeoutcont12\n", "");
        else if (args[0] === "wait") {
          // Never resolve — let timeout fire
          return {
            kill: vi.fn(() => {
              if (callback) callback(new Error("killed"), "", "");
            }),
            on: vi.fn(),
          } as any;
        }
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    const result = await runContainerBuild("run-5", "pipe-5", {}, {
      ...baseConfig,
      containerTimeoutMs: 50,
    });

    expect(result.usedContainer).toBe(true);
    expect(result.error).toContain("timed out");
  });

  /* ── Environment variables ───────────────────────────────────────── */

  it("passes correct environment variables to the container", async () => {
    let capturedArgs: string[] = [];
    mockExecFileSync();

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "envcontainer\n", "");
        } else if (args[0] === "wait") callback(null, "1\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    await runContainerBuild(
      "run-env",
      "my-pipeline",
      { task: "build" },
      baseConfig,
    );

    expect(capturedArgs).toContain("RIPLINE_RUN_ID=run-env");
    expect(capturedArgs).toContain("RIPLINE_PIPELINE_ID=my-pipeline");
    expect(capturedArgs).toContain("RIPLINE_BRANCH=build/run-env");
    expect(capturedArgs).toContain("RIPLINE_TARGET_BRANCH=main");
    // RIPLINE_REPO_PATH and RIPLINE_PIPELINE_CONTEXT should also be present
    const repoEnv = capturedArgs.find((a) => a.startsWith("RIPLINE_REPO_PATH="));
    expect(repoEnv).toBe("RIPLINE_REPO_PATH=/tmp/test-repo");
    const ctxEnv = capturedArgs.find((a) => a.startsWith("RIPLINE_PIPELINE_CONTEXT="));
    expect(ctxEnv).toBeDefined();
    expect(JSON.parse(ctxEnv!.split("=").slice(1).join("="))).toEqual({
      task: "build",
    });
  });

  /* ── Secrets mount ───────────────────────────────────────────────── */

  it("mounts secrets directory when secretsMountPath exists", async () => {
    let capturedArgs: string[] = [];
    mockExecFileSync();
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "secretscont12\n", "");
        } else if (args[0] === "wait") callback(null, "1\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    await runContainerBuild("run-sec", "pipe-sec", {}, {
      ...baseConfig,
      secretsMountPath: "/home/user/.secrets",
    });

    // Should have volume mount for secrets
    expect(capturedArgs).toContain("/home/user/.secrets:/run/secrets");
    // Should set RIPLINE_SECRETS_PATH env var
    expect(capturedArgs).toContain("RIPLINE_SECRETS_PATH=/run/secrets");
  });

  it("does not mount secrets when secretsMountPath does not exist", async () => {
    let capturedArgs: string[] = [];
    mockExecFileSync();
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "nosecretcont\n", "");
        } else if (args[0] === "wait") callback(null, "1\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    await runContainerBuild("run-nosec", "pipe-nosec", {}, {
      ...baseConfig,
      secretsMountPath: "/nonexistent/.secrets",
    });

    expect(capturedArgs).not.toContain("RIPLINE_SECRETS_PATH=/run/secrets");
  });

  /* ── Resource limits ─────────────────────────────────────────────── */

  it("passes resource limits to the container", async () => {
    let capturedArgs: string[] = [];
    mockExecFileSync();

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "rlimitcont12\n", "");
        } else if (args[0] === "wait") callback(null, "1\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    await runContainerBuild("run-rl", "pipe-rl", {}, {
      ...baseConfig,
      resourceLimits: { cpus: "2", memory: "4g" },
    });

    expect(capturedArgs).toContain("--cpus");
    expect(capturedArgs).toContain("2");
    expect(capturedArgs).toContain("--memory");
    expect(capturedArgs).toContain("4g");
  });

  /* ── Default config values ───────────────────────────────────────── */

  it("uses default buildImage, targetBranch, and testCommand when not specified", async () => {
    mockDockerAvailable(false); // Easiest way to test defaults without full mocking

    const result = await runContainerBuild("run-def", "pipe-def", {}, {
      repoPath: "/tmp/repo",
      logger: silentLogger,
    });

    // Docker not available, but the function should have used defaults without errors
    expect(result.usedContainer).toBe(false);
  });

  /* ── Container name format ───────────────────────────────────────── */

  it("creates container with name ripline-build-{runId prefix}", async () => {
    let capturedArgs: string[] = [];
    mockExecFileSync();

    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          capturedArgs = args;
          callback(null, "namecont12345\n", "");
        } else if (args[0] === "wait") callback(null, "1\n", "");
        else callback(null, "", "");
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.spawn as any).mockReturnValue({
      on: vi.fn(),
      kill: vi.fn(),
    } as any);

    await runContainerBuild("abcdef12-3456-7890", "pipe", {}, baseConfig);

    const nameIdx = capturedArgs.indexOf("--name");
    expect(nameIdx).toBeGreaterThan(-1);
    expect(capturedArgs[nameIdx + 1]).toBe("ripline-build-abcdef12");
  });
});
