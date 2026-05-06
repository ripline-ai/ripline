import { describe, expect, it, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { collectAgentResult } from "../src/pipeline/executors/agent.js";
import type { AgentEvent } from "../src/pipeline/executors/agent.js";
import { createCodexRunner } from "../src/codex-runner.js";

// ---------------------------------------------------------------------------
// Fake child process factory
// ---------------------------------------------------------------------------

type FakeSpawnOptions = {
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  /** If set, emit an 'error' event instead of close */
  spawnError?: string;
  /** Delay (ms) before emitting close; 0 = synchronous via setImmediate */
  delay?: number;
};

function makeFakeChild(opts: FakeSpawnOptions): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess & {
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  const stdin = { write: vi.fn(), end: vi.fn() };
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  child.stdin = stdin as unknown as typeof child.stdin;
  child.stdout = stdoutEmitter as unknown as typeof child.stdout;
  child.stderr = stderrEmitter as unknown as typeof child.stderr;
  child.kill = vi.fn((signal?: string) => {
    setImmediate(() => {
      (child as unknown as EventEmitter).emit("close", signal === "SIGTERM" ? 1 : 1);
    });
    return true;
  });

  const fire = (): void => {
    if (opts.spawnError) {
      (child as unknown as EventEmitter).emit("error", new Error(opts.spawnError));
      return;
    }
    if (opts.stdout) stdoutEmitter.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) stderrEmitter.emit("data", Buffer.from(opts.stderr));
    (child as unknown as EventEmitter).emit("close", opts.exitCode ?? 0);
  };

  const delay = opts.delay ?? 0;
  if (delay > 0) {
    setTimeout(fire, delay);
  } else {
    setImmediate(fire);
  }

  return child as unknown as ChildProcess;
}

// ---------------------------------------------------------------------------
// Mock node:child_process
// ---------------------------------------------------------------------------

