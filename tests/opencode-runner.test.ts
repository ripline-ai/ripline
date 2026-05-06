import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
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
  stdin: { write: () => void; end: () => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  killedWith: string | null = null;

  constructor() {
    super();
    this.stdin = { write: () => {}, end: () => {} };
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(signal?: string): boolean {
    this.killedWith = signal ?? "SIGTERM";
    return true;
  }

  /** Emit a JSON-Lines line on stdout. */
  emitLine(obj: unknown): void {
    this.stdout.emit("data", Buffer.from(JSON.stringify(obj) + "\n"));
  }

  /** Emit a message_done event and close. */
  emitMessageDone(content: string): void {
    this.emitLine({ type: "message_done", message: { role: "assistant", content } });
    this.emit("close", 0);
  }

  /** Emit a modern step_finish event with token counts. */
  emitStepFinish(tokens: { input?: number; output?: number; cacheRead?: number; cost?: number }): void {
    this.emitLine({
      type: "step_finish",
      part: {
        tokens: {
          ...(tokens.input !== undefined && { input: tokens.input }),
          ...(tokens.output !== undefined && { output: tokens.output }),
          ...(tokens.cacheRead !== undefined && { cache: { read: tokens.cacheRead } }),
        },
        ...(tokens.cost !== undefined && { cost: tokens.cost }),
      },
    });
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

describe("createOpenCodeRunner", () => {
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

  it("spawns opencode with run --format json", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitMessageDone("World");
    await runPromise;

    expect(spawnCallArgs?.command).toBe("opencode");
    expect(spawnCallArgs?.args?.[0]).toBe("run");
    expect(spawnCallArgs?.args?.[1]).toBe("--format");
    expect(spawnCallArgs?.args?.[2]).toBe("json");
  });

  it("passes the prompt as the last positional argument", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "My prompt text" });
    currentChild.emitMessageDone("ok");
    await runPromise;

    expect(spawnCallArgs?.args?.[spawnCallArgs.args.length - 1]).toBe(
      "My prompt text"
    );
  });

  it("uses custom binaryPath when provided", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner({ binaryPath: "/opt/bin/opencode" });

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitMessageDone("ok");
    await runPromise;

    expect(spawnCallArgs?.command).toBe("/opt/bin/opencode");
  });

  it("appends --model <model> when params.model is set", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, {
      agentId: "default",
      prompt: "Hi",
      model: "opencode-go/kimi-k2.6",
    });
    currentChild.emitMessageDone("ok");
    await runPromise;

    expect(spawnCallArgs?.args).toContain("--model");
    expect(spawnCallArgs?.args).toContain("opencode-go/kimi-k2.6");
  });

  it("does not add --model flag when model is not set", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitMessageDone("ok");
    await runPromise;

    expect(spawnCallArgs?.args).not.toContain("--model");
  });

  // ── Event sequence verification ─────────────────────────────────────────────

  it("yields text_delta events for modern part.text format", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "text", part: { text: "Hello " } });
    currentChild.emitLine({ type: "text", part: { text: "World" } });
    currentChild.emitStepFinish({ input: 10, output: 5 });
    currentChild.emitClose(0);
    const events = await eventsPromise;

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello " });
    expect(textDeltas[1]).toEqual({ type: "text_delta", text: "World" });
  });

  it("yields message_done as the last event in the stream", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitMessageDone("answer");
    const events = await eventsPromise;

    expect(events[events.length - 1]?.type).toBe("message_done");
  });

  it("aggregates usage from multiple step_finish events", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "text", part: { text: "A" } });
    currentChild.emitStepFinish({ input: 10, output: 5, cost: 0.001 });
    currentChild.emitLine({ type: "text", part: { text: "B" } });
    currentChild.emitStepFinish({ input: 8, output: 4, cost: 0.0008 });
    currentChild.emitClose(0);
    const events = await eventsPromise;

    const done = events.find((e) => e.type === "message_done") as Extract<AgentEvent, { type: "message_done" }> | undefined;
    expect(done).toBeDefined();
    expect(done?.usage?.inputTokens).toBe(18);
    expect(done?.usage?.outputTokens).toBe(9);
    expect(done?.usage?.costUsd).toBeCloseTo(0.0018, 5);
  });

  it("aggregates cachedInputTokens from step_finish events", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "text", part: { text: "response" } });
    currentChild.emitStepFinish({ input: 100, output: 50, cacheRead: 25 });
    currentChild.emitClose(0);
    const events = await eventsPromise;

    const done = events.find((e) => e.type === "message_done") as Extract<AgentEvent, { type: "message_done" }> | undefined;
    expect(done?.usage?.cachedInputTokens).toBe(25);
  });

  // ── Text accumulation ───────────────────────────────────────────────────────

  it("returns text from message_done event", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitMessageDone("The answer is 42");
    const result = await runPromise;

    expect(result.text).toBe("The answer is 42");
  });

  it("returns text from streaming text delta events (legacy format)", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "text", text: "Hello " });
    currentChild.emitLine({ type: "text", text: "World" });
    // Close without message_done — should fall back to text buffer
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("Hello World");
  });

  it("returns text from streaming text delta events (modern part.text format)", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "text", part: { text: "Modern " } });
    currentChild.emitLine({ type: "text", part: { text: "format" } });
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("Modern format");
  });

  it("returns text from result event (Claude-Code-compatible format)", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "result", result: "Claude-compat result" });
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("Claude-compat result");
  });

  it("parses full-stdout JSON blob on close when no streaming events matched", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    // Emit as a single non-newline-terminated blob (simulating isatty flush)
    currentChild.stdout.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          type: "message_done",
          message: { role: "assistant", content: "One-shot response" },
        })
      )
    );
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("One-shot response");
  });

  it("handles message_done with empty content by falling back to text buffer", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.emitLine({ type: "text", text: "accumulated text" });
    // message_done with no content
    currentChild.emitLine({ type: "message_done", message: { role: "assistant", content: "" } });
    currentChild.emitClose(0);
    const result = await runPromise;

    expect(result.text).toBe("accumulated text");
  });

  // ── CWD handling ─────────────────────────────────────────────────────────────

  it("uses params.cwd when provided", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, {
      agentId: "default",
      prompt: "Hi",
      cwd: "/tmp/test-dir",
    });
    currentChild.emitMessageDone("ok");
    await runPromise;

    expect(spawnCallArgs?.options?.cwd).toBe("/tmp/test-dir");
  });

  it("uses config.cwd when params.cwd is not set", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner({ cwd: "/tmp/config-dir" });

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitMessageDone("ok");
    await runPromise;

    expect(spawnCallArgs?.options?.cwd).toBe("/tmp/config-dir");
  });

  // ── Error classification ─────────────────────────────────────────────────────

  it("throws when process fails to spawn (ENOENT)", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitError(new Error("ENOENT: opencode not found"));

    await expect(runPromise).rejects.toThrow(/opencode.*ENOENT|ENOENT.*opencode/i);
  });

  it("yields error event with kind=cli_not_in_path on ENOENT spawn error", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const enoentErr = new Error("ENOENT: no such file or directory");
    (enoentErr as NodeJS.ErrnoException).code = "ENOENT";
    currentChild.emitError(enoentErr);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("cli_not_in_path");
  });

  it("yields error event with kind=spawn_failed on generic spawn error", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const spawnErr = new Error("spawn error");
    (spawnErr as NodeJS.ErrnoException).code = "EACCES";
    currentChild.emitError(spawnErr);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("spawn_failed");
  });

  it("throws when process exits without any output", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitStderr("model not configured");
    currentChild.emitClose(1);

    await expect(runPromise).rejects.toThrow(/model not configured|failed|without output/i);
  });

  it("yields error event with kind=cli_failed on non-zero exit with no output", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "Hi" });
    currentChild.emitStderr("authentication failed");
    currentChild.emitClose(1);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent).toBeDefined();
    expect(errEvent?.kind).toBe("cli_failed");
    expect(errEvent?.message).toMatch(/authentication failed/i);
  });

  // ── Timeout ──────────────────────────────────────────────────────────────────

  it("times out and kills the process when timeoutMs is exceeded", async () => {
    vi.useFakeTimers();
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner({ timeoutMs: 1000 });

    const runPromise = run(runner, { agentId: "default", prompt: "slow" });
    vi.advanceTimersByTime(1001);

    await expect(runPromise).rejects.toThrow(/timed out/i);
    expect(currentChild.killedWith).toBe("SIGTERM");
    vi.useRealTimers();
  });

  it("uses params.timeoutSeconds over config.timeoutMs", async () => {
    vi.useFakeTimers();
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner({ timeoutMs: 60_000 });

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
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner({ timeoutMs: 1000 });

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "slow" });
    vi.advanceTimersByTime(1001);
    const events = await eventsPromise;

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("timeout");
    vi.useRealTimers();
  });

  // ── Abort behavior ──────────────────────────────────────────────────────────

  it("yields error event with kind=aborted when AbortSignal fires", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

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
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const controller = new AbortController();
    controller.abort();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" }, controller.signal);

    const errEvent = events.find((e) => e.type === "error") as Extract<AgentEvent, { type: "error" }> | undefined;
    expect(errEvent?.kind).toBe("aborted");
  });

  // ── Resilience ───────────────────────────────────────────────────────────────

  it("ignores non-JSON lines without throwing", async () => {
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const runPromise = run(runner, { agentId: "default", prompt: "Hello" });
    currentChild.stdout.emit("data", Buffer.from("debug output\n"));
    currentChild.emitMessageDone("final answer");
    const result = await runPromise;

    expect(result.text).toBe("final answer");
  });

  it("emits progress heartbeat events while process is running", async () => {
    vi.useFakeTimers();
    const { createOpenCodeRunner } = await import("../src/opencode-runner.js");
    const runner = createOpenCodeRunner();

    const eventsPromise = collectEvents(runner, { agentId: "default", prompt: "slow" });

    // Advance time to trigger heartbeats
    vi.advanceTimersByTime(11_000);
    // Then emit result to finish
    currentChild.emitMessageDone("done");
    const events = await eventsPromise;

    const heartbeats = events.filter((e) => e.type === "progress");
    expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    vi.useRealTimers();
  });
});
