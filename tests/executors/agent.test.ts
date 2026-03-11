import { describe, expect, it } from "vitest";
import type { AgentNode } from "../../src/types.js";
import { executeAgent } from "../../src/pipeline/executors/agent.js";
import type { AgentRunner } from "../../src/pipeline/executors/agent.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";

describe("Agent executor", () => {
  const mockRunner: AgentRunner = async (params) => ({
    text: `Response for ${params.agentId}: ${params.prompt}`,
    tokenUsage: { input: 10, output: 5 },
  });

  it("interpolates prompt from inputs and artifacts and stores response under node id", async () => {
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
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams?.agentId).toBe("nova");
    expect(capturedParams?.thinking).toBe("high");
    expect(capturedParams?.timeoutSeconds).toBe(60);
  });

  it("passes resetSession true and no sessionId when node omits resetSession", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams?.resetSession).toBe(true);
    expect(capturedParams?.sessionId).toBeUndefined();
  });

  it("passes resetSession false and context sessionId when node has resetSession false", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams?.resetSession).toBe(false);
    expect(capturedParams?.sessionId).toBe("run-session-abc-123");
  });

  it("does not pass sessionId when resetSession false but context has no sessionId", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams?.resetSession).toBe(false);
    expect(capturedParams?.sessionId).toBeUndefined();
  });

  it("passes model to runner when node has model", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams?.model).toBe("claude-opus-4-6");
  });

  it("does not pass model when node model is empty string", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams).not.toHaveProperty("model");
  });

  it("routes to claudeCodeRunner when agent definition has runner: claude-code", async () => {
    let usedRunner: string | null = null;
    const agentRunner: AgentRunner = async () => { usedRunner = "agentRunner"; return { text: "from agent" }; };
    const claudeCodeRunner: AgentRunner = async () => { usedRunner = "claudeCodeRunner"; return { text: "from claude" }; };
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

  it("prepends systemPrompt from agent definition to node prompt", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => { capturedParams = params; return { text: "ok" }; };
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

    expect(capturedParams?.prompt).toBe("You are a technical writer.\n\nWrite a post.");
  });

  it("node-level model overrides agent definition model", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => { capturedParams = params; return { text: "ok" }; };
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

    expect(capturedParams?.model).toBe("claude-opus-4-6");
  });

  it("uses agent definition model when node does not specify one", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => { capturedParams = params; return { text: "ok" }; };
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

    expect(capturedParams?.model).toBe("claude-sonnet-4-6");
    expect(capturedParams?.mode).toBe("plan");
  });

  it("falls through to agentRunner when agent definition has no claude-code runner", async () => {
    let usedRunner: string | null = null;
    const agentRunner: AgentRunner = async () => { usedRunner = "agentRunner"; return { text: "from agent" }; };
    const claudeCodeRunner: AgentRunner = async () => { usedRunner = "claudeCodeRunner"; return { text: "from claude" }; };
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

  it("appends output schema instruction to prompt when contracts.output is set", async () => {
    let capturedParams: Parameters<AgentRunner>[0] | null = null;
    const capturingRunner: AgentRunner = async (params) => {
      capturedParams = params;
      return { text: "ok" };
    };
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

    expect(capturedParams?.prompt).toContain("Write features.");
    expect(capturedParams?.prompt).toContain("JSON object only");
    expect(capturedParams?.prompt).toContain("no markdown");
    expect(capturedParams?.prompt).toContain("required");
    expect(capturedParams?.prompt).toContain("features");
    expect(capturedParams?.prompt).toContain("type");
    expect(capturedParams?.prompt).toContain("object");
  });
});
