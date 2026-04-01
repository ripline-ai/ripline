/**
 * Container node execution tests.
 *
 * Verifies that the container field on pipeline nodes and pipeline definitions
 * wires up correctly: container lifecycle (spawn → exec → cleanup) works for
 * build_from_plan and bug_fix-style pipelines in stub mode (no real Docker or
 * Claude Code needed).
 *
 * Strategy: mock child_process to simulate Docker CLI; use in-memory store and
 * stub agent runner; confirm container pool acquires, executes, and releases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process before any imports that use it
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(),
    execFileSync: vi.fn(),
    spawn: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    appendFileSync: vi.fn().mockReturnValue(undefined),
    mkdirSync: vi.fn().mockReturnValue(undefined),
    openSync: vi.fn().mockReturnValue(99),
    closeSync: vi.fn().mockReturnValue(undefined),
    existsSync: vi.fn().mockReturnValue(true),
  };
});

import * as child_process from "node:child_process";
import fs from "node:fs";

import { RunContainerPool, normalizeContainerConfig, DEFAULT_BUILD_IMAGE } from "../src/run-container-pool.js";
import type { NodeContainerConfig } from "../src/types.js";

/* ── Helpers ──────────────────────────────────────────────────────────── */

const silentLogger = { log: vi.fn(), child: vi.fn().mockReturnThis() } as any;

/**
 * Set up child_process mocks to simulate Docker CLI.
 * - `docker run --detach ...` returns a container ID
 * - `docker exec ...` exits with the given code
 * - `docker rm -f ...` succeeds
 * - `spawn` for `docker exec` returns a process with stdout/stderr streams
 */
