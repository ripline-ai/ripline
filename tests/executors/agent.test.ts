import { describe, expect, it } from "vitest";
import type { AgentNode } from "../../src/types.js";
import { executeAgent } from "../../src/pipeline/executors/agent.js";
import type { AgentRunner, AgentRunParams, AgentEvent } from "../../src/pipeline/executors/agent.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";

// ---------------------------------------------------------------------------
// Helpers for constructing mock AgentRunner objects
// ---------------------------------------------------------------------------

function makeRunner(text: string, tokenUsage?: { inputTokens?: number; outputTokens?: number }): AgentRunner {
  return {
    async *run() {
      yield { type: "message_done" as const, text, ...(tokenUsage && { usage: tokenUsage }) } satisfies AgentEvent;
    },
  };
}

function makeCapturingRunner(
  captured: { params: AgentRunParams | null },
  text = "ok"
): AgentRunner {
  return {
    async *run(params: AgentRunParams) {
      captured.params = params;
      yield { type: "message_done" as const, text } satisfies AgentEvent;
    },
  };
}

describe("Agent executor", () => {
  it("interpolates prompt from inputs and artifacts and stores response under node id", async () => {
    const mockRunner = makeRunner("Response for vector: Break Auth into features.", { inputTokens: 10, outputTokens: 5 });

    const node: AgentNode = {
      id: "break-down",
      type: "agent",
      agentId: "vector",
      prompt: "Break {{topic}} into features.",
    };
    const context: ExecutorContext = {
      inputs: { topic: "Auth" },
      artifacts: {},
      env: {},
      outputs: {},
    };

    const result = await executeAgent(node, context, { agentRunner: mockRunner });

    expect(result.artifactKey).toBe("break-down");
    expect((result.value as { text: string }).text).toContain("Response for vector");
    expect((result.value as { text: string }).text).toContain("Break Auth into features");
    expect((result.value as { tokenUsage?: { input?: number } }).tokenUsage?.input).toBe(10);
    expect(context.artifacts["break-down"]).toEqual(result.value);
  });

  it("passes thinking and timeoutSeconds to runner", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "nova",
      prompt: "Hello",
      thinking: "high",
      timeoutSeconds: 60,
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params?.agentId).toBe("nova");
    expect(captured.params?.thinking).toBe("high");
    expect(captured.params?.timeoutSeconds).toBe(60);
  });

  it("passes resetSession true and no sessionId when node omits resetSession", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Hi",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params?.resetSession).toBe(true);
    expect(captured.params?.sessionId).toBeUndefined();
  });

  it("passes resetSession false and context sessionId when node has resetSession false", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Continue.",
      resetSession: false,
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
      sessionId: "run-session-abc-123",
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params?.resetSession).toBe(false);
    expect(captured.params?.sessionId).toBe("run-session-abc-123");
  });

  it("does not pass sessionId when resetSession false but context has no sessionId", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Hi",
      resetSession: false,
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params?.resetSession).toBe(false);
    expect(captured.params?.sessionId).toBeUndefined();
  });

  it("passes model to runner when node has model", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Use opus.",
      runner: "claude-code",
      model: "claude-opus-4-6",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params?.model).toBe("claude-opus-4-6");
  });

  it("does not pass model when node model is empty string", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Hi",
      model: "",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params).not.toHaveProperty("model");
  });

  it("routes to claudeCodeRunner when agent definition has runner: claude-code", async () => {
    let usedRunner: string | null = null;
    const agentRunner: AgentRunner = {
      async *run() { usedRunner = "agentRunner"; yield { type: "message_done" as const, text: "from agent" }; },
    };
    const claudeCodeRunner: AgentRunner = {
      async *run() { usedRunner = "claudeCodeRunner"; yield { type: "message_done" as const, text: "from claude" }; },
    };
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "writer",
      prompt: "Write something.",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    const result = await executeAgent(
      node,
      context,
      { agentRunner, claudeCodeRunner },
      { writer: { runner: "claude-code" } }
    );

    expect(usedRunner).toBe("claudeCodeRunner");
    expect((result.value as { text: string }).text).toBe("from claude");
  });

  it("routes to codexRunner when agent definition has runner: codex", async () => {
    let usedRunner: string | null = null;
    const agentRunner: AgentRunner = async () => { usedRunner = "agentRunner"; return { text: "from agent" }; };
    const codexRunner: AgentRunner = async () => { usedRunner = "codexRunner"; return { text: "from codex" }; };
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "writer",
      prompt: "Write something.",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    const result = await executeAgent(
      node,
      context,
      { agentRunner, codexRunner },
      { writer: { runner: "codex" } }
    );

    expect(usedRunner).toBe("codexRunner");
    expect((result.value as { text: string }).text).toBe("from codex");
  });

  it("prepends systemPrompt from agent definition to node prompt", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "writer",
      prompt: "Write a post.",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    await executeAgent(
      node,
      context,
      { claudeCodeRunner: capturingRunner },
      { writer: { runner: "claude-code", systemPrompt: "You are a technical writer." } }
    );

    expect(captured.params?.prompt).toBe("You are a technical writer.\n\nWrite a post.");
  });

  it("node-level model overrides agent definition model", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "writer",
      prompt: "Write.",
      model: "claude-opus-4-6",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    await executeAgent(
      node,
      context,
      { claudeCodeRunner: capturingRunner },
      { writer: { runner: "claude-code", model: "claude-haiku-4-5-20251001" } }
    );

    expect(captured.params?.model).toBe("claude-opus-4-6");
  });

  it("uses agent definition model when node does not specify one", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "writer",
      prompt: "Write.",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    await executeAgent(
      node,
      context,
      { claudeCodeRunner: capturingRunner },
      { writer: { runner: "claude-code", model: "claude-sonnet-4-6", mode: "plan" } }
    );

    expect(captured.params?.model).toBe("claude-sonnet-4-6");
    expect(captured.params?.mode).toBe("plan");
  });

  it("falls through to agentRunner when agent definition has no claude-code runner", async () => {
    let usedRunner: string | null = null;
    const agentRunner: AgentRunner = {
      async *run() { usedRunner = "agentRunner"; yield { type: "message_done" as const, text: "from agent" }; },
    };
    const claudeCodeRunner: AgentRunner = {
      async *run() { usedRunner = "claudeCodeRunner"; yield { type: "message_done" as const, text: "from claude" }; },
    };
    const node: AgentNode = {
      id: "n",
      type: "agent",
      agentId: "nova",
      prompt: "Do something.",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    await executeAgent(
      node,
      context,
      { agentRunner, claudeCodeRunner },
      { nova: { runner: "openclaw" } }
    );

    expect(usedRunner).toBe("agentRunner");
  });

  it("passes runner: codex through to the codex runner", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => { capturedParams = params; return { text: "ok" }; };
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Do something",
      runner: "codex",
      mode: "plan",
      model: "gpt-5.4",
    };
    const context: ExecutorContext = { inputs: {}, artifacts: {}, env: {}, outputs: {} };

    await executeAgent(node, context, { codexRunner: capturingRunner });

    expect(capturedParams?.runner).toBe("codex");
    expect(capturedParams?.mode).toBe("plan");
    expect(capturedParams?.model).toBe("gpt-5.4");
  });

  it("prefers claude-code when RIPLINE_DEFAULT_AGENT_RUNNER=claude-code", async () => {
    let usedRunner: string | null = null;
    const claudeCodeRunner: AgentRunner = async () => {
      usedRunner = "claude";
      return { text: "from claude" };
    };
    const codexRunner: AgentRunner = async () => {
      usedRunner = "codex";
      return { text: "from codex" };
    };
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Do something",
      runner: "codex",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: { RIPLINE_DEFAULT_AGENT_RUNNER: "claude-code" },
      outputs: {},
    };

    await executeAgent(node, context, { claudeCodeRunner, codexRunner });

    expect(usedRunner).toBe("claude");
  });

  it("prefers codex when RIPLINE_DEFAULT_AGENT_RUNNER=codex", async () => {
    let usedRunner: string | null = null;
    const claudeCodeRunner: AgentRunner = async () => {
      usedRunner = "claude";
      return { text: "from claude" };
    };
    const codexRunner: AgentRunner = async () => {
      usedRunner = "codex";
      return { text: "from codex" };
    };
    const node: AgentNode = {
      id: "n",
      type: "agent",
      prompt: "Do something",
      runner: "claude-code",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: { RIPLINE_DEFAULT_AGENT_RUNNER: "codex" },
      outputs: {},
    };

    await executeAgent(node, context, { claudeCodeRunner, codexRunner });

    expect(usedRunner).toBe("codex");
  });

  it("appends output schema instruction to prompt when contracts.output is set", async () => {
    const captured: { params: AgentRunParams | null } = { params: null };
    const capturingRunner = makeCapturingRunner(captured);
    const outputSchema = { type: "object" as const, required: ["features"], properties: { features: { type: "array" } } };
    const node: AgentNode = {
      id: "writer",
      type: "agent",
      prompt: "Write features.",
      contracts: { output: outputSchema },
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await executeAgent(node, context, { agentRunner: capturingRunner });

    expect(captured.params?.prompt).toContain("Write features.");
    expect(captured.params?.prompt).toContain("JSON object only");
    expect(captured.params?.prompt).toContain("no markdown");
    expect(captured.params?.prompt).toContain("required");
    expect(captured.params?.prompt).toContain("features");
    expect(captured.params?.prompt).toContain("type");
    expect(captured.params?.prompt).toContain("object");
  });
});

