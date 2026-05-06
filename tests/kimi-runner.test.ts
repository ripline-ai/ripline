import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { collectAgentResult } from "../src/pipeline/executors/agent.js";
import type { AgentRunner, AgentRunParams, AgentEvent } from "../src/pipeline/executors/agent.js";

/** Run and collect result from any AgentRunner (convenience for backward-compat tests). */
async function run(runner: AgentRunner, params: AgentRunParams, signal?: AbortSignal) {
  return collectAgentResult(runner.run(params, signal));
}

/** Collect the raw event sequence from a runner. */
async function collectEvents(
  runner: AgentRunner,
  params: AgentRunParams,
  signal?: AbortSignal
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runner.run(params, signal)) {
    events.push(event);
  }
  return events;
}

// ── Mock child_process ────────────────────────────────────────────────────────

type SpawnArgs = { command: string; args: string[]; options: Record<string, unknown> };
let spawnCallArgs: SpawnArgs | null = null;
let mockChildFactory: () => MockChild = () => makeMockChild();

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: Record<string, unknown>) => {
    spawnCallArgs = { command, args, options };
    return mockChildFactory();
  },
}));

// ── MockChild helper ──────────────────────────────────────────────────────────

class MockChild extends EventEmitter {
  stdin: Writable & { writtenData: string };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killedWith: string | null = null;

  constructor() {
    super();
    this.stdin = Object.assign(new Writable({ write: (chunk, _enc, cb) => { this.stdin.writtenData += String(chunk); cb(); } }), { writtenData: "" });
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal?: string): boolean {
    this.killedWith = signal ?? "SIGTERM";
    return true;
  }

  /** Emit a text delta event on stdout. */
  emitText(text: string): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify({ type: "text", text }) + "\n"));
  }

  /** Emit a final result event on stdout. */
  emitResult(result: string): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", result }) + "\n"));
    this.emit("close", 0);
  }

  /** Emit an error result event on stdout. */
  emitErrorResult(errorMsg: string): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify({ type: "result", subtype: "error", error: errorMsg }) + "\n"));
    this.emit("close", 1);
  }

  /** Emit close without any output. */
  emitClose(code = 0): void {
    this.emit("close", code);
  }

  /** Emit stderr data. */
  emitStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }

  /** Emit a spawn error. */
  emitError(err: Error): void {
    this.emit("error", err);
    this.emit("close", null);
  }
}

