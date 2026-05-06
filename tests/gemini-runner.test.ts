import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import type { AgentEvent } from "../src/pipeline/executors/agent.js";

// ---------------------------------------------------------------------------
// child_process mock infrastructure
// ---------------------------------------------------------------------------

type SpawnCall = {
  command: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string>; stdio?: unknown };
};

let spawnCalls: SpawnCall[] = [];
let mockProcessFactory: (() => MockChildProcess) | null = null;

/** Minimal mock of a child_process ChildProcess */
class MockChildProcess extends EventEmitter {
  stdin: Writable;
  stdout: EventEmitter;
  stderr: EventEmitter;

  _stdinChunks: string[] = [];
  _stdinEnded = false;

  constructor() {
    super();
    const self = this;

    // Writable stdin that captures written data
    this.stdin = new Writable({
      write(chunk: Buffer | string, _enc: string, cb: () => void) {
        self._stdinChunks.push(
          typeof chunk === "string" ? chunk : chunk.toString("utf8")
        );
        cb();
      },
    });
    this.stdin.on("finish", () => {
      self._stdinEnded = true;
    });

    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }

  kill(_signal?: string): void {
    this.emit("close", null);
  }

  // ---- helpers to simulate Gemini output ----

  sendLine(line: string): void {
    this.stdout.emit("data", Buffer.from(line + "\n", "utf8"));
  }

  sendStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }

  close(code: number | null = 0): void {
    this.emit("close", code);
  }

  get stdinPayload(): string {
    return this._stdinChunks.join("");
  }
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: unknown) => {
    spawnCalls.push({ command, args, options: options as SpawnCall["options"] });
    const proc = mockProcessFactory ? mockProcessFactory() : new MockChildProcess();
    return proc;
  },
}));

import { createGeminiRunner } from "../src/gemini-runner.js";
import { collectAgentResult } from "../src/pipeline/executors/agent.js";

/** Run and collect result from a gemini runner invocation. */
async function run(
  runner: ReturnType<typeof createGeminiRunner>,
  params: Parameters<(typeof runner)["run"]>[0],
  signal?: AbortSignal
) {
  return collectAgentResult(runner.run(params, signal));
}

/** Collect all events from the async generator. */
async function collectEvents(
  runner: ReturnType<typeof createGeminiRunner>,
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
// Helpers
// ---------------------------------------------------------------------------

function makeSuccessProcess(lines: string[], exitCode = 0): MockChildProcess {
  const proc = new MockChildProcess();
  // Emit lines asynchronously so the test's Promise has time to register
  setImmediate(() => {
    for (const line of lines) proc.sendLine(line);
    proc.close(exitCode);
  });
  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  spawnCalls = [];
  mockProcessFactory = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -- Successful run ----------------------------------------------------------

describe("createGeminiRunner – successful run", () => {
  it("returns accumulated text from stream-json delta lines", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"init","session_id":"abc","model":"gemini-2.5-pro"}',
        '{"type":"message","role":"assistant","content":"Hello ","delta":true}',
        '{"type":"message","role":"assistant","content":"world!","delta":true}',
        '{"type":"result","status":"success","stats":{}}',
      ]);

    const runner = createGeminiRunner();
    const result = await run(runner, { agentId: "default", prompt: "Say hello" });
    expect(result.text).toBe("Hello world!");
  });

  it("sends the full prompt via stdin", async () => {
    let capturedProc: MockChildProcess | undefined;
    mockProcessFactory = () => {
      const proc = makeSuccessProcess([
        '{"type":"result","status":"success","stats":{}}',
      ]);
      capturedProc = proc;
      return proc;
    };

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "my prompt text" });
    expect(capturedProc?.stdinPayload).toBe("my prompt text");
  });

  it("resolves with empty text when no delta lines but result is success", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"result","status":"success","stats":{}}',
      ]);

    const runner = createGeminiRunner();
    const result = await run(runner, { agentId: "default", prompt: "Hi" });
    expect(result.text).toBe("");
  });
});

// -- Streaming event order ----------------------------------------------------

