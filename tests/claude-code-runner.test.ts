import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createClaudeCodeRunner } from "../src/claude-code-runner.js";
import { collectAgentResult } from "../src/pipeline/executors/agent.js";
import type { AgentRunner, AgentRunParams, AgentEvent } from "../src/pipeline/executors/agent.js";

/** Run and collect result from any AgentRunner. */
async function run(runner: AgentRunner, params: AgentRunParams, signal?: AbortSignal) {
  return collectAgentResult(runner.run(params, signal));
}

/** Collect all events from a runner as an array. */
async function collectEvents(runner: AgentRunner, params: AgentRunParams, signal?: AbortSignal): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runner.run(params, signal)) {
    events.push(event);
  }
  return events;
}

let capturedQueryArgs: { prompt: string; options?: Record<string, unknown> } | null = null;
let mockYieldMessages: unknown[] = [{ type: "result", subtype: "success", result: "done" }];
// Allow individual tests to override the generator factory
let mockQueryOverride: ((args: { prompt: string; options?: Record<string, unknown> }) => AsyncGenerator<unknown>) | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options?: Record<string, unknown> }) => {
    capturedQueryArgs = args;
    if (mockQueryOverride) {
      const override = mockQueryOverride;
      mockQueryOverride = null;
      return override(args);
    }
    const messages = mockYieldMessages;
    return (async function* () {
      for (const msg of messages) {
        yield msg;
      }
    })();
  },
}));

describe("Claude Code runner – model", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    mockYieldMessages = [{ type: "result", subtype: "success", result: "done" }];
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("passes params.model to SDK options when node sets model", async () => {
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await run(runner, {
      agentId: "default",
      prompt: "Hello",
      cwd,
      model: "claude-opus-4-6",
    });

    expect(capturedQueryArgs?.options?.model).toBe("claude-opus-4-6");
  });

  it("passes config.model to SDK options when params.model is not set", async () => {
    const runner = createClaudeCodeRunner({
      mode: "execute",
      model: "claude-sonnet-4-6",
    });
    await run(runner, {
      agentId: "default",
      prompt: "Hi",
      cwd,
    });

    expect(capturedQueryArgs?.options?.model).toBe("claude-sonnet-4-6");
  });

  it("prefers params.model over config.model", async () => {
    const runner = createClaudeCodeRunner({
      mode: "execute",
      model: "claude-sonnet-4-6",
    });
    await run(runner, {
      agentId: "default",
      prompt: "Hi",
      cwd,
      model: "claude-opus-4-6",
    });

    expect(capturedQueryArgs?.options?.model).toBe("claude-opus-4-6");
  });

  it("does not set model in options when neither params nor config provide model", async () => {
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await run(runner, {
      agentId: "default",
      prompt: "Hi",
      cwd,
    });

    expect(capturedQueryArgs?.options).not.toHaveProperty("model");
  });
});

describe("Claude Code runner – non-success error message", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    mockYieldMessages = [{ type: "result", subtype: "success", result: "done" }];
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("includes subtype, errors, and result snippet in thrown message when subtype is not success", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "error_max_turns",
        errors: [],
      },
    ];
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/Claude Code runner:.*subtype=error_max_turns.*errors=\[\]/);
  });

  it("includes result in thrown message when result is present on non-success", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "error_timeout",
        errors: ["timed out"],
        result: "partial output here",
      },
    ];
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/result=partial output here/);
  });

  it("logs FAILED to stderr before yielding error on non-success", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockYieldMessages = [
      {
        type: "result",
        subtype: "error_max_turns",
        errors: ["max turns reached"],
      },
    ];
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/Claude Code runner:/);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[claude-code-runner\] FAILED:.*subtype=error_max_turns/)
    );
    stderrSpy.mockRestore();
  });

  it("yields error event (not throws) for non-success result", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "error_max_turns",
        errors: ["max turns"],
      },
    ];
    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "error",
      kind: "cli_failed",
    });
    expect((events[0] as { message: string }).message).toMatch(/subtype=error_max_turns/);
  });
});

describe("Claude Code runner – config logging", () => {
  let cwd: string;
  const originalLogConfig = process.env.RIPLINE_LOG_CONFIG;

  beforeEach(() => {
    capturedQueryArgs = null;
    mockYieldMessages = [{ type: "result", subtype: "success", result: "done" }];
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    if (originalLogConfig !== undefined) process.env.RIPLINE_LOG_CONFIG = originalLogConfig;
    else delete process.env.RIPLINE_LOG_CONFIG;
  });

  it("logs config to stderr when RIPLINE_LOG_CONFIG=1", async () => {
    process.env.RIPLINE_LOG_CONFIG = "1";
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[claude-code-runner\] maxTurns=\d+ timeoutMs=\d+ mode=execute cwd=/)
    );
    stderrSpy.mockRestore();
  });

  it("does not log config when RIPLINE_LOG_CONFIG is not set", async () => {
    delete process.env.RIPLINE_LOG_CONFIG;
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await run(runner, { agentId: "default", prompt: "Hi", cwd });
    const configCalls = stderrSpy.mock.calls.filter((c) =>
      String(c[0]).startsWith("[claude-code-runner] maxTurns=")
    );
    expect(configCalls).toHaveLength(0);
    stderrSpy.mockRestore();
  });
});

describe("Claude Code runner – CLAUDECODE env restore", () => {
  let cwd: string;
  const originalClaudeCode = process.env.CLAUDECODE;

  beforeEach(() => {
    capturedQueryArgs = null;
    mockYieldMessages = [{ type: "result", subtype: "success", result: "done" }];
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    if (originalClaudeCode !== undefined) process.env.CLAUDECODE = originalClaudeCode;
    else delete process.env.CLAUDECODE;
  });

  it("restores CLAUDECODE after run when it was set", async () => {
    process.env.CLAUDECODE = "nested";
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(process.env.CLAUDECODE).toBe("nested");
  });
});