function mockDockerCli(opts: {
  containerId?: string;
  execExitCode?: number;
  execStdout?: string;
} = {}) {
  const {
    containerId = "testcont12345678",
    execExitCode = 0,
    execStdout = "container output",
  } = opts;

  (child_process.execFile as any).mockImplementation(
    (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
      const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
      if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;

      if (args[0] === "run") {
        // docker run --detach ... → return container ID
        callback(null, `${containerId}\n`, "");
      } else {
        callback(null, "", "");
      }
      return { kill: vi.fn(), on: vi.fn() } as any;
    },
  );

  (child_process.execFileSync as any).mockReturnValue("");

  // Mock spawn for docker exec (used by RunContainerPool.exec)
  (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
    const stdoutListeners: Array<(d: Buffer) => void> = [];
    const closeListeners: Array<(code: number) => void> = [];
    const stderrListeners: Array<(d: Buffer) => void> = [];

    const mockProc = {
      stdout: {
        on: (event: string, cb: (d: Buffer) => void) => {
          if (event === "data") stdoutListeners.push(cb);
        },
      },
      stderr: {
        on: (event: string, cb: (d: Buffer) => void) => {
          if (event === "data") stderrListeners.push(cb);
        },
      },
      on: (event: string, cb: (code: number) => void) => {
        if (event === "close") closeListeners.push(cb);
      },
    };

    // Simulate async stdout emission + close
    setImmediate(() => {
      for (const cb of stdoutListeners) cb(Buffer.from(execStdout));
      for (const cb of closeListeners) cb(execExitCode);
    });

    return mockProc as any;
  });
}

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("RunContainerPool", () => {
  let pool: RunContainerPool;

  beforeEach(() => {
    pool = new RunContainerPool(silentLogger);
    vi.clearAllMocks();
  });

  afterEach(() => {
    pool.releaseAll();
    vi.restoreAllMocks();
  });

  /* ── acquire ──────────────────────────────────────────────────────── */

  describe("acquire", () => {
    it("starts a detached container and returns its ID", async () => {
      mockDockerCli({ containerId: "abc123def456" });

      const id = await pool.acquire("run-1", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test-run.log",
      });

      expect(id).toBe("abc123def456");
      expect(pool.hasContainer("run-1")).toBe(true);
    });

    it("uses 'sleep infinity' to keep container alive", async () => {
      mockDockerCli();

      await pool.acquire("run-2", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test.log",
      });

      const runCall = (child_process.execFile as any).mock.calls.find(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      const args: string[] = runCall[1];
      // sleep infinity should be the command after the image
      const imageIdx = args.indexOf(DEFAULT_BUILD_IMAGE);
      expect(args[imageIdx + 1]).toBe("sleep");
      expect(args[imageIdx + 2]).toBe("infinity");
    });

    it("returns existing container ID when called twice for the same run", async () => {
      mockDockerCli({ containerId: "stable123456" });

      const id1 = await pool.acquire("run-3", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test.log",
      });
      const id2 = await pool.acquire("run-3", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test.log",
      });

      expect(id1).toBe(id2);
      // docker run should have only been called once
      const runCalls = (child_process.execFile as any).mock.calls.filter(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      expect(runCalls.length).toBe(1);
    });

    it("passes env vars to docker run", async () => {
      mockDockerCli();

      await pool.acquire("run-4", {
        image: DEFAULT_BUILD_IMAGE,
        env: { REPO_URL: "https://github.com/test/repo", BUILD_CMD: "npm test" },
        logFile: "/tmp/test.log",
      });

      const runCall = (child_process.execFile as any).mock.calls.find(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      const args: string[] = runCall[1];
      expect(args).toContain("--env");
      expect(args).toContain("REPO_URL=https://github.com/test/repo");
      expect(args).toContain("BUILD_CMD=npm test");
    });

    it("passes volume mounts to docker run", async () => {
      mockDockerCli();

      await pool.acquire("run-5", {
        image: DEFAULT_BUILD_IMAGE,
        volumes: { "/host/repo": "/workspace" },
        logFile: "/tmp/test.log",
      });

      const runCall = (child_process.execFile as any).mock.calls.find(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      const args: string[] = runCall[1];
      expect(args).toContain("--volume");
      expect(args).toContain("/host/repo:/workspace");
    });

    it("passes resource limits to docker run", async () => {
      mockDockerCli();

      await pool.acquire("run-6", {
        image: DEFAULT_BUILD_IMAGE,
        resourceLimits: { cpus: "2.0", memory: "4g" },
        logFile: "/tmp/test.log",
      });

      const runCall = (child_process.execFile as any).mock.calls.find(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      const args: string[] = runCall[1];
      expect(args).toContain("--cpus");
      expect(args).toContain("2.0");
      expect(args).toContain("--memory");
      expect(args).toContain("4g");
    });

    it("does not inject runner-specific credentials and runs containers as the host user", async () => {
      mockDockerCli();

      await pool.acquire("run-generic", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test.log",
      });

      const runCall = (child_process.execFile as any).mock.calls.find(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      const args: string[] = runCall[1];
      expect(args).toContain("--user");
      expect(args).toContain(`${process.getuid?.()}:${process.getgid?.()}`);
      const claudeMount = args.find((a: string) => a.includes("/.claude:") && a.includes(":ro"));
      expect(claudeMount).toBeUndefined();
    });

    it("only mounts env and volumes explicitly provided by the caller", async () => {
      mockDockerCli();

      await pool.acquire("run-explicit", {
        image: DEFAULT_BUILD_IMAGE,
        env: { HOME: "/workspace/home" },
        volumes: { "/host/config": "/workspace/config" },
        logFile: "/tmp/test.log",
      });

      const runCall = (child_process.execFile as any).mock.calls.find(
        (c: any[]) => c[0] === "docker" && c[1][0] === "run",
      );
      const args: string[] = runCall[1];
      expect(args).toContain("--env");
      expect(args).toContain("HOME=/workspace/home");
      expect(args).toContain("--volume");
      expect(args).toContain("/host/config:/workspace/config");
    });

    it("throws when docker run fails", async () => {
      (child_process.execFile as any).mockImplementation(
        (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (callback && args[0] === "run") {
            callback(new Error("image not found"), "", "Error: image not found");
          }
          return { kill: vi.fn(), on: vi.fn() } as any;
        },
      );

      await expect(
        pool.acquire("run-fail", {
          image: "nonexistent:latest",
          logFile: "/tmp/test.log",
        }),
      ).rejects.toThrow("docker run failed");
    });
  });

  /* ── exec ─────────────────────────────────────────────────────────── */

  describe("exec", () => {
    it("runs a command in the persistent container via docker exec", async () => {
      // Container IDs are truncated to 12 chars in pool implementation
      mockDockerCli({ containerId: "mycontainer1", execStdout: "hello world\n" });

      await pool.acquire("run-exec", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });
      const result = await pool.exec("run-exec", ["echo", "hello world"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello world");

      const spawnCalls = (child_process.spawn as any).mock.calls;
      const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
      expect(execCall).toBeDefined();
      expect(execCall[1]).toContain("mycontainer1");
    });

    it("throws when no container acquired for run", async () => {
      await expect(
        pool.exec("nonexistent-run", ["echo", "test"]),
      ).rejects.toThrow("No container found for run nonexistent-run");
    });

    it("captures non-zero exit code from exec", async () => {
      mockDockerCli({ execExitCode: 1, execStdout: "error output" });

      await pool.acquire("run-fail-exec", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test.log",
      });
      const result = await pool.exec("run-fail-exec", ["false"]);

      expect(result.exitCode).toBe(1);
    });

    it("passes env vars to docker exec", async () => {
      mockDockerCli();

      await pool.acquire("run-exec-env", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });
      await pool.exec("run-exec-env", ["env"], { MY_VAR: "my_value" });

      const spawnCalls = (child_process.spawn as any).mock.calls;
      const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
      expect(execCall).toBeDefined();
      expect(execCall[1]).toContain("--env");
      expect(execCall[1]).toContain("MY_VAR=my_value");
    });

    it("appends exec stdout and stderr to the run container log file", async () => {
      const appendSpy = vi.spyOn(fs, "appendFileSync").mockReturnValue(undefined as never);
      mockDockerCli({ execExitCode: 1, execStdout: "stdout line\n" });
      (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
        const stdoutListeners: Array<(d: Buffer) => void> = [];
        const closeListeners: Array<(code: number) => void> = [];
        const stderrListeners: Array<(d: Buffer) => void> = [];
        const mockProc = {
          stdout: {
            on: (event: string, cb: (d: Buffer) => void) => {
              if (event === "data") stdoutListeners.push(cb);
            },
          },
          stderr: {
            on: (event: string, cb: (d: Buffer) => void) => {
              if (event === "data") stderrListeners.push(cb);
            },
          },
          on: (event: string, cb: (code: number) => void) => {
            if (event === "close") closeListeners.push(cb);
          },
        };
        setImmediate(() => {
          for (const cb of stdoutListeners) cb(Buffer.from("stdout line\n"));
          for (const cb of stderrListeners) cb(Buffer.from("stderr line\n"));
          for (const cb of closeListeners) cb(1);
        });
        return mockProc as any;
      });

      await pool.acquire("run-log-exec", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });
      const result = await pool.exec("run-log-exec", ["false"]);

      expect(result.exitCode).toBe(1);
      expect(appendSpy.mock.calls).toContainEqual([
        "/tmp/test.log",
        "stdout line\nstderr line\n",
        "utf8",
      ]);
    });
  });

  /* ── release ──────────────────────────────────────────────────────── */

  describe("release", () => {
    it("removes the container and clears it from the pool", async () => {
      // Container IDs are truncated to 12 chars
      mockDockerCli({ containerId: "removetst123" });

      await pool.acquire("run-rel", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });
      expect(pool.hasContainer("run-rel")).toBe(true);

      pool.release("run-rel");

      expect(pool.hasContainer("run-rel")).toBe(false);
      expect(child_process.execFileSync).toHaveBeenCalledWith(
        "docker",
        ["rm", "-f", "removetst123"],
        { stdio: "ignore" },
      );
    });

    it("is safe to call for a run with no container", () => {
      expect(() => pool.release("nonexistent")).not.toThrow();
    });

    it("is safe to call twice", async () => {
      mockDockerCli();

      await pool.acquire("run-double-rel", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/test.log",
      });
      pool.release("run-double-rel");
      expect(() => pool.release("run-double-rel")).not.toThrow();
    });
  });

  /* ── releaseAll ───────────────────────────────────────────────────── */

  describe("releaseAll", () => {
    it("removes all tracked containers", async () => {
      mockDockerCli({ containerId: "containerA123456" });

      await pool.acquire("run-a", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/a.log" });
      // Second acquire with same mock — it'll re-use same ID for run-b
      await pool.acquire("run-b", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/b.log" });

      pool.releaseAll();

      expect(pool.hasContainer("run-a")).toBe(false);
      expect(pool.hasContainer("run-b")).toBe(false);
    });
  });
});

