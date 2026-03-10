import { describe, expect, it, vi, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createClaudeCodeRunner } from "../src/claude-code-runner.js";

let capturedQueryArgs: { prompt: string; options?: Record<string, unknown> } | null = null;

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: (args: { prompt: string; options?: Record<string, unknown> }) => {
    capturedQueryArgs = args;
    return (async function* () {
      yield { type: "result", subtype: "success", result: "done" };
    })();
  },
}));

describe("Claude Code runner – model", () => {
  let cwd: string;

  beforeEach(() => {
    capturedQueryArgs = null;
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
