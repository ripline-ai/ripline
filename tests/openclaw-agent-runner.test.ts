import { describe, expect, it } from "vitest";
import {
  createOpenClawAgentRunner,
  type OpenClawPluginApi,
} from "../src/integrations/openclaw/openclaw-runner.js";
import { collectAgentResult } from "../src/pipeline/executors/agent.js";

/** Helper: collect result from a runner invocation. */
async function runAndCollect(
  runner: ReturnType<typeof createOpenClawAgentRunner>,
  params: Parameters<(typeof runner)["run"]>[0]
) {
  return collectAgentResult(runner.run(params));
}

describe("createOpenClawAgentRunner", () => {
  it("builds openclaw agent --json with agentId and prompt, parses JSON to AgentResult", async () => {
    let capturedCmd: string[] = [];
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async (cmd) => {
            capturedCmd = cmd;
            return {
              code: 0,
              stdout: JSON.stringify({
                text: "Hello from agent",
                tokenUsage: { input: 10, output: 5 },
              }),
              stderr: "",
            };
          },
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    const result = await runAndCollect(runner, {
      agentId: "vector",
      prompt: "Summarize this.",
    });

    expect(capturedCmd).toContain("openclaw");
    expect(capturedCmd).toContain("agent");
    expect(capturedCmd).toContain("--json");
    expect(capturedCmd).toContain("--agent");
    expect(capturedCmd).toContain("vector");
    expect(capturedCmd).toContain("--session-id");
    const sessionIdx = capturedCmd.indexOf("--session-id");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    const sessionValue = capturedCmd[sessionIdx + 1];
    expect(sessionValue).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(capturedCmd).toContain("--message");
    expect(capturedCmd).toContain("Summarize this.");
    expect(result.text).toBe("Hello from agent");
    expect(result.usage?.inputTokens).toBe(10);
    expect(result.usage?.outputTokens).toBe(5);
  });

  it("passes thinking and timeoutSeconds to command", async () => {
    let capturedCmd: string[] = [];
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async (cmd) => {
            capturedCmd = cmd;
            return {
              code: 0,
              stdout: JSON.stringify({ text: "ok" }),
              stderr: "",
            };
          },
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    await runAndCollect(runner, {
      agentId: "nova",
      prompt: "Hi",
      thinking: "high",
      timeoutSeconds: 60,
    });

    const cmdStr = capturedCmd.join(" ");
    expect(cmdStr).toMatch(/--agent\s+nova|nova.*--agent/);
    expect(cmdStr).toMatch(/--thinking\s+high|high.*--thinking/);
    expect(cmdStr).toMatch(/--timeout\s+60|60.*--timeout/);
  });

  it("throws with clear message when exit code is non-zero", async () => {
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async () => ({
            code: 1,
            stdout: "",
            stderr: "Agent session failed: timeout",
          }),
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    await expect(
      runAndCollect(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/agent.*failed|timeout|stderr/i);
  });

  it("throws when stdout is not valid agent JSON", async () => {
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async () => ({
            code: 0,
            stdout: "not json",
            stderr: "",
          }),
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    await expect(
      runAndCollect(runner, { agentId: "default", prompt: "Hi" })
    ).rejects.toThrow(/JSON|parse|envelope/i);
  });

  it("passes --session with new UUID when resetSession is true or omitted", async () => {
    let capturedCmd: string[] = [];
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async (cmd) => {
            capturedCmd = cmd;
            return {
              code: 0,
              stdout: JSON.stringify({ text: "ok" }),
              stderr: "",
            };
          },
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    await runAndCollect(runner, { agentId: "default", prompt: "Hi" });

    expect(capturedCmd).toContain("--session-id");
    const sessionIdx = capturedCmd.indexOf("--session-id");
    const sessionValue = capturedCmd[sessionIdx + 1];
    expect(sessionValue).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("passes --session with provided sessionId when resetSession is false", async () => {
    let capturedCmd: string[] = [];
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async (cmd) => {
            capturedCmd = cmd;
            return {
              code: 0,
              stdout: JSON.stringify({ text: "ok" }),
              stderr: "",
            };
          },
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    await runAndCollect(runner, {
      agentId: "nova",
      prompt: "Continue",
      resetSession: false,
      sessionId: "shared-run-session-xyz",
    });

    expect(capturedCmd).toContain("--session-id");
    const sessionIdx = capturedCmd.indexOf("--session-id");
    expect(capturedCmd[sessionIdx + 1]).toBe("shared-run-session-xyz");
  });

  it("passes --session with new UUID when resetSession is false but sessionId is missing", async () => {
    let capturedCmd: string[] = [];
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async (cmd) => {
            capturedCmd = cmd;
            return {
              code: 0,
              stdout: JSON.stringify({ text: "ok" }),
              stderr: "",
            };
          },
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    await runAndCollect(runner, {
      agentId: "default",
      prompt: "Hi",
      resetSession: false,
    });

    expect(capturedCmd).toContain("--session-id");
    const sessionIdx = capturedCmd.indexOf("--session-id");
    const sessionValue = capturedCmd[sessionIdx + 1];
    expect(sessionValue).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it("returns text and no usage when envelope has only text", async () => {
    const api: OpenClawPluginApi = {
      runtime: {
        system: {
          runCommandWithTimeout: async () => ({
            code: 0,
            stdout: JSON.stringify({ text: "Only text" }),
            stderr: "",
          }),
        },
      },
    };

    const runner = createOpenClawAgentRunner(api);
    const result = await runAndCollect(runner, { agentId: "default", prompt: "Hi" });
    expect(result.text).toBe("Only text");
    expect(result.usage).toBeUndefined();
  });
});