describe("Skills and MCP server resolution", () => {
  const capturingRunner = async (params: Parameters<import("../../src/pipeline/executors/agent.js").AgentRunner>[0]) =>
    ({ text: "ok", _params: params } as import("../../src/pipeline/executors/agent.js").AgentResult & { _params: typeof params });

  const baseContext: import("../../src/pipeline/executors/types.js").ExecutorContext = {
    inputs: {},
    artifacts: {},
    env: {},
    outputs: {},
  };

  it("resolves skills shorthand from registry to mcpServers", async () => {
    let captured: Parameters<import("../../src/pipeline/executors/agent.js").AgentRunner>[0] | null = null;
    const runner: import("../../src/pipeline/executors/agent.js").AgentRunner = async (p) => { captured = p; return { text: "ok" }; };
    const node: import("../../src/types.js").AgentNode = { id: "n", type: "agent", agentId: "browser", prompt: "Go" };
    const agentDefs: Record<string, import("../../src/types.js").AgentDefinition> = {
      browser: { runner: "claude-code", skills: ["playwright"] },
    };
    const registry: import("../../src/types.js").SkillsRegistry = {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"], description: "Browser automation" },
    };
    await executeAgent(node, { ...baseContext, artifacts: {} }, { claudeCodeRunner: runner }, agentDefs, registry);
    expect(captured?.mcpServers?.playwright).toMatchObject({ command: "npx", args: ["@playwright/mcp@latest"] });
    expect((captured?.mcpServers?.playwright as Record<string, unknown>)?.description).toBeUndefined();
  });

  it("explicit mcpServers in agent definition override registry-resolved skills", async () => {
    let captured: Parameters<import("../../src/pipeline/executors/agent.js").AgentRunner>[0] | null = null;
    const runner: import("../../src/pipeline/executors/agent.js").AgentRunner = async (p) => { captured = p; return { text: "ok" }; };
    const node: import("../../src/types.js").AgentNode = { id: "n", type: "agent", agentId: "browser", prompt: "Go" };
    const agentDefs: Record<string, import("../../src/types.js").AgentDefinition> = {
      browser: {
        runner: "claude-code",
        skills: ["playwright"],
        mcpServers: { playwright: { command: "node", args: ["custom.js"] } },
      },
    };
    const registry: import("../../src/types.js").SkillsRegistry = {
      playwright: { command: "npx", args: ["@playwright/mcp@latest"] },
    };
    await executeAgent(node, { ...baseContext, artifacts: {} }, { claudeCodeRunner: runner }, agentDefs, registry);
    expect(captured?.mcpServers?.playwright).toMatchObject({ command: "node", args: ["custom.js"] });
  });

  it("no mcpServers passed when agent has no skills config", async () => {
    let captured: Parameters<import("../../src/pipeline/executors/agent.js").AgentRunner>[0] | null = null;
    const runner: import("../../src/pipeline/executors/agent.js").AgentRunner = async (p) => { captured = p; return { text: "ok" }; };
    const node: import("../../src/types.js").AgentNode = { id: "n", type: "agent", agentId: "vector", prompt: "Go" };
    const agentDefs: Record<string, import("../../src/types.js").AgentDefinition> = {
      vector: { runner: "claude-code", model: "claude-sonnet-4-6" },
    };
    await executeAgent(node, { ...baseContext, artifacts: {} }, { claudeCodeRunner: runner }, agentDefs);
    expect(captured?.mcpServers).toBeUndefined();
  });
});