// ---------------------------------------------------------------------------
// Real streaming event tests
// ---------------------------------------------------------------------------

describe("Claude Code runner – streaming text_delta events", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("yields text_delta events for stream_event/content_block_delta messages", async () => {
    mockYieldMessages = [
      {
        type: "stream_event",
        event: { type: "content_block_start", index: 0, content_block: { type: "text" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: ", world" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
      {
        type: "result",
        subtype: "success",
        result: "Hello, world",
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd });

    const textDeltas = events.filter((e) => e.type === "text_delta");
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({ type: "text_delta", text: "Hello" });
    expect(textDeltas[1]).toEqual({ type: "text_delta", text: ", world" });

    const done = events.find((e) => e.type === "message_done");
    expect(done).toBeDefined();
    expect((done as { text: string }).text).toBe("Hello, world");
  });

  it("text from result is used for message_done even when text_delta events were streamed", async () => {
    mockYieldMessages = [
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "chunk" } },
      },
      {
        type: "result",
        subtype: "success",
        result: "final-authoritative-text",
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const result = await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(result.text).toBe("final-authoritative-text");
  });

  it("collects full text from text_delta sequence via collectAgentResult", async () => {
    mockYieldMessages = [
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "A" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "B" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "C" } },
      },
      {
        type: "result",
        subtype: "success",
        result: "ABC",
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    // collectAgentResult should return message_done text, not accumulated text_deltas
    const result = await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(result.text).toBe("ABC");
  });
});

describe("Claude Code runner – tool_call_start/end events", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("yields tool_call_start event when content_block_start has type tool_use", async () => {
    mockYieldMessages = [
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "tool-123", name: "Read", input: {} },
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd });

    const toolStart = events.find((e) => e.type === "tool_call_start");
    expect(toolStart).toBeDefined();
    expect(toolStart).toMatchObject({ type: "tool_call_start", id: "tool-123", name: "Read" });
  });

  it("yields tool_call_end event when assistant message has tool_use content block", async () => {
    mockYieldMessages = [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool-456", name: "Write", input: { path: "/tmp/x", content: "hi" } },
          ],
        },
      },
      {
        type: "result",
        subtype: "success",
        result: "done",
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd });

    const toolEnd = events.find((e) => e.type === "tool_call_end");
    expect(toolEnd).toBeDefined();
    expect(toolEnd).toMatchObject({ type: "tool_call_end", id: "tool-456" });
    expect((toolEnd as { output: unknown }).output).toMatchObject({ path: "/tmp/x", content: "hi" });
  });
});

describe("Claude Code runner – message_done with usage", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("includes inputTokens and outputTokens in message_done usage from snake_case fields", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "success",
        result: "response text",
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const result = await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(result.text).toBe("response text");
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
  });

  it("includes cachedInputTokens when cache_read_input_tokens is present", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "success",
        result: "resp",
        usage: { input_tokens: 200, output_tokens: 30, cache_read_input_tokens: 150 },
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const result = await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(result.usage?.cachedInputTokens).toBe(150);
  });

  it("includes costUsd from total_cost_usd in message_done", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "success",
        result: "resp",
        total_cost_usd: 0.002,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const result = await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(result.usage?.costUsd).toBeCloseTo(0.002);
  });

  it("omits usage when no usage field is present on result", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "success",
        result: "resp",
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const result = await run(runner, { agentId: "default", prompt: "Hi", cwd });
    expect(result.usage).toBeUndefined();
  });
});

describe("Claude Code runner – error events (not throws)", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("yields error event when SDK throws (no message_done thrown through generator)", async () => {
    // Override the mock so query's generator throws
    mockQueryOverride = () => (async function* () {
      throw new Error("SDK blew up");
      yield null as never; // eslint-disable-line no-unreachable
    })();

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error" });
    expect((events[0] as { message: string }).message).toMatch(/SDK blew up/);
  });

  it("collectAgentResult throws on error event (backward compat)", async () => {
    mockYieldMessages = [
      {
        type: "result",
        subtype: "error_during_execution",
        errors: ["something went wrong"],
      },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/Agent error \[cli_failed\]/);
  });
});

describe("Claude Code runner – AbortSignal", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("yields aborted error event when signal is pre-aborted", async () => {
    // Simulate the SDK throwing AbortError when the signal is already aborted
    mockQueryOverride = () => (async function* () {
      const err = new Error("The operation was aborted.");
      err.name = "AbortError";
      throw err;
      yield null as never; // eslint-disable-line no-unreachable
    })();

    const controller = new AbortController();
    controller.abort();

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd }, controller.signal);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", kind: "aborted" });
  });

  it("yields aborted error event when signal is aborted mid-stream", async () => {
    const controller = new AbortController();

    // Simulate abort mid-stream: generator aborts after first message
    mockQueryOverride = () => (async function* () {
      controller.abort();
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
      yield null as never; // eslint-disable-line no-unreachable
    })();

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd }, controller.signal);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", kind: "aborted" });
  });
});

describe("Claude Code runner – progress heartbeat", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not yield progress events when messages arrive quickly (< 5s)", async () => {
    mockYieldMessages = [
      {
        type: "stream_event",
        event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      },
      { type: "result", subtype: "success", result: "hi" },
    ];

    const runner = createClaudeCodeRunner({ mode: "execute" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi", cwd });

    // No progress events expected when messages arrive quickly (< 5s)
    const progressEvents = events.filter((e) => e.type === "progress");
    expect(progressEvents).toHaveLength(0);
  });
});
