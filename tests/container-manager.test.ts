import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ContainerManager, type ContainerSpawnOptions } from "../src/container-manager.js";
import * as child_process from "node:child_process";
import * as fs from "node:fs";

/* ── ESM-compatible mocks ─────────────────────────────────────────────── */
// vi.mock is hoisted to top of file by Vitest, so ESM namespaces become
// configurable and vi.mocked() wrappers work throughout the tests.

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: vi.fn(),
    openSync: vi.fn(),
    closeSync: vi.fn(),
  };
});

/* ── Helpers ──────────────────────────────────────────────────────────── */

/** Silent logger that swallows all output. */
const silentLogger = {
  log: vi.fn(),
};

/**
 * Build a ContainerManager with short TTL and silent logger.
 * Caller must call dispose() in afterEach.
 */
function createTestManager(opts?: { failedContainerTTL?: number }) {
  return new ContainerManager({
    failedContainerTTL: opts?.failedContainerTTL ?? 500,
    logger: silentLogger as any,
  });
}

/** Default mock implementation for `docker run` + `docker wait` calls via execFile. */
function mockExecFileSuccess(containerId = "abc123def456") {
  vi.mocked(child_process.execFile).mockImplementation(
    ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
      const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
      if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;

      if (args[0] === "run") {
        callback(null, `${containerId}\n`, "");
      } else if (args[0] === "wait") {
        callback(null, "0\n", "");
      } else {
        callback(null, "", "");
      }
      return { kill: vi.fn(), on: vi.fn() } as any;
    }) as any,
  );
}

/** Mock spawn to return a minimal no-op child process. */
function mockSpawnNoop() {
  vi.mocked(child_process.spawn).mockReturnValue({
    on: vi.fn(),
    kill: vi.fn(),
    stdout: null,
    stderr: null,
    pid: 1234,
  } as any);
}

/* ── Tests ────────────────────────────────────────────────────────────── */

