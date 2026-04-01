/**
 * Container routing tests for shell and agent executors.
 *
 * Verifies:
 * - Shell executor routes through containerPool.exec when container config is present.
 * - Shell executor routes through containerPool.exec when pool holds a run-level container.
 * - Shell executor falls back to direct execution when no containerPool / container.
 * - Agent executor routes through containerPool.exec when container config is present.
 * - Agent executor routes through containerPool.exec when pool holds a run-level container.
 * - Agent executor falls back to the runner function when no containerPool / container.
 *
 * Docker is mocked — no real Docker required.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before any executor imports
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
    mkdirSync: vi.fn().mockReturnValue(undefined),
    openSync: vi.fn().mockReturnValue(99),
    closeSync: vi.fn().mockReturnValue(undefined),
    readFileSync: (actual as typeof import("node:fs")).readFileSync,
    statSync: (actual as typeof import("node:fs")).statSync,
  };
});

import * as child_process from "node:child_process";

import { RunContainerPool, DEFAULT_BUILD_IMAGE } from "../../src/run-container-pool.js";
import { createClaudeCodeRunner } from "../../src/claude-code-runner.js";
import { createCodexRunner } from "../../src/codex-runner.js";
import { executeShell } from "../../src/pipeline/executors/shell.js";
import { executeAgent } from "../../src/pipeline/executors/agent.js";
import type { AgentRunner } from "../../src/pipeline/executors/agent.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";
import type { ShellNode, AgentNode } from "../../src/types.js";

/* ── Docker mock helpers ──────────────────────────────────────────────── */

const silentLogger = { log: vi.fn(), child: vi.fn().mockReturnThis() } as any;

/**
 * Mock Docker CLI so acquire() succeeds and exec() returns controlled output.
 */
function mockDockerForExec(opts: {
  containerId?: string;
  execExitCode?: number;
  execStdout?: string;
} = {}) {
  const {
    containerId = "testcont12345",
    execExitCode = 0,
    execStdout = "container output",
  } = opts;

  (child_process.execFile as any).mockImplementation(
    (cmd: string, args: string[], cbOrOpts?: any, cb?: any) => {
      const callback = typeof cbOrOpts === "function" ? cbOrOpts : cb;
      if (!callback) return { kill: vi.fn(), on: vi.fn() } as any;
      if (args[0] === "run") {
        callback(null, `${containerId}\n`, "");
      } else {
        callback(null, "", "");
      }
      return { kill: vi.fn(), on: vi.fn() } as any;
    },
  );

  (child_process.execFileSync as any).mockReturnValue("");

  (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
    const stdoutListeners: Array<(d: Buffer) => void> = [];
    const closeListeners: Array<(code: number) => void> = [];

    const mockProc = {
      stdout: {
        on: (event: string, cb: (d: Buffer) => void) => {
          if (event === "data") stdoutListeners.push(cb);
        },
      },
      stderr: { on: vi.fn() },
      on: (event: string, cb: any) => {
        if (event === "close") closeListeners.push(cb);
        if (event === "error") { /* never fires */ }
      },
    };

    setImmediate(() => {
      for (const cb of stdoutListeners) cb(Buffer.from(execStdout));
      for (const cb of closeListeners) cb(execExitCode);
    });

    return mockProc as any;
  });
}

/* ── Shell executor — container routing ──────────────────────────────── */

