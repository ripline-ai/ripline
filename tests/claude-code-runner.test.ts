import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { createClaudeCodeRunner } from "../src/claude-code-runner.js";

function createMockQuery(impl: (opts: { prompt: string; options?: Record<string, unknown> }) => AsyncGenerator<unknown>) {
  return (opts: { prompt: string; options?: Record<string, unknown> }) => {
    const gen = impl(opts);
    return Object.assign(gen, { close: () => {} });
  };
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

describe("createClaudeCodeRunner", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = path.join(process.cwd(), "dist", "test-claude-code-" + Date.now());
    await fs.promises.mkdir(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.promises.rm(tmpDir, { recursive: true });
    } catch {
      // ignore
    }
    vi.clearAllMocks();
  });

  describe("plan mode", () => {
    it("resolves with text output", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "Plan mode reply",
            usage: { input_tokens: 10, output_tokens: 5 },
          };
        })
      );

      const runner = createClaudeCodeRunner({ mode: "plan", cwd: tmpDir });
      const result = await runner({
        agentId: "default",
        prompt: "Analyze this",
      });

      expect(result.text).toBe("Plan mode reply");
      expect(result.tokenUsage).toEqual({ input: 10, output: 5 });
      expect(vi.mocked(query).mock.calls[0][0].options?.permissionMode).toBe("plan");
    });

    it("PreToolUse hook denies Write tool call", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      let capturedHooks: Record<string, unknown> = {};
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* (opts) {
          capturedHooks = (opts.options?.hooks as Record<string, unknown>) ?? {};
          yield {
            type: "result",
            subtype: "success",
            result: "ok",
            usage: {},
          };
        })
      );

      const runner = createClaudeCodeRunner({ mode: "plan", cwd: tmpDir });
      await runner({ agentId: "default", prompt: "Hi" });

      const preToolUse = capturedHooks.PreToolUse as Array<(input: unknown) => unknown>;
      expect(Array.isArray(preToolUse)).toBe(true);
      const decision = preToolUse[0]!({ tool_name: "Write", tool_input: {} });
      expect(decision).toMatchObject({
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
      });
    });

    it("PreToolUse hook denies Edit tool call", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      let capturedHooks: Record<string, unknown> = {};
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* (opts) {
          capturedHooks = (opts.options?.hooks as Record<string, unknown>) ?? {};
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );

      const runner = createClaudeCodeRunner({ mode: "plan", cwd: tmpDir });
      await runner({ agentId: "default", prompt: "Hi" });

      const preToolUse = capturedHooks.PreToolUse as Array<(input: unknown) => unknown>;
      const decision = preToolUse[0]!({ tool_name: "Edit", tool_input: {} });
      expect(decision).toMatchObject({ permissionDecision: "deny" });
    });
  });

  describe("execute mode", () => {
    it("resolves with text output", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield {
            type: "result",
            subtype: "success",
            result: "Execute reply",
            usage: { input_tokens: 20, output_tokens: 8 },
          };
        })
      );

      const runner = createClaudeCodeRunner({ mode: "execute", cwd: tmpDir });
      const result = await runner({
        agentId: "default",
        prompt: "Implement this",
      });

      expect(result.text).toBe("Execute reply");
      expect(result.tokenUsage).toEqual({ input: 20, output: 8 });
      expect(vi.mocked(query).mock.calls[0][0].options?.permissionMode).toBe("dontAsk");
      expect(vi.mocked(query).mock.calls[0][0].options?.allowedTools).toBeDefined();
      expect(Array.isArray(vi.mocked(query).mock.calls[0][0].options?.allowedTools)).toBe(true);
    });

    it("does not add PreToolUse deny hook", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* (opts) {
          expect(opts.options?.hooks?.PreToolUse).toBeUndefined();
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );

      const runner = createClaudeCodeRunner({ mode: "execute", cwd: tmpDir });
      await runner({ agentId: "default", prompt: "Hi" });
    });
  });

  it("passes cwd to the SDK", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation(
      createMockQuery(async function* (opts) {
        expect(opts.options?.cwd).toBe(tmpDir);
        yield { type: "result", subtype: "success", result: "ok", usage: {} };
      })
    );

    const runner = createClaudeCodeRunner({ mode: "execute", cwd: tmpDir });
    await runner({ agentId: "default", prompt: "Hi", cwd: tmpDir });
  });

  it("invalid cwd (non-existent path) throws before invoking SDK", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation(createMockQuery(async function* () {
      yield { type: "result", subtype: "success", result: "ok", usage: {} };
    }));

    const runner = createClaudeCodeRunner({ mode: "execute", cwd: tmpDir });
    await expect(
      runner({ agentId: "default", prompt: "Hi", cwd: "/nonexistent/path/12345" })
    ).rejects.toThrow(/cwd does not exist|ENOENT/);
    expect(vi.mocked(query)).not.toHaveBeenCalled();
  });

  it("cwd containing .. throws", async () => {
    const runner = createClaudeCodeRunner({ mode: "execute", cwd: tmpDir });
    await expect(
      runner({ agentId: "default", prompt: "Hi", cwd: tmpDir + "/../other" })
    ).rejects.toThrow(/must not contain/);
  });

  it("outputFormat json parses valid JSON response", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation(
      createMockQuery(async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: '{"key":"value"}',
          usage: {},
        };
      })
    );

    const runner = createClaudeCodeRunner({
      mode: "execute",
      cwd: tmpDir,
      outputFormat: "json",
    });
    const result = await runner({ agentId: "default", prompt: "Return JSON" });
    expect(result.text).toBe('{"key":"value"}');
  });

  it("outputFormat json surfaces parse error on invalid JSON response", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation(
      createMockQuery(async function* () {
        yield {
          type: "result",
          subtype: "success",
          result: "not valid json {{{",
          usage: {},
        };
      })
    );

    const runner = createClaudeCodeRunner({
      mode: "execute",
      cwd: tmpDir,
      outputFormat: "json",
    });
    await expect(
      runner({ agentId: "default", prompt: "Return JSON" })
    ).rejects.toThrow(/not valid JSON|outputFormat/);
  });

  it("maxTurns ceiling is enforced", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation(
      createMockQuery(async function* (opts) {
        const maxTurns = opts.options?.maxTurns as number | undefined;
        expect(maxTurns).toBeLessThanOrEqual(20);
        yield { type: "result", subtype: "success", result: "ok", usage: {} };
      })
    );

    const runner = createClaudeCodeRunner({
      mode: "execute",
      cwd: tmpDir,
      maxTurns: 100,
    });
    await runner({ agentId: "default", prompt: "Hi" });
    expect(vi.mocked(query).mock.calls[0][0].options?.maxTurns).toBe(20);
  });

  it("timeout triggers AbortController and rejects with timeout error", async () => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    vi.mocked(query).mockImplementation(
      createMockQuery(async function* (opts) {
        const controller = opts.options?.abortController as AbortController | undefined;
        const signal = controller?.signal;
        if (signal) {
          await new Promise<void>((_, reject) => {
            if (signal.aborted) {
              reject(new DOMException("aborted", "AbortError"));
              return;
            }
            signal.addEventListener("abort", () => {
              reject(new DOMException("aborted", "AbortError"));
            });
          });
        }
        yield { type: "result", subtype: "success", result: "ok", usage: {} };
      })
    );

    const runner = createClaudeCodeRunner({
      mode: "execute",
      cwd: tmpDir,
      timeoutSeconds: 300,
    });
    await expect(
      runner({ agentId: "default", prompt: "Hi", timeoutSeconds: 1 })
    ).rejects.toThrow(/timed out/);
  });

  describe("bypass mode", () => {
    it("12. bypass activates when global allow, node dangerouslySkipPermissions, mode execute, and valid explicit cwd are set", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
      });
      await runner({ agentId: "default", prompt: "Hi", dangerouslySkipPermissions: true });
      const opts = vi.mocked(query).mock.calls[0][0].options;
      expect(opts?.permissionMode).toBe("bypassPermissions");
      expect(opts?.allowedTools).toBeUndefined();
    });

    it("13. bypass does not activate when mode is plan even if allowDangerouslySkipPermissions is true", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "plan",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
      });
      await runner({ agentId: "default", prompt: "Hi" });
      expect(vi.mocked(query).mock.calls[0][0].options?.permissionMode).toBe("plan");
    });

    it("14. bypass does not activate when cwd is not explicitly set even if global allow and node request bypass", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        allowDangerouslySkipPermissions: true,
      });
      await runner({ agentId: "default", prompt: "Hi", dangerouslySkipPermissions: true });
      expect(vi.mocked(query).mock.calls[0][0].options?.permissionMode).toBe("dontAsk");
    });

    it("14b. bypass does not activate when global allow but node does not set dangerouslySkipPermissions", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
      });
      await runner({ agentId: "default", prompt: "Hi" });
      expect(vi.mocked(query).mock.calls[0][0].options?.permissionMode).toBe("dontAsk");
    });

    it("15. warning log is emitted before SDK invocation when bypass is active", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
      });
      await runner({ agentId: "default", prompt: "Hi", dangerouslySkipPermissions: true });
      const bypassWarning = stderrSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("dangerously-skip-permissions enabled")
      );
      expect(bypassWarning).toBeDefined();
      stderrSpy.mockRestore();
    });

    it("16. warning log is not emitted in normal execute mode", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({ mode: "execute", cwd: tmpDir });
      await runner({ agentId: "default", prompt: "Hi" });
      const bypassWarning = stderrSpy.mock.calls.find(
        (call) => typeof call[0] === "string" && call[0].includes("dangerously-skip-permissions enabled")
      );
      expect(bypassWarning).toBeUndefined();
      stderrSpy.mockRestore();
    });

    it("17. disallowedTools is passed through in bypass mode", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
        disallowedTools: ["CustomTool"],
      });
      await runner({ agentId: "default", prompt: "Hi", dangerouslySkipPermissions: true });
      expect(vi.mocked(query).mock.calls[0][0].options?.disallowedTools).toEqual(["CustomTool"]);
    });

    it("18. allowedTools is not passed to SDK in bypass mode", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* () {
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
        allowedTools: ["Read", "Write"],
      });
      await runner({ agentId: "default", prompt: "Hi", dangerouslySkipPermissions: true });
      expect(vi.mocked(query).mock.calls[0][0].options?.allowedTools).toBeUndefined();
    });

    it("19. PreToolUse hook is not added in execute/bypass mode (hook still runs when SDK adds it)", async () => {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");
      vi.mocked(query).mockImplementation(
        createMockQuery(async function* (opts) {
          expect(opts.options?.hooks?.PreToolUse).toBeUndefined();
          yield { type: "result", subtype: "success", result: "ok", usage: {} };
        })
      );
      const runner = createClaudeCodeRunner({
        mode: "execute",
        cwd: tmpDir,
        allowDangerouslySkipPermissions: true,
      });
      await runner({ agentId: "default", prompt: "Hi", dangerouslySkipPermissions: true });
    });
  });
});