describe("ContainerManager", () => {
  let manager: ContainerManager;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.openSync).mockReturnValue(99 as any);
    vi.mocked(fs.closeSync).mockReturnValue(undefined);
  });

  afterEach(() => {
    manager?.dispose();
    vi.restoreAllMocks();
  });

  /* ── Constructor / defaults ───────────────────────────────────────── */

  describe("constructor", () => {
    it("creates an instance with default TTL of 30 minutes", () => {
      manager = new ContainerManager({ logger: silentLogger as any });
      // The manager should start with an empty failed-containers list
      expect(manager.trackedFailedContainers).toEqual([]);
    });

    it("accepts a custom failedContainerTTL", () => {
      manager = createTestManager({ failedContainerTTL: 1000 });
      expect(manager.trackedFailedContainers).toEqual([]);
    });
  });

  /* ── buildRunArgs (tested indirectly via spawn) ───────────────────── */

  describe("spawn — docker run argument construction", () => {
    beforeEach(() => {
      manager = createTestManager();
      mockSpawnNoop();
      mockExecFileSuccess("abc123def456");
    });

    it("passes --env flags for each environment variable", async () => {
      const result = await manager.spawn({
        image: "node:20-slim",
        env: { FOO: "bar", BAZ: "qux" },
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      expect(runCall).toBeDefined();
      const args = runCall![1] as string[];
      expect(args).toContain("--env");
      expect(args).toContain("FOO=bar");
      expect(args).toContain("BAZ=qux");
      expect(result.exitCode).toBe(0);
    });

    it("passes --volume flags for each volume mount", async () => {
      await manager.spawn({
        image: "node:20-slim",
        volumes: { "/host/repo": "/workspace" },
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--volume");
      expect(args).toContain("/host/repo:/workspace");
    });

    it("passes --workdir when specified", async () => {
      await manager.spawn({
        image: "node:20-slim",
        workdir: "/workspace",
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--workdir");
      expect(args).toContain("/workspace");
    });

    it("passes --name when specified", async () => {
      await manager.spawn({
        image: "node:20-slim",
        name: "my-build",
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--name");
      expect(args).toContain("my-build");
    });

    it("passes --cpus and --memory resource limit flags", async () => {
      await manager.spawn({
        image: "node:20-slim",
        resourceLimits: { cpus: "1.5", memory: "2g" },
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--cpus");
      expect(args).toContain("1.5");
      expect(args).toContain("--memory");
      expect(args).toContain("2g");
    });

    it("omits resource limit flags when not specified", async () => {
      await manager.spawn({
        image: "node:20-slim",
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).not.toContain("--cpus");
      expect(args).not.toContain("--memory");
    });

    it("appends command args after image name", async () => {
      await manager.spawn({
        image: "node:20-slim",
        command: ["npm", "test"],
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      const imageIdx = args.indexOf("node:20-slim");
      expect(args[imageIdx + 1]).toBe("npm");
      expect(args[imageIdx + 2]).toBe("test");
    });

    it("always includes --detach flag", async () => {
      await manager.spawn({
        image: "alpine",
        logFile: "/tmp/test.log",
      });

      const calls = vi.mocked(child_process.execFile).mock.calls;
      const runCall = calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      const args = runCall![1] as string[];
      expect(args).toContain("--detach");
    });
  });

  /* ── Exit code handling ───────────────────────────────────────────── */

  describe("spawn — exit code and cleanup", () => {
    beforeEach(() => {
      manager = createTestManager();
      mockSpawnNoop();
    });

    it("removes container on success (exit code 0)", async () => {
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      vi.mocked(child_process.execFile).mockImplementation(
        ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
          if (args[0] === "run") callback(null, "abc123def456\n", "");
          else if (args[0] === "wait") callback(null, "0\n", "");
          else callback(null, "", "");
          return { kill: vi.fn(), on: vi.fn() } as any;
        }) as any,
      );

      const result = await manager.spawn({
        image: "node:20",
        logFile: "/tmp/test.log",
      });

      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      // Container should have been removed (docker rm -f)
      expect(vi.mocked(child_process.execFileSync)).toHaveBeenCalledWith(
        "docker", ["rm", "-f", "abc123def456"], expect.anything()
      );
    });

    it("tracks failed container for TTL cleanup on non-zero exit", async () => {
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      vi.mocked(child_process.execFile).mockImplementation(
        ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
          if (args[0] === "run") callback(null, "fail123456789\n", "");
          else if (args[0] === "wait") callback(null, "1\n", "");
          else callback(null, "", "");
          return { kill: vi.fn(), on: vi.fn() } as any;
        }) as any,
      );

      const result = await manager.spawn({
        image: "node:20",
        logFile: "/tmp/test.log",
      });

      expect(result.exitCode).toBe(1);
      expect(manager.trackedFailedContainers.length).toBe(1);
      expect(manager.trackedFailedContainers[0]!.containerId).toBe("fail12345678");
    });

    it("returns containerId truncated to 12 chars", async () => {
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      vi.mocked(child_process.execFile).mockImplementation(
        ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
          if (args[0] === "run") callback(null, "abcdef123456789extra\n", "");
          else if (args[0] === "wait") callback(null, "0\n", "");
          else callback(null, "", "");
          return { kill: vi.fn(), on: vi.fn() } as any;
        }) as any,
      );

      const result = await manager.spawn({
        image: "node:20",
        logFile: "/tmp/test.log",
      });

      expect(result.containerId).toBe("abcdef123456");
    });

    it("returns logFile path in result", async () => {
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      vi.mocked(child_process.execFile).mockImplementation(
        ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
          if (args[0] === "run") callback(null, "abc123def456\n", "");
          else if (args[0] === "wait") callback(null, "0\n", "");
          else callback(null, "", "");
          return { kill: vi.fn(), on: vi.fn() } as any;
        }) as any,
      );

      const result = await manager.spawn({
        image: "node:20",
        logFile: "/tmp/custom.log",
      });

      expect(result.logFile).toBe("/tmp/custom.log");
    });
  });

  /* ── TTL-based cleanup ─────────────────────────────────────────────── */

  describe("cleanupExpiredContainers", () => {
    it("removes containers whose TTL has expired", () => {
      manager = createTestManager({ failedContainerTTL: 100 });

      // Manually inject a failed container entry with an old timestamp
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      (manager as any).failedContainers.push(
        { containerId: "old-container", failedAt: Date.now() - 200 },
      );

      manager.cleanupExpiredContainers();

      expect(vi.mocked(child_process.execFileSync)).toHaveBeenCalledWith(
        "docker", ["rm", "-f", "old-container"], expect.anything()
      );
      expect(manager.trackedFailedContainers.length).toBe(0);
    });

    it("does not remove containers within TTL", () => {
      manager = createTestManager({ failedContainerTTL: 10_000 });

      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      (manager as any).failedContainers.push(
        { containerId: "recent-container", failedAt: Date.now() },
      );

      manager.cleanupExpiredContainers();

      expect(vi.mocked(child_process.execFileSync)).not.toHaveBeenCalled();
      expect(manager.trackedFailedContainers.length).toBe(1);
    });

    it("handles mix of expired and non-expired containers", () => {
      manager = createTestManager({ failedContainerTTL: 100 });

      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);
      (manager as any).failedContainers.push(
        { containerId: "expired1", failedAt: Date.now() - 200 },
        { containerId: "fresh1", failedAt: Date.now() },
        { containerId: "expired2", failedAt: Date.now() - 300 },
      );

      manager.cleanupExpiredContainers();

      expect(manager.trackedFailedContainers.length).toBe(1);
      expect(manager.trackedFailedContainers[0]!.containerId).toBe("fresh1");
    });
  });

  /* ── removeContainer ───────────────────────────────────────────────── */

  describe("removeContainer", () => {
    it("calls docker rm -f with the container ID", () => {
      manager = createTestManager();
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);

      manager.removeContainer("abc123");

      expect(vi.mocked(child_process.execFileSync)).toHaveBeenCalledWith(
        "docker", ["rm", "-f", "abc123"], { stdio: "ignore" }
      );
    });

    it("does not throw when removal fails", () => {
      manager = createTestManager();
      vi.mocked(child_process.execFileSync).mockImplementation(() => {
        throw new Error("container not found");
      });

      expect(() => manager.removeContainer("nonexistent")).not.toThrow();
    });
  });

  /* ── dispose ───────────────────────────────────────────────────────── */

  describe("dispose", () => {
    it("stops the cleanup interval", () => {
      manager = createTestManager();
      const clearSpy = vi.spyOn(global, "clearInterval");

      manager.dispose();

      expect(clearSpy).toHaveBeenCalled();
    });

    it("is safe to call multiple times", () => {
      manager = createTestManager();

      manager.dispose();
      expect(() => manager.dispose()).not.toThrow();
    });
  });

  /* ── Timeout handling ──────────────────────────────────────────────── */

  describe("spawn — timeout", () => {
    it("sets timedOut to true and kills container when timeout is exceeded", async () => {
      manager = createTestManager();
      mockSpawnNoop();
      vi.mocked(child_process.execFileSync).mockReturnValue("" as any);

      // Make `docker wait` never resolve (simulating long-running container),
      // so the timeout fires first.
      vi.mocked(child_process.execFile).mockImplementation(
        ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
          if (args[0] === "run") {
            callback(null, "timeout123456\n", "");
          } else if (args[0] === "wait") {
            // Don't call callback — let timeout fire.
            // But we do need the returned child to have a kill method
          }
          return { kill: vi.fn((sig?: string) => {
            // When the wait process is killed, callback resolves
            if (args[0] === "wait" && callback) {
              callback(new Error("killed"), "", "");
            }
          }), on: vi.fn() } as any;
        }) as any,
      );

      const result = await manager.spawn({
        image: "node:20",
        logFile: "/tmp/timeout.log",
        timeoutMs: 50,
      });

      expect(result.timedOut).toBe(true);
      expect(result.exitCode).toBeNull();
    });
  });

  /* ── Docker error handling ─────────────────────────────────────────── */

  describe("spawn — docker errors", () => {
    it("rejects when docker run fails", async () => {
      manager = createTestManager();
      mockSpawnNoop();
      vi.mocked(child_process.execFile).mockImplementation(
        ((cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
          const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
          if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
          if (args[0] === "run") {
            callback(new Error("image not found"), "", "Error: image not found");
          }
          return { kill: vi.fn(), on: vi.fn() } as any;
        }) as any,
      );

      await expect(
        manager.spawn({ image: "nonexistent:latest", logFile: "/tmp/err.log" }),
      ).rejects.toThrow("docker run failed");
    });
  });
});