let spawnImpl: ReturnType<typeof vi.fn>;

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => spawnImpl(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Helper: run and collect result from a runner. */
async function run(
  runner: ReturnType<typeof createCodexRunner>,
  params: Parameters<(typeof runner)["run"]>[0],
  signal?: AbortSignal
) {
  return collectAgentResult(runner.run(params, signal));
}

/** Helper: collect all events from the generator. */
async function collectEvents(
  runner: ReturnType<typeof createCodexRunner>,
  params: Parameters<(typeof runner)["run"]>[0],
  signal?: AbortSignal
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runner.run(params, signal)) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCodexRunner – success path", () => {
  beforeEach(() => {
    spawnImpl = vi.fn();
  });

  it("returns AgentResult with trimmed stdout on exit 0", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stdout: "  Hello from codex\n", exitCode: 0 })
    );

    const runner = createCodexRunner();
    const result = await run(runner, { agentId: "default", prompt: "Say hello" });
    expect(result.text).toBe("Hello from codex");
  });

  it("spawns 'codex' binary by default", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });

    expect(spawnImpl).toHaveBeenCalledOnce();
    expect(spawnImpl.mock.calls[0]?.[0]).toBe("codex");
  });

  it("respects binaryPath config option", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner({ binaryPath: "/usr/local/bin/codex" });
    await run(runner, { agentId: "default", prompt: "Hi" });

    expect(spawnImpl.mock.calls[0]?.[0]).toBe("/usr/local/bin/codex");
  });

  it("passes exec, --skip-git-repo-check and '-' as args", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });

    const args: string[] = spawnImpl.mock.calls[0]?.[1] ?? [];
    expect(args).toContain("exec");
    expect(args).toContain("--skip-git-repo-check");
    expect(args).toContain("-");
  });

  it("appends --model arg when params.model is set", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner();
    await run(runner, { agentId: "default", prompt: "Hi", model: "o4-mini" });

    const args: string[] = spawnImpl.mock.calls[0]?.[1] ?? [];
    const modelIdx = args.indexOf("--model");
    expect(modelIdx).toBeGreaterThan(-1);
    expect(args[modelIdx + 1]).toBe("o4-mini");
  });

  it("does not include --model when params.model is not set", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });

    const args: string[] = spawnImpl.mock.calls[0]?.[1] ?? [];
    expect(args).not.toContain("--model");
  });

  it("writes prompt to stdin and closes it", async () => {
    let capturedChild: ReturnType<typeof makeFakeChild> | null = null;
    spawnImpl.mockImplementationOnce(() => {
      capturedChild = makeFakeChild({ stdout: "result", exitCode: 0 });
      return capturedChild;
    });

    const runner = createCodexRunner();
    await run(runner, { agentId: "default", prompt: "My prompt text" });

    expect((capturedChild as unknown as { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } })?.stdin.write).toHaveBeenCalledWith("My prompt text", "utf-8");
    expect((capturedChild as unknown as { stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } })?.stdin.end).toHaveBeenCalled();
  });

  it("uses cwd from config when params.cwd is not set", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner({ cwd: "/tmp/my-workspace" });
    await run(runner, { agentId: "default", prompt: "Hi" });

    const spawnOptions = spawnImpl.mock.calls[0]?.[2] as { cwd?: string };
    expect(spawnOptions?.cwd).toBe("/tmp/my-workspace");
  });

  it("params.cwd overrides config cwd", async () => {
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "ok", exitCode: 0 }));

    const runner = createCodexRunner({ cwd: "/tmp/config-cwd" });
    await run(runner, { agentId: "default", prompt: "Hi", cwd: "/tmp/params-cwd" });

    const spawnOptions = spawnImpl.mock.calls[0]?.[2] as { cwd?: string };
    expect(spawnOptions?.cwd).toBe("/tmp/params-cwd");
  });

  it("uses timeoutSeconds from params when provided", async () => {
    // This test just checks it doesn't throw; timeout behaviour tested separately
    spawnImpl.mockImplementationOnce(() => makeFakeChild({ stdout: "done", exitCode: 0 }));

    const runner = createCodexRunner();
    const result = await run(runner, { agentId: "default", prompt: "Hi", timeoutSeconds: 30 });
    expect(result.text).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Streaming event tests
// ---------------------------------------------------------------------------

describe("createCodexRunner – streaming events", () => {
  beforeEach(() => {
    spawnImpl = vi.fn();
  });

  it("yields text_delta events for stdout chunks before message_done", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stdout: "Hello\nworld\n", exitCode: 0 })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas.length).toBeGreaterThan(0);

    const messageDone = events.find((e) => e.type === "message_done");
    expect(messageDone).toBeDefined();

    // text_delta events must precede message_done
    const messageDoneIdx = events.indexOf(messageDone!);
    for (const delta of textDeltas) {
      expect(events.indexOf(delta)).toBeLessThan(messageDoneIdx);
    }
  });

  it("accumulated text_delta text matches message_done text", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stdout: "Hello\nworld\n", exitCode: 0 })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    const accumulated = events
      .filter((e): e is { type: "text_delta"; text: string } => e.type === "text_delta")
      .map((e) => e.text)
      .join("");

    const messageDone = events.find(
      (e): e is { type: "message_done"; text: string } => e.type === "message_done"
    );
    expect(messageDone).toBeDefined();
    // message_done text is the accumulated text (trimmed)
    expect(messageDone!.text).toBe(accumulated.trim());
  });

  it("yields message_done as the final event on success", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stdout: "result text\n", exitCode: 0 })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    expect(events[events.length - 1]?.type).toBe("message_done");
  });

  it("yields error as the final event on failure", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stderr: "something failed", exitCode: 1 })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    expect(events[events.length - 1]?.type).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// quota_exhausted tests
// ---------------------------------------------------------------------------

describe("createCodexRunner – quota_exhausted", () => {
  beforeEach(() => {
    spawnImpl = vi.fn();
  });

  it("throws quota_exhausted error when stderr contains anchored ERROR: hit your usage limit", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({
        stderr: "ERROR: hit your usage limit\nPlease upgrade your plan.",
        exitCode: 1,
      })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Do work" })).rejects.toThrow(
      /quota_exhausted/
    );
  });

  it("yields error event with kind quota_exhausted", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({
        stderr: "ERROR: hit your usage limit\nPlease upgrade your plan.",
        exitCode: 1,
      })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Do work" });
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string; message: string }
      | undefined;

    expect(errorEvent?.kind).toBe("quota_exhausted");
  });

  it("quota_exhausted error message includes 'hit usage limit'", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({
        stderr: "ERROR: hit your usage limit",
        exitCode: 1,
      })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Do work" })).rejects.toThrow(
      /hit usage limit/
    );
  });

  it("does NOT trigger quota_exhausted when ERROR: prefix is missing (prompt echo false-positive)", async () => {
    // Codex echoes the user prompt to stderr; it might contain "hit your usage limit"
    // mid-string but without the ERROR: prefix it must not trigger quota detection.
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({
        stderr: "Prompt: please hit your usage limit for testing",
        exitCode: 1,
      })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Do work" })).rejects.toThrow(
      /exited with code/
    );
  });

  it("quota_exhausted takes precedence over generic failure when both apply", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({
        stdout: "",
        stderr: "ERROR: hit your usage limit — subscribe at openai.com",
        exitCode: 1,
      })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Task" })).rejects.toThrow(
      /quota_exhausted/
    );
  });
});