/* ── normalizeContainerConfig ─────────────────────────────────────────── */

describe("normalizeContainerConfig", () => {
  it("expands 'isolated' to object with default image", () => {
    const result = normalizeContainerConfig("isolated");
    expect(result.image).toBe(DEFAULT_BUILD_IMAGE);
    expect(result.workdir).toBe("/workspace");
  });

  it("expands 'isolated' with provided default image", () => {
    const result = normalizeContainerConfig("isolated", { image: "my-custom:latest" });
    expect(result.image).toBe("my-custom:latest");
  });

  it("merges env from defaults and config (config wins)", () => {
    const result = normalizeContainerConfig({
      env: { BUILD_CMD: "npm run build" },
    }, {
      env: { REPO_URL: "https://example.com", BUILD_CMD: "npm test" },
    });
    expect(result.env?.BUILD_CMD).toBe("npm run build"); // node-level wins
    expect(result.env?.REPO_URL).toBe("https://example.com"); // from defaults
  });

  it("merges volumes from defaults and config", () => {
    const result = normalizeContainerConfig({
      volumes: { "/extra/path": "/extra" },
    }, {
      volumes: { "/host/repo": "/workspace" },
    });
    expect(result.volumes?.["/host/repo"]).toBe("/workspace");
    expect(result.volumes?.["/extra/path"]).toBe("/extra");
  });

  it("uses default image when object form has no image", () => {
    const result = normalizeContainerConfig({}, { image: "default-img:latest" });
    expect(result.image).toBe("default-img:latest");
  });

  it("preserves timeoutMs and resourceLimits from config", () => {
    const result = normalizeContainerConfig({
      timeoutMs: 300_000,
      resourceLimits: { cpus: "1.5", memory: "2g" },
    });
    expect(result.timeoutMs).toBe(300_000);
    expect(result.resourceLimits?.cpus).toBe("1.5");
    expect(result.resourceLimits?.memory).toBe("2g");
  });
});