function makeMockChild(): MockChild {
  return new MockChild();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("createKimiRunner", () => {
  let currentChild: MockChild;

  beforeEach(() => {
    spawnCallArgs = null;
    currentChild = makeMockChild();
    mockChildFactory = () => currentChild;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Spawn args ──────────────────────────────────────────────────────────────

  it("spawns kimi with --print --output-format stream-json", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitResult("World");
    await runPromise;

    expect(spawnCallArgs?.command).toBe("kimi");
    expect(spawnCallArgs?.args).toEqual(["--print", "--output-format", "stream-json"]);
  });

  it("uses custom binaryPath when provided", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner({ binaryPath: "/usr/local/bin/kimi" });

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitResult("ok");
    await runPromise;

    expect(spawnCallArgs?.command).toBe("/usr/local/bin/kimi");
  });

  it("appends -m <model> when params.model is set", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, {
      agentId: "default",
      prompt: "Hi",
      model: "kimi-k2.6",
    });
    currentChild.emitResult("ok");
    await runPromise;

    expect(spawnCallArgs?.args).toContain("-m");
    expect(spawnCallArgs?.args).toContain("kimi-k2.6");
  });

  it("does not add -m flag when model is not set", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitResult("ok");
    await runPromise;

    expect(spawnCallArgs?.args).not.toContain("-m");
  });

  it("writes prompt to stdin and closes it", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Test prompt" });
    currentChild.emitResult("ok");
    await runPromise;

    expect(currentChild.stdin.writtenData).toContain("Test prompt");
  });

  // ── Event sequence verification ─────────────────────────────────────────────

  it("yields text_delta events for each text chunk before message_done", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitText("Hello ");
    currentChild.emitText("World");
    currentChild.emitResult("Hello World");
    const events = await eventsPromise;

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello " });
    expect(textDeltas[1]).toEqual({ type: "text_delta", text: "World" });

    const done = events.find((e) => e.type === "message_done");
    expect(done).toBeDefined();
    expect((done as Extract<AgentEvent, { type: "message_done" }>).text).toBe("Hello World");
  });

  it("yields message_done as the last event in the stream", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitText("partial");
    currentChild.emitResult("final");
    const events = await eventsPromise;

    expect(events[events.length - 1]?.type).toBe("message_done");
  });

  // ── Text accumulation ───────────────────────────────────────────────────────

  it("returns text from result event", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitResult("The answer is 42");
    const result = await runPromise;

    expect(result.text).toBe("The answer is 42");
  });

  it("accumulates text deltas and returns them from result event", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitText("Hello ");
    currentChild.emitText("World");
    // result event without result field → falls back to buffer
    currentChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ type: "result" }) + "\n")
    );
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("Hello World");
  });

  it("prefers result field on result event over accumulated buffer", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitText("buffered text");
    currentChild.emitResult("final result wins");
    const result = await runPromise;

    expect(result.text).toBe("final result wins");
  });

  it("resolves with accumulated text buffer when process closes without result event", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitText("partial ");
    currentChild.emitText("output");
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("partial output");
  });

  it("includes usage in message_done when result carries usage fields", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({
        type: "result",
        result: "answer",
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 5 },
      }) + "\n")
    );
    currentChild.emitClose(0);
    const events = await eventsPromise;

    const done = events.find((e) => e.type === "message_done") as Extract<AgentEvent, { type: "message_done" }> | undefined;
    expect(done).toBeDefined();
    expect(done?.usage?.inputTokens).toBe(10);
    expect(done?.usage?.outputTokens).toBe(20);
    expect(done?.usage?.cachedInputTokens).toBe(5);
  });

  // ── CWD handling ─────────────────────────────────────────────────────────────

  it("uses params.cwd when provided", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, {
      agentId: "default",
      prompt: "Hi",
      cwd: "/tmp/test-dir",
    });
    currentChild.emitResult("ok");
    await runPromise;

    expect(spawnCallArgs?.options?.cwd).toBe("/tmp/test-dir");
  });

  it("uses config.cwd when params.cwd is not set", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner({ cwd: "/tmp/config-dir" });

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitResult("ok");
    await runPromise;

    expect(spawnCallArgs?.options?.cwd).toBe("/tmp/config-dir");
  });

  // ── Error classification ─────────────────────────────────────────────────────

  it("throws when process fails to spawn (ENOENT)", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitError(new Error("ENOENT: kimi not found"));

    await expect(runPromise).rejects.toThrow(/kimi.*ENOENT|ENOENT.*kimi/i);
  });

  it("yields error event with kind=spawn_failed on generic spawn error", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const spawnErr = new Error("spawn error");
    (spawnErr as NodeJS.ErrnoException).code = "EACCES";
    currentChild.emitError(spawnErr);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.kind).toBe("spawn_failed");
  });

  it("yields error event with kind=cli_not_in_path on ENOENT spawn error", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const enoentErr = new Error("ENOENT: no such file or directory");
    (enoentErr as NodeJS.ErrnoException).code = "ENOENT";
    currentChild.emitError(enoentErr);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("cli_not_in_path");
  });

  it("throws when process exits without any output", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitStderr("LLM not set");
    currentChild.emitClose(1);

    await expect(runPromise).rejects.toThrow(/LLM not set|without output/i);
  });

  it("yields error event with kind=cli_failed on error result event", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitErrorResult("quota exceeded");
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.kind).toBe("cli_failed");
    expect(errEvent?.message).toMatch(/quota exceeded/i);
  });

  // ── Timeout ──────────────────────────────────────────────────────────────────

  it("times out and kills the process when timeoutMs is exceeded", async () => {
    vi.useFakeTimers();
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner({ timeoutMs: 1000 });

    const runPromise = run(runner, { agentId: "default", prompt: "slow" });
    vi.advanceTimersByTime(1001);

    await expect(runPromise).rejects.toThrow(/timed out/i);
    expect(currentChild.killedWith).toBe("SIGTERM");
    vi.useRealTimers();
  });

  it("uses params.timeoutSeconds over config.timeoutMs", async () => {
    vi.useFakeTimers();
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    // Config says 60 seconds, params says 5 seconds
    const runner = createKimiRunner({ timeoutMs: 60_000 });

    const runPromise = run(runner, {
      agentId: "default",
      prompt: "slow",
      timeoutSeconds: 5,
    });
    vi.advanceTimersByTime(5001);

    await expect(runPromise).rejects.toThrow(/timed out/i);
    vi.useRealTimers();
  });

  it("yields error event with kind=timeout on timeout", async () => {
    vi.useFakeTimers();
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner({ timeoutMs: 1000 });

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "slow" });
    vi.advanceTimersByTime(1001);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("timeout");
    vi.useRealTimers();
  });

  // ── Abort behavior ──────────────────────────────────────────────────────────

  it("yields error event with kind=aborted when AbortSignal fires", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const controller = new AbortController();
    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "slow" }, controller.signal);

    // Abort after generator starts
    await Promise.resolve();
    controller.abort();
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("aborted");
    expect(currentChild.killedWith).toBe("SIGTERM");
  });

  it("yields error immediately when AbortSignal is already aborted", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const controller = new AbortController();
    controller.abort();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" }, controller.signal);

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("aborted");
  });

  // ── Resilience ───────────────────────────────────────────────────────────────

  it("ignores non-JSON lines without throwing", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.stdout.emit("data", Buffer.from("not json\n"));
    currentChild.stdout.emit("data", Buffer.from("also not json\n"));
    currentChild.emitResult("final");
    const result = await runPromise;

    expect(result.text).toBe("final");
  });

  it("handles multi-line chunks split across data events", async () => {
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    // Send partial first line
    currentChild.stdout.emit(
      "data",
      Buffer.from('{"type":"text","tex')
    );
    // Complete first line and start second
    currentChild.stdout.emit(
      "data",
      Buffer.from('t":"hi"}\n{"type":"result","result":"done"}\n')
    );
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("done");
  });

  it("emits progress heartbeat events while process is running", async () => {
    vi.useFakeTimers();
    const { createKimiRunner } = await import("../src/kimi-runner.js");
    const runner = createKimiRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "slow" });

    // Advance time to trigger heartbeats
    vi.advanceTimersByTime(11_000);
    // Then emit result to finish
    currentChild.emitResult("done");
    const events = await eventsPromise;

    const heartbeats = events.filter((e) => e.type === "progress");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
});