// ---------------------------------------------------------------------------
// failure paths
// ---------------------------------------------------------------------------

describe("createCodexRunner – failure paths", () => {
  beforeEach(() => {
    spawnImpl = vi.fn();
  });

  it("throws with exit code when codex exits non-zero without quota error", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stderr: "some error", exitCode: 2 })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Hi" })).rejects.toThrow(
      /exited with code 2/
    );
  });

  it("includes stderr snippet in generic failure message", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stderr: "Not inside a trusted directory", exitCode: 1 })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Hi" })).rejects.toThrow(
      /Not inside a trusted directory/
    );
  });

  it("throws spawn error when process fails to start", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ spawnError: "ENOENT" })
    );

    const runner = createCodexRunner();
    await expect(run(runner, { agentId: "default", prompt: "Hi" })).rejects.toThrow(
      /failed to spawn codex.*ENOENT/i
    );
  });

  it("yields error event with kind spawn_failed on spawn error", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ spawnError: "ENOENT" })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string }
      | undefined;

    expect(errorEvent?.kind).toBe("spawn_failed");
  });

  it("yields error event with kind cli_failed on non-zero exit", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stderr: "some error", exitCode: 2 })
    );

    const runner = createCodexRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string }
      | undefined;

    expect(errorEvent?.kind).toBe("cli_failed");
  });
});

// ---------------------------------------------------------------------------
// abort signal
// ---------------------------------------------------------------------------

describe("createCodexRunner – abort signal", () => {
  beforeEach(() => {
    spawnImpl = vi.fn();
  });

  it("kills subprocess when AbortSignal fires", async () => {
    let capturedChild: ReturnType<typeof makeFakeChild> | null = null;
    spawnImpl.mockImplementationOnce(() => {
      // Long delay so the abort fires first
      capturedChild = makeFakeChild({ stdout: "ok", exitCode: 0, delay: 5000 });
      return capturedChild;
    });

    const controller = new AbortController();
    const runner = createCodexRunner({ timeoutMs: 60_000 });

    const promise = run(runner, { agentId: "default", prompt: "Hi" }, controller.signal);

    // Abort after a tick
    setImmediate(() => controller.abort());

    // The promise rejects or resolves — we just want the kill to be called
    await promise.catch(() => {});

    expect((capturedChild as unknown as { kill: ReturnType<typeof vi.fn> })?.kill).toHaveBeenCalled();
  });

  it("rejects immediately when AbortSignal is already aborted", async () => {
    let capturedChild: ReturnType<typeof makeFakeChild> | null = null;
    spawnImpl.mockImplementationOnce(() => {
      capturedChild = makeFakeChild({ stdout: "ok", exitCode: 0, delay: 5000 });
      return capturedChild;
    });

    const controller = new AbortController();
    controller.abort();

    const runner = createCodexRunner({ timeoutMs: 60_000 });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" }, controller.signal)
    ).rejects.toThrow(/aborted/);

    // Child should not have been spawned since abort check is pre-spawn
    void capturedChild; // capturedChild may be null if spawn was skipped
  });

  it("yields error event with kind aborted on abort", async () => {
    spawnImpl.mockImplementationOnce(() =>
      makeFakeChild({ stdout: "ok", exitCode: 0, delay: 5000 })
    );

    const controller = new AbortController();
    const runner = createCodexRunner({ timeoutMs: 60_000 });

    const collectPromise = collectEvents(
      runner,
      { agentId: "default", prompt: "Hi" },
      controller.signal
    );

    setImmediate(() => controller.abort());
    const events = await collectPromise;

    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string }
      | undefined;
    expect(errorEvent?.kind).toBe("aborted");
  });
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

describe("createCodexRunner – timeout", () => {
  beforeEach(() => {
    spawnImpl = vi.fn();
  });

  it("rejects with timeout error when process exceeds timeoutMs", async () => {
    spawnImpl.mockImplementationOnce(() =>
      // delay longer than our short timeout
      makeFakeChild({ stdout: "ok", exitCode: 0, delay: 5000 })
    );

    const runner = createCodexRunner({ timeoutMs: 50 });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/timed out/i);
  }, 10_000);
});