/* ── Pipeline container field integration ───────────────────────────── */

describe("Container field on pipeline node and definition (schema + type integration)", () => {
  it("AgentNode accepts container: 'isolated'", async () => {
    // Import the schema to validate
    const { pipelineDefinitionSchema } = await import("../src/schema.js");

    const pipeline = {
      id: "test-agent-container",
      entry: ["step1"],
      nodes: [
        {
          id: "step1",
          type: "agent" as const,
          prompt: "Do something",
          runner: "claude-code" as const,
          container: "isolated" as const,
        },
        { id: "step2", type: "output" as const },
      ],
      edges: [{ from: { node: "step1" }, to: { node: "step2" } }],
    };

    const result = pipelineDefinitionSchema.safeParse(pipeline);
    expect(result.success).toBe(true);
  });

  it("ShellNode accepts container object config", async () => {
    const { pipelineDefinitionSchema } = await import("../src/schema.js");

    const pipeline = {
      id: "test-shell-container",
      entry: ["step1"],
      nodes: [
        {
          id: "step1",
          type: "shell" as const,
          command: "npm run build",
          container: {
            image: DEFAULT_BUILD_IMAGE,
            env: { BUILD_CMD: "npm run build" },
            volumes: { "/host/repo": "/workspace" },
            workdir: "/workspace",
            timeoutMs: 300_000,
            resourceLimits: { cpus: "1.5", memory: "2g" },
          },
        },
        { id: "step2", type: "output" as const },
      ],
      edges: [{ from: { node: "step1" }, to: { node: "step2" } }],
    };

    const result = pipelineDefinitionSchema.safeParse(pipeline);
    expect(result.success).toBe(true);
  });

  it("PipelineDefinition accepts run-level container config", async () => {
    const { pipelineDefinitionSchema } = await import("../src/schema.js");

    const pipeline = {
      id: "build_from_plan_with_container",
      entry: ["intake"],
      container: {
        image: DEFAULT_BUILD_IMAGE,
        env: { REPO_URL: "https://github.com/test/repo", BRANCH: "main" },
        volumes: { "/home/openclaw/wintermute": "/workspace" },
        workdir: "/workspace",
      },
      nodes: [
        { id: "intake", type: "input" as const },
        { id: "output", type: "output" as const },
      ],
      edges: [{ from: { node: "intake" }, to: { node: "output" } }],
    };

    const result = pipelineDefinitionSchema.safeParse(pipeline);
    expect(result.success).toBe(true);
  });

  it("PipelineDefinition accepts run-level container: 'isolated'", async () => {
    const { pipelineDefinitionSchema } = await import("../src/schema.js");

    const pipeline = {
      id: "test-isolated-pipeline",
      entry: ["intake"],
      container: "isolated" as const,
      nodes: [
        { id: "intake", type: "input" as const },
        { id: "output", type: "output" as const },
      ],
      edges: [{ from: { node: "intake" }, to: { node: "output" } }],
    };

    const result = pipelineDefinitionSchema.safeParse(pipeline);
    expect(result.success).toBe(true);
  });

  it("rejects invalid container config (extra fields)", async () => {
    const { pipelineDefinitionSchema } = await import("../src/schema.js");

    const pipeline = {
      id: "test-invalid-container",
      entry: ["intake"],
      nodes: [
        {
          id: "intake",
          type: "shell" as const,
          command: "echo hello",
          container: {
            image: DEFAULT_BUILD_IMAGE,
            unknownField: "should fail",
          },
        },
        { id: "output", type: "output" as const },
      ],
      edges: [{ from: { node: "intake" }, to: { node: "output" } }],
    };

    const result = pipelineDefinitionSchema.safeParse(pipeline);
    // strict() mode on container config object rejects extra keys
    expect(result.success).toBe(false);
  });
});