describe("executeShell — container routing", () => {
  let pool: RunContainerPool;

  beforeEach(() => {
    pool = new RunContainerPool(silentLogger);
    vi.clearAllMocks();
  });

  it("routes through containerPool.exec when node has container config", async () => {
    mockDockerForExec({ containerId: "shellcont1234", execExitCode: 0, execStdout: "hello from container\n" });

    // Pre-acquire so pool has the container for this run
    await pool.acquire("run-shell-1", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: ShellNode = {
      id: "my-shell",
      type: "shell",
      command: "echo hello",
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-shell-1",
      containerPool: pool,
    };

    const result = await executeShell(node, context);

    // Should have called docker exec (spawn with 'docker' + 'exec')
    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    expect(result.artifactKey).toBe("my-shell");
    expect((result.value as { exitCode: number }).exitCode).toBe(0);
  });

  it("routes through containerPool.exec when pool already has run-level container (no node.container)", async () => {
    mockDockerForExec({ containerId: "runlevel12345", execExitCode: 0, execStdout: "run-level output\n" });

    await pool.acquire("run-shell-2", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: ShellNode = {
      id: "sh-no-node-container",
      type: "shell",
      command: "npm run build",
      // no container field — should still route via run-level container
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-shell-2",
      containerPool: pool,
    };

    const result = await executeShell(node, context);

    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    expect((result.value as { exitCode: number }).exitCode).toBe(0);
  });

  it("falls back to direct execution when no containerPool is set", async () => {
    // spawn should be called for sh, not docker
    (child_process.spawn as any).mockImplementation((cmd: string, args: string[]) => {
      const stdoutListeners: Array<(d: Buffer) => void> = [];
      const closeListeners: Array<(code: number) => void> = [];

      setImmediate(() => {
        for (const cb of stdoutListeners) cb(Buffer.from("direct output\n"));
        for (const cb of closeListeners) cb(0);
      });

      return {
        stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data") stdoutListeners.push(cb); } },
        stderr: { on: vi.fn() },
        on: (e: string, cb: any) => { if (e === "close") closeListeners.push(cb); },
      } as any;
    });

    const node: ShellNode = {
      id: "sh-direct",
      type: "shell",
      command: "echo direct",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      // no containerPool
    };

    const result = await executeShell(node, context);

    // spawn should have been called with 'sh', not 'docker'
    const spawnCalls = (child_process.spawn as any).mock.calls;
    expect(spawnCalls.length).toBeGreaterThan(0);
    const dockerExecCall = spawnCalls.find((c: any[]) => c[0] === "docker");
    expect(dockerExecCall).toBeUndefined();
    expect((result.value as { exitCode: number }).exitCode).toBe(0);
  });

  it("falls back to direct execution when containerPool has no container for runId", async () => {
    // Pool is present but has NO container acquired for this run
    (child_process.spawn as any).mockImplementation((cmd: string) => {
      const stdoutListeners: Array<(d: Buffer) => void> = [];
      const closeListeners: Array<(code: number) => void> = [];
      setImmediate(() => {
        for (const cb of stdoutListeners) cb(Buffer.from("local output\n"));
        for (const cb of closeListeners) cb(0);
      });
      return {
        stdout: { on: (e: string, cb: (d: Buffer) => void) => { if (e === "data") stdoutListeners.push(cb); } },
        stderr: { on: vi.fn() },
        on: (e: string, cb: any) => { if (e === "close") closeListeners.push(cb); },
      } as any;
    });

    const node: ShellNode = {
      id: "sh-no-container-acquired",
      type: "shell",
      command: "echo fallback",
      // no node.container AND pool has no container for this runId
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-no-acquire",
      containerPool: pool, // pool present but hasContainer("run-no-acquire") === false
    };

    const result = await executeShell(node, context);

    const spawnCalls = (child_process.spawn as any).mock.calls;
    const dockerExecCall = spawnCalls.find((c: any[]) => c[0] === "docker");
    expect(dockerExecCall).toBeUndefined();
    expect((result.value as { exitCode: number }).exitCode).toBe(0);
  });

  it("includes the command via sh -c when routing through container", async () => {
    mockDockerForExec({ containerId: "cmdcheck12345", execExitCode: 0, execStdout: "" });
    await pool.acquire("run-cmd-check", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: ShellNode = {
      id: "check-cmd",
      type: "shell",
      command: "npm run test",
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-cmd-check",
      containerPool: pool,
    };

    await executeShell(node, context);

    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    const dockerArgs: string[] = execCall[1];
    // Should contain sh -c <command>
    const shIdx = dockerArgs.indexOf("sh");
    expect(shIdx).toBeGreaterThan(-1);
    expect(dockerArgs[shIdx + 1]).toBe("-c");
    expect(dockerArgs[shIdx + 2]).toBe("npm run test");
  });
});

/* ── Agent executor — container routing ──────────────────────────────── */

describe("executeAgent — container routing", () => {
  let pool: RunContainerPool;
  const mockRunner: AgentRunner = vi.fn(async () => ({ text: "runner-result" }));
  const claudeCodeRunner = createClaudeCodeRunner({ mode: "execute" });
  const codexRunner = createCodexRunner({ mode: "execute" });

  beforeEach(() => {
    pool = new RunContainerPool(silentLogger);
    vi.clearAllMocks();
    (mockRunner as any).mockImplementation(async () => ({ text: "runner-result" }));
  });

  it("routes through containerPool.exec when node has container config", async () => {
    mockDockerForExec({ containerId: "agentcont1234", execExitCode: 0, execStdout: "agent answer from container" });
    await pool.acquire("run-agent-1", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: AgentNode = {
      id: "agent-node",
      type: "agent",
      prompt: "Do something useful",
      runner: "claude-code",
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-agent-1",
      containerPool: pool,
    };

    const result = await executeAgent(node, context, { agentRunner: mockRunner, claudeCodeRunner });

    // Should have called docker exec with 'claude' command
    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    const dockerArgs: string[] = execCall[1];
    expect(dockerArgs).toContain("claude");

    // Should NOT have called the runner function
    expect(mockRunner).not.toHaveBeenCalled();

    expect(result.artifactKey).toBe("agent-node");
    expect((result.value as { text: string }).text).toBe("agent answer from container");
  });

  it("routes through containerPool.exec when pool has run-level container (no node.container)", async () => {
    mockDockerForExec({ containerId: "runlvlagent12", execExitCode: 0, execStdout: "run level answer" });
    await pool.acquire("run-agent-2", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: AgentNode = {
      id: "agent-run-level",
      type: "agent",
      prompt: "Do something",
      runner: "claude-code",
      // no container field — routes via run-level container
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-agent-2",
      containerPool: pool,
    };

    const result = await executeAgent(node, context, { agentRunner: mockRunner, claudeCodeRunner });

    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    expect(mockRunner).not.toHaveBeenCalled();
    expect((result.value as { text: string }).text).toBe("run level answer");
  });

  it("falls back to runner function when no containerPool is set", async () => {
    const node: AgentNode = {
      id: "agent-direct",
      type: "agent",
      prompt: "Hello",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      // no containerPool
    };

    await executeAgent(node, context, { agentRunner: mockRunner });

    expect(mockRunner).toHaveBeenCalled();
    // No docker spawn calls
    const spawnCalls = (child_process.spawn as any).mock.calls;
    const dockerExecCall = spawnCalls.find((c: any[]) => c[0] === "docker");
    expect(dockerExecCall).toBeUndefined();
  });

  it("falls back to runner when containerPool has no container and node has no container", async () => {
    const node: AgentNode = {
      id: "agent-fallback",
      type: "agent",
      prompt: "Hello",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-no-container",
      containerPool: pool, // present but no container acquired for this run
    };

    await executeAgent(node, context, { agentRunner: mockRunner });

    expect(mockRunner).toHaveBeenCalled();
    const spawnCalls = (child_process.spawn as any).mock.calls;
    const dockerExecCall = spawnCalls.find((c: any[]) => c[0] === "docker");
    expect(dockerExecCall).toBeUndefined();
  });

  it("passes --dangerously-skip-permissions flag when node requests it", async () => {
    mockDockerForExec({ containerId: "bypasscont1234", execExitCode: 0, execStdout: "bypassed" });
    await pool.acquire("run-bypass", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: AgentNode = {
      id: "agent-bypass",
      type: "agent",
      prompt: "Fix the bug",
      runner: "claude-code",
      dangerouslySkipPermissions: true,
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-bypass",
      containerPool: pool,
    };

    await executeAgent(node, context, { agentRunner: mockRunner, claudeCodeRunner });

    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    const dockerArgs: string[] = execCall[1];
    expect(dockerArgs).toContain("--dangerously-skip-permissions");
  });

  it("routes codex agents through containerPool.exec using codex exec", async () => {
    mockDockerForExec({ containerId: "codexcont123", execExitCode: 0, execStdout: "codex answer" });
    await pool.acquire("run-codex-1", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: AgentNode = {
      id: "agent-codex",
      type: "agent",
      prompt: "Ship it",
      runner: "codex",
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-codex-1",
      containerPool: pool,
    };

    const result = await executeAgent(node, context, { agentRunner: mockRunner, codexRunner });

    const spawnCalls = (child_process.spawn as any).mock.calls;
    const execCall = spawnCalls.find((c: any[]) => c[0] === "docker" && c[1][0] === "exec");
    expect(execCall).toBeDefined();
    const dockerArgs: string[] = execCall[1];
    expect(dockerArgs).toContain("codex");
    expect(dockerArgs).toContain("exec");
    expect(mockRunner).not.toHaveBeenCalled();
    expect((result.value as { text: string }).text).toBe("codex answer");
  });

  it("throws when container exec returns non-zero exit code", async () => {
    mockDockerForExec({ containerId: "errorcont1234", execExitCode: 1, execStdout: "build failed" });
    await pool.acquire("run-agent-err", { image: DEFAULT_BUILD_IMAGE, logFile: "/tmp/test.log" });

    const node: AgentNode = {
      id: "agent-error",
      type: "agent",
      prompt: "Do something that fails",
      runner: "claude-code",
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-agent-err",
      containerPool: pool,
    };

    await expect(
      executeAgent(node, context, { agentRunner: mockRunner, claudeCodeRunner }),
    ).rejects.toThrow("agent container exec failed");
  });

  it("passes container context to custom runners without forcing container exec", async () => {
    let captured: Parameters<AgentRunner>[0] | null = null;
    const customRunner: AgentRunner = vi.fn(async (params) => {
      captured = params;
      return { text: "runner-result" };
    });

    const node: AgentNode = {
      id: "agent-custom",
      type: "agent",
      prompt: "Hello from custom",
      container: {},
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      runId: "run-custom-ctx",
      containerPool: pool,
    };

    await executeAgent(node, context, { agentRunner: customRunner });

    expect(captured?.containerContext?.runId).toBe("run-custom-ctx");
    expect(captured?.containerContext?.pool).toBe(pool);
  });
});

/* ── Pipeline YAML container field ───────────────────────────────────── */

describe("Pipeline YAML container field", () => {
  it("build_from_plan.yaml has container field set", () => {
    // Read using the real (un-mocked) fs via Node's built-in readFileSync
    // The fs mock only patches mkdirSync/openSync/closeSync — readFileSync is passed through.
    const nodePath = new URL("../../pipelines/build_from_plan.yaml", import.meta.url).pathname;
    const content = require("node:fs").readFileSync(nodePath, "utf-8") as string;
    // Simple string check: "container:" must appear as a top-level YAML key
    expect(content).toMatch(/^container:/m);
  });

  it("bug_fix.yaml has container field set", () => {
    const nodePath = new URL("../../pipelines/bug_fix.yaml", import.meta.url).pathname;
    const content = require("node:fs").readFileSync(nodePath, "utf-8") as string;
    expect(content).toMatch(/^container:/m);
  });
});
