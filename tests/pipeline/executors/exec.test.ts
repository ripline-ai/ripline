import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecNode } from "../../../src/types.js";
import type { ExecutorContext } from "../../../src/pipeline/executors/types.js";

// ---------------------------------------------------------------------------
// Mock child_process before importing the module under test
// ---------------------------------------------------------------------------

let spawnSyncImpl: ReturnType<typeof vi.fn>;

vi.mock("child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncImpl(...args),
}));

const { executeExecNode } = await import(
  "../../../src/pipeline/executors/exec.js"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(
  artifacts: Record<string, unknown> = {}
): ExecutorContext {
  return {
    inputs: {},
    artifacts,
    env: {},
    outputs: {},
  };
}

function makeNode(overrides: Partial<ExecNode> = {}): ExecNode {
  return {
    id: "my-exec",
    type: "exec",
    command: "echo hello",
    ...overrides,
  };
}

function okResult(stdout = ""): object {
  return {
    status: 0,
    stdout,
    stderr: "",
    pid: 1,
    output: [null, stdout, ""],
    signal: null,
    error: undefined,
  };
}

function failResult(stderr = "command failed", stdout = ""): object {
  return {
    status: 1,
    stdout,
    stderr,
    pid: 1,
    output: [null, stdout, stderr],
    signal: null,
    error: undefined,
  };
}

beforeEach(() => {
  spawnSyncImpl = vi.fn();
});

// ---------------------------------------------------------------------------
// Basic command execution
// ---------------------------------------------------------------------------

describe("basic command execution", () => {
  it("captures stdout as artifact keyed by node.id", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult("hello world\n"));

    const node = makeNode({ command: "echo hello world" });
    const ctx = makeContext();

    const result = await executeExecNode(node, ctx);

    expect(result.artifactKey).toBe("my-exec");
    expect(result.value).toBe("hello world");
    expect(ctx.artifacts["my-exec"]).toBe("hello world");
  });

  it("stores null as artifact when captureOutput is false", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult("some output\n"));

    const node = makeNode({ command: "git add -A", captureOutput: false });
    const ctx = makeContext();

    const result = await executeExecNode(node, ctx);

    expect(result.value).toBeNull();
    expect(ctx.artifacts["my-exec"]).toBeNull();
  });

  it("passes the command to spawnSync with shell: true", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult(""));

    const node = makeNode({ command: "ls -la" });
    const ctx = makeContext();
    await executeExecNode(node, ctx);

    expect(spawnSyncImpl).toHaveBeenCalledOnce();
    const [cmd, opts] = spawnSyncImpl.mock.calls[0] as [string, { shell: boolean | string }];
    expect(cmd).toBe("ls -la");
    expect(opts.shell).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Template interpolation
// ---------------------------------------------------------------------------

describe("template interpolation", () => {
  it("interpolates {{varName}} in command from artifacts", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult("branch-output\n"));

    const node = makeNode({
      command: "git checkout -b {{branchName}}",
    });
    const ctx = makeContext({ branchName: "my-feature" });

    await executeExecNode(node, ctx);

    const [cmd] = spawnSyncImpl.mock.calls[0] as [string, object];
    expect(cmd).toBe("git checkout -b my-feature");
  });

  it("interpolates {{varName}} in cwd from artifacts", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult(""));

    const node = makeNode({
      command: "pwd",
      cwd: "/repos/{{repoName}}",
    });
    const ctx = makeContext({ repoName: "myapp" });

    await executeExecNode(node, ctx);

    const [, opts] = spawnSyncImpl.mock.calls[0] as [string, { cwd?: string }];
    expect(opts.cwd).toBe("/repos/myapp");
  });

  it("leaves unmatched {{placeholders}} unchanged", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult(""));

    const node = makeNode({ command: "echo {{missing}}" });
    const ctx = makeContext({});

    await executeExecNode(node, ctx);

    const [cmd] = spawnSyncImpl.mock.calls[0] as [string, object];
    expect(cmd).toBe("echo {{missing}}");
  });
});

// ---------------------------------------------------------------------------
// Non-zero exit throws
// ---------------------------------------------------------------------------

describe("non-zero exit", () => {
  it("throws an error containing node id and exit code on failure", async () => {
    spawnSyncImpl.mockReturnValue(failResult("fatal: not a repo"));

    const node = makeNode({ id: "fail-node", command: "git status" });
    const ctx = makeContext();

    await expect(executeExecNode(node, ctx)).rejects.toThrow(/fail-node/);
    await expect(executeExecNode(node, ctx)).rejects.toThrow(/exit 1/);
  });

  it("includes stderr in the error message", async () => {
    spawnSyncImpl.mockReturnValue(failResult("permission denied"));

    const node = makeNode({ command: "rm /root/secret" });
    const ctx = makeContext();

    await expect(executeExecNode(node, ctx)).rejects.toThrow(/permission denied/);
  });

  it("falls back to stdout detail when stderr is empty", async () => {
    spawnSyncImpl.mockReturnValue(failResult("", "some stdout message"));

    const node = makeNode({ command: "curl http://example.com" });
    const ctx = makeContext();

    await expect(executeExecNode(node, ctx)).rejects.toThrow(/some stdout message/);
  });
});

// ---------------------------------------------------------------------------
// cwd is set correctly
// ---------------------------------------------------------------------------

describe("cwd handling", () => {
  it("passes cwd to spawnSync when provided", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult(""));

    const node = makeNode({ command: "ls", cwd: "/tmp/myproject" });
    const ctx = makeContext();

    await executeExecNode(node, ctx);

    const [, opts] = spawnSyncImpl.mock.calls[0] as [string, { cwd?: string }];
    expect(opts.cwd).toBe("/tmp/myproject");
  });

  it("passes undefined cwd to spawnSync when not provided", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult(""));

    const node = makeNode({ command: "ls" });
    const ctx = makeContext();

    await executeExecNode(node, ctx);

    const [, opts] = spawnSyncImpl.mock.calls[0] as [string, { cwd?: string }];
    expect(opts.cwd).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Node env merging
// ---------------------------------------------------------------------------

describe("env merging", () => {
  it("merges node.env on top of context.env", async () => {
    spawnSyncImpl.mockReturnValueOnce(okResult(""));

    const node = makeNode({ command: "env", env: { MY_VAR: "from-node" } });
    const ctx: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: { MY_VAR: "from-context", CONTEXT_ONLY: "yes" },
      outputs: {},
    };

    await executeExecNode(node, ctx);

    const [, opts] = spawnSyncImpl.mock.calls[0] as [string, { env?: Record<string, string> }];
    expect(opts.env?.MY_VAR).toBe("from-node");
    expect(opts.env?.CONTEXT_ONLY).toBe("yes");
  });
});