describe("createGeminiRunner – streaming event order", () => {
  it("yields text_delta events before message_done", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"message","role":"assistant","content":"Hello ","delta":true}',
        '{"type":"message","role":"assistant","content":"world!","delta":true}',
        '{"type":"result","status":"success","stats":{}}',
      ]);

    const runner = createGeminiRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    const textDeltas = events.filter((e) => e.type === "text_delta");
    const messageDone = events.find((e) => e.type === "message_done");

    expect(textDeltas.length).toBe(2);
    expect(messageDone).toBeDefined();

    // All text_delta events must come before message_done
    const messageDoneIdx = events.indexOf(messageDone!);
    for (const delta of textDeltas) {
      expect(events.indexOf(delta)).toBeLessThan(messageDoneIdx);
    }
  });

  it("text_delta events accumulate to the same text as message_done", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"message","role":"assistant","content":"Hello ","delta":true}',
        '{"type":"message","role":"assistant","content":"world!","delta":true}',
        '{"type":"result","status":"success","stats":{}}',
      ]);

    const runner = createGeminiRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    const accumulated = events
      .filter((e): e is { type: "text_delta"; text: string } => e.type === "text_delta")
      .map((e) => e.text)
      .join("");

    const messageDone = events.find(
      (e): e is { type: "message_done"; text: string } => e.type === "message_done"
    );
    expect(messageDone).toBeDefined();
    expect(messageDone!.text).toBe(accumulated);
  });

  it("message_done is the final event on success", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"message","role":"assistant","content":"hi","delta":true}',
        '{"type":"result","status":"success","stats":{}}',
      ]);

    const runner = createGeminiRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    expect(events[events.length - 1]?.type).toBe("message_done");
  });

  it("error is the final event on failure", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"result","status":"error","error":"something went wrong"}',
      ]);

    const runner = createGeminiRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });

    expect(events[events.length - 1]?.type).toBe("error");
  });
});

// -- Spawn args & config ----------------------------------------------------

describe("createGeminiRunner – spawn configuration", () => {
  it("uses the default 'gemini' binary when binaryPath is not set", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });
    expect(spawnCalls[0]?.command).toBe("gemini");
  });

  it("uses a custom binaryPath when provided", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner({ binaryPath: "/usr/local/bin/gemini" });
    await run(runner, { agentId: "default", prompt: "Hi" });
    expect(spawnCalls[0]?.command).toBe("/usr/local/bin/gemini");
  });

  it("passes the model from params to -m flag", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi", model: "gemini-1.5-pro" });
    const args = spawnCalls[0]?.args ?? [];
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    expect(args[mIdx + 1]).toBe("gemini-1.5-pro");
  });

  it("uses the default model when params.model is not set", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });
    const args = spawnCalls[0]?.args ?? [];
    const mIdx = args.indexOf("-m");
    expect(mIdx).toBeGreaterThan(-1);
    // Should be the default model constant
    expect(args[mIdx + 1]).toBeDefined();
    expect((args[mIdx + 1] ?? "").length).toBeGreaterThan(0);
  });

  it("passes --output-format stream-json in args", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });
    const args = spawnCalls[0]?.args ?? [];
    expect(args).toContain("stream-json");
    expect(args).toContain("--output-format");
  });

  it("passes params.cwd to child process cwd", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi", cwd: "/custom/dir" });
    expect(spawnCalls[0]?.options.cwd).toBe("/custom/dir");
  });

  it("uses config.cwd when params.cwd is not set", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner({ cwd: "/config/dir" });
    await run(runner, { agentId: "default", prompt: "Hi" });
    expect(spawnCalls[0]?.options.cwd).toBe("/config/dir");
  });

  it("params.cwd takes precedence over config.cwd", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner({ cwd: "/config/dir" });
    await run(runner, { agentId: "default", prompt: "Hi", cwd: "/params/dir" });
    expect(spawnCalls[0]?.options.cwd).toBe("/params/dir");
  });

  it("sets GEMINI_CLI_TRUST_WORKSPACE=true in process env", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });
    const env = spawnCalls[0]?.options.env as Record<string, string> | undefined;
    expect(env?.GEMINI_CLI_TRUST_WORKSPACE).toBe("true");
  });
});

// -- Error handling ----------------------------------------------------------