/* ── Build pipeline container lifecycle stub tests ───────────────────── */

describe("Build pipeline container lifecycle (stub mode)", () => {
  /**
   * These tests simulate what build_from_plan and bug_fix pipelines would do
   * with container execution: acquire a persistent container at run start,
   * run BUILD_CMD inside it, capture output, then cleanup on completion.
   *
   * No real Docker or Claude Code needed — child_process is fully mocked.
   */

  let pool: RunContainerPool;

  beforeEach(() => {
    pool = new RunContainerPool(silentLogger);
    vi.clearAllMocks();
  });

  afterEach(() => {
    pool.releaseAll();
  });

  it("simulates build_from_plan container lifecycle: acquire → exec BUILD_CMD → release", async () => {
    const runId = "build-run-001";
    // Use exactly 12-char IDs (pool truncates docker output to 12)
    mockDockerCli({
      containerId: "buildcont123",
      execExitCode: 0,
      execStdout: "Build succeeded. 5 stories implemented.\n",
    });

    // Step 1: Acquire container (simulates run start)
    const containerId = await pool.acquire(runId, {
      image: DEFAULT_BUILD_IMAGE,
      env: {
        REPO_URL: "https://github.com/craigjmidwinter/wintermute",
        BRANCH: `build/${runId}`,
        BUILD_CMD: "claude -p 'Implement the feature stories' --output-format text",
      },
      volumes: { "/home/openclaw/wintermute": "/workspace" },
      workdir: "/workspace",
      logFile: `/tmp/ripline/runs/${runId}/container.log`,
    });

    expect(containerId).toBe("buildcont123");
    expect(pool.hasContainer(runId)).toBe(true);

    // Step 2: Exec the build command inside the container (simulates a build step)
    const result = await pool.exec(runId, [
      "sh", "-c", "echo 'Build succeeded. 5 stories implemented.'",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Build succeeded");

    // Step 3: Release container (simulates run completion)
    pool.release(runId);

    expect(pool.hasContainer(runId)).toBe(false);
    expect(child_process.execFileSync).toHaveBeenCalledWith(
      "docker",
      ["rm", "-f", "buildcont123"],
      { stdio: "ignore" },
    );
  });

  it("simulates bug_fix container lifecycle: acquire → exec fix command → release", async () => {
    const runId = "bugfix-run-001";
    // Use exactly 12-char IDs (pool truncates to 12)
    mockDockerCli({
      containerId: "bugfixcont12",
      execExitCode: 0,
      execStdout: "Bug fixed. Root cause was a missing null check.\n",
    });

    // Acquire container for bug fix run
    const containerId = await pool.acquire(runId, {
      image: DEFAULT_BUILD_IMAGE,
      env: {
        REPO_URL: "https://github.com/craigjmidwinter/wintermute",
        BRANCH: `build/${runId}`,
        BUILD_CMD: "claude -p 'Fix the bug' --dangerously-skip-permissions --output-format text",
      },
      volumes: { "/home/openclaw/wintermute": "/workspace" },
      workdir: "/workspace",
      logFile: `/tmp/ripline/runs/${runId}/container.log`,
    });

    expect(containerId).toBe("bugfixcont12");

    // Execute the fix step
    const fixResult = await pool.exec(runId, [
      "sh", "-c", "echo 'Bug fixed. Root cause was a missing null check.'",
    ]);

    expect(fixResult.exitCode).toBe(0);

    // Execute the test step in the same container (file sharing via filesystem)
    const testResult = await pool.exec(runId, [
      "sh", "-c", "echo 'All tests pass'",
    ]);

    expect(testResult.exitCode).toBe(0);

    // Release at end of run
    pool.release(runId);
    expect(pool.hasContainer(runId)).toBe(false);
  });

  it("cleans up container on failure (non-zero exit)", async () => {
    const runId = "failed-build-run";
    // Use exactly 12-char IDs (pool truncates to 12)
    mockDockerCli({
      containerId: "failcont1234",
      execExitCode: 1,
      execStdout: "Build failed: TypeScript errors found\n",
    });

    await pool.acquire(runId, {
      image: DEFAULT_BUILD_IMAGE,
      logFile: `/tmp/ripline/runs/${runId}/container.log`,
    });

    const result = await pool.exec(runId, ["npm", "run", "build"]);

    // Simulate failure handling: release on error
    pool.release(runId);

    expect(result.exitCode).toBe(1);
    expect(pool.hasContainer(runId)).toBe(false);
    expect(child_process.execFileSync).toHaveBeenCalledWith(
      "docker", ["rm", "-f", "failcont1234"], { stdio: "ignore" },
    );
  });

  it("supports multiple concurrent runs with isolated containers", async () => {
    // Run A and Run B can each have their own container
    let callCount = 0;
    // 12-char IDs (pool truncates docker output to 12 chars)
    const containerIds = ["runAcontaine", "runBcontaine"];
    (child_process.execFile as any).mockImplementation(
      (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
        const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
        if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
        if (args[0] === "run") {
          callback(null, `${containerIds[callCount++ % 2]}\n`, "");
        } else {
          callback(null, "", "");
        }
        return { kill: vi.fn(), on: vi.fn() } as any;
      },
    );
    (child_process.execFileSync as any).mockReturnValue("");
    (child_process.spawn as any).mockImplementation(() => ({
      stdout: { on: vi.fn() },
      stderr: { on: vi.fn() },
      on: (event: string, cb: (code: number) => void) => {
        if (event === "close") setImmediate(() => cb(0));
      },
    }));

    const poolA = new RunContainerPool(silentLogger);
    const poolB = new RunContainerPool(silentLogger);

    try {
      const idA = await poolA.acquire("run-a", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/a.log",
      });
      const idB = await poolB.acquire("run-b", {
        image: DEFAULT_BUILD_IMAGE,
        logFile: "/tmp/b.log",
      });

      // Each pool has its own container (12-char IDs)
      expect(idA).toBe("runAcontaine");
      expect(idB).toBe("runBcontaine");

      // They're independent
      expect(poolA.hasContainer("run-b")).toBe(false);
      expect(poolB.hasContainer("run-a")).toBe(false);
    } finally {
      poolA.releaseAll();
      poolB.releaseAll();
    }
  });

  it("simulates persistent container sharing between pipeline steps (file hand-off)", async () => {
    const runId = "shared-run-001";
    // Pool truncates docker output to 12 chars
    const sharedContainerId = "sharedcont12";

    mockDockerCli({
      containerId: sharedContainerId,
      execExitCode: 0,
      execStdout: "",
    });

    // Track spawn calls to verify step sequencing
    (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
      return {
        stdout: { on: (event: string, cb: (d: Buffer) => void) => {
          if (event === "data") setImmediate(() => cb(Buffer.from("ok\n")));
        }},
        stderr: { on: vi.fn() },
        on: (event: string, cb: (code: number) => void) => {
          if (event === "close") setImmediate(() => cb(0));
        },
      } as any;
    });

    await pool.acquire(runId, {
      image: DEFAULT_BUILD_IMAGE,
      logFile: `/tmp/${runId}.log`,
    });

    // Step 1 of build_from_plan: clone and implement (writes files to /workspace)
    await pool.exec(runId, ["sh", "-c", "git clone $REPO_URL /workspace && cd /workspace && claude-code implement"]);

    // Step 2: run tests (reads files from /workspace)
    await pool.exec(runId, ["sh", "-c", "cd /workspace && npm test"]);

    // Step 3: build verify (reads from same /workspace)
    await pool.exec(runId, ["sh", "-c", "cd /workspace && npm run build"]);

    // All steps used the same container
    const spawnCalls = (child_process.spawn as any).mock.calls.filter(
      (c: any[]) => c[0] === "docker" && c[1][0] === "exec",
    );
    expect(spawnCalls.length).toBe(3);

    // All exec calls targeted the same container
    for (const call of spawnCalls) {
      expect(call[1]).toContain(sharedContainerId);
    }

    pool.release(runId);
  });

  it("DEFAULT_BUILD_IMAGE is a generic base image", () => {
    expect(DEFAULT_BUILD_IMAGE).toBe("ubuntu:22.04");
  });
});
