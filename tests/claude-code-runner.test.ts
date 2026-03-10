import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createClaudeCodeRunner } from "../src/claude-code-runner.js";

let capturedQueryArgs: { prompt: string; options?: Record<string, unknown> } | null = null;
let mockYieldMessage: unknown = { type: "result", subtype: "success", result: "done" };

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options?: Record<string, unknown> }) => {
    capturedQueryArgs = args;
    return (async function* () {
      yield mockYieldMessage;
    })();
  },
}));

describe("Claude Code runner – model", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
    mockYieldMessage = { type: "result", subtype: "success", result: "done" };
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("passes params.model to SDK options when node sets model", async () => {
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await runner({
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
    await runner({
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
    await runner({
      agentId: "default",
      prompt: "Hi",
      cwd,
      model: "claude-opus-4-6",
    });

    expect(capturedQueryArgs?.options?.model).toBe("claude-opus-4-6");
  });

  it("does not set model in options when neither params nor config provide model", async () => {
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await runner({
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
    mockYieldMessage = { type: "result", subtype: "success", result: "done" };
    cwd = path.join(os.tmpdir(), "ripline-claude-code-test-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
  });

  it("includes subtype, errors, and result snippet in thrown message when subtype is not success", async () => {
    mockYieldMessage = {
      type: "result",
      subtype: "error_max_turns",
      errors: [],
    };
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      runner({ agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/Claude Code runner:.*subtype=error_max_turns.*errors=\[\]/);
  });

  it("includes result in thrown message when result is present on non-success", async () => {
    mockYieldMessage = {
      type: "result",
      subtype: "error_timeout",
      errors: ["timed out"],
      result: "partial output here",
    };
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      runner({ agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/result=partial output here/);
  });

  it("logs FAILED to stderr before throwing on non-success", async () => {
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockYieldMessage = {
      type: "result",
      subtype: "error_max_turns",
      errors: ["max turns reached"],
    };
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await expect(
      runner({ agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/Claude Code runner:/);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[claude-code-runner\] FAILED:.*subtype=error_max_turns/)
    );
    stderrSpy.mockRestore();
  });
});

describe("Claude Code runner – config logging", () => {
  let cwd: string;
  const originalLogConfig = process.env.RIPLINE_LOG_CONFIG;

  beforeEach(() => {
    capturedQueryArgs = null;
    mockYieldMessage = { type: "result", subtype: "success", result: "done" };
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
    await runner({ agentId: "default", prompt: "Hi", cwd });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[claude-code-runner\] maxTurns=\d+ timeoutMs=\d+ mode=execute cwd=/)
    );
    stderrSpy.mockRestore();
  });

  it("does not log config when RIPLINE_LOG_CONFIG is not set", async () => {
    delete process.env.RIPLINE_LOG_CONFIG;
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const runner = createClaudeCodeRunner({ mode: "execute" });
    await runner({ agentId: "default", prompt: "Hi", cwd });
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
    mockYieldMessage = { type: "result", subtype: "success", result: "done" };
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
    await runner({ agentId: "default", prompt: "Hi", cwd });
    expect(process.env.CLAUDECODE).toBe("nested");
  });
});