describe("createGeminiRunner – error handling", () => {
  it("rejects when result status is not success", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"result","status":"error","error":"something went wrong"}',
      ]);

    const runner = createGeminiRunner();
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/something went wrong/);
  });

  it("rejects with quota message when result contains quota error", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"result","status":"error","error":"QUOTA_EXHAUSTED: rate limit exceeded"}',
      ]);

    const runner = createGeminiRunner();
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/quota exhausted/i);
  });

  it("yields error event with kind quota_exhausted for quota errors in result line", async () => {
    mockProcessFactory = () =>
      makeSuccessProcess([
        '{"type":"result","status":"error","error":"QUOTA_EXHAUSTED: rate limit exceeded"}',
      ]);

    const runner = createGeminiRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string }
      | undefined;

    expect(errorEvent?.kind).toBe("quota_exhausted");
  });

  it("rejects when process exits non-zero without done signal", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.sendStderr("fatal error occurred");
        proc.close(1);
      });
      return proc;
    };

    const runner = createGeminiRunner();
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/exited with code 1/);
  });

  it("rejects with auth error message when stderr mentions API key not found", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.sendStderr(
          "GEMINI_API_KEY environment variable not found. Add that to your environment and try again."
        );
        proc.close(1);
      });
      return proc;
    };

    const runner = createGeminiRunner();
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/not authenticated|GEMINI_API_KEY/i);
  });

  it("rejects with quota message when stderr contains 429 / quota text", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.sendStderr("Request failed: 429 quota exhausted, resets in 8h14m");
        proc.close(1);
      });
      return proc;
    };

    const runner = createGeminiRunner();
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/quota exhausted/i);
  });

  it("yields error event with kind quota_exhausted when stderr has quota text", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.sendStderr("Request failed: 429 quota exhausted");
        proc.close(1);
      });
      return proc;
    };

    const runner = createGeminiRunner();
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string }
      | undefined;

    expect(errorEvent?.kind).toBe("quota_exhausted");
  });

  it("rejects when spawn emits an error event", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.emit("error", new Error("ENOENT: binary not found"));
      });
      return proc;
    };

    const runner = createGeminiRunner({ binaryPath: "/missing/gemini" });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/failed to spawn.*ENOENT/i);
  });

  it("yields error event with kind spawn_failed on spawn error", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.emit("error", new Error("ENOENT: binary not found"));
      });
      return proc;
    };

    const runner = createGeminiRunner({ binaryPath: "/missing/gemini" });
    const events = await collectEvents(runner, { agentId: "default", prompt: "Hi" });
    const errorEvent = events.find((e) => e.type === "error") as
      | { type: "error"; kind: string }
      | undefined;

    expect(errorEvent?.kind).toBe("spawn_failed");
  });

  it("rejects with no-output error when process exits 0 but no output received", async () => {
    mockProcessFactory = () => {
      const proc = new MockChildProcess();
      setImmediate(() => {
        proc.close(0);
      });
      return proc;
    };

    const runner = createGeminiRunner();
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/no output received/);
  });
});

// -- AbortSignal -------------------------------------------------------------

describe("createGeminiRunner – abort signal", () => {
  it("yields error event with kind aborted when signal fires", async () => {
    mockProcessFactory = () => {
      // Process that never completes
      return new MockChildProcess();
    };

    const controller = new AbortController();
    const runner = createGeminiRunner({ timeoutMs: 60_000 });

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

  it("rejects immediately when AbortSignal is already aborted before run", async () => {
    const controller = new AbortController();
    controller.abort();

    // No process needed — should exit before spawning
    const runner = createGeminiRunner({ timeoutMs: 60_000 });
    await expect(
      run(runner, { agentId: "default", prompt: "Hi" }, controller.signal)
    ).rejects.toThrow(/aborted/);
  });
});

// -- Timeout -----------------------------------------------------------------

describe("createGeminiRunner – timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with timeout error when timeoutMs is exceeded", async () => {
    vi.useFakeTimers();

    mockProcessFactory = () => {
      // Process never closes — simulates a hung gemini
      return new MockChildProcess();
    };

    const runner = createGeminiRunner({ timeoutMs: 1000 });
    const promise = run(runner, { agentId: "default", prompt: "Hi" });

    vi.advanceTimersByTime(1100);
    await expect(promise).rejects.toThrow(/timed out after 1s/);
  });

  it("respects timeoutSeconds from params (overrides config timeoutMs)", async () => {
    vi.useFakeTimers();

    mockProcessFactory = () => {
      return new MockChildProcess();
    };

    const runner = createGeminiRunner({ timeoutMs: 60_000 });
    const promise = run(runner, { agentId: "default", prompt: "Hi", timeoutSeconds: 2 });

    vi.advanceTimersByTime(2100);
    await expect(promise).rejects.toThrow(/timed out after 2s/);
  });
});

// -- Logging -----------------------------------------------------------------

describe("createGeminiRunner – logging", () => {
  const originalLogConfig = process.env.RIPLINE_LOG_CONFIG;

  afterEach(() => {
    if (originalLogConfig !== undefined) process.env.RIPLINE_LOG_CONFIG = originalLogConfig;
    else delete process.env.RIPLINE_LOG_CONFIG;
  });

  it("logs config to stderr when RIPLINE_LOG_CONFIG=1", async () => {
    process.env.RIPLINE_LOG_CONFIG = "1";
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s: unknown) => { written.push(String(s)); return true; });

    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });

    expect(written.some((s) => s.includes("[gemini-runner]"))).toBe(true);

    stderrSpy.mockRestore();
  });

  it("does not log config when RIPLINE_LOG_CONFIG is unset", async () => {
    delete process.env.RIPLINE_LOG_CONFIG;
    const written: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((s: unknown) => { written.push(String(s)); return true; });

    mockProcessFactory = () =>
      makeSuccessProcess(['{"type":"result","status":"success","stats":{}}']);

    const runner = createGeminiRunner();
    await run(runner, { agentId: "default", prompt: "Hi" });

    expect(written.some((s) => s.includes("[gemini-runner]"))).toBe(false);

    stderrSpy.mockRestore();
  });
});
