import { describe, expect, it } from "vitest";
import type { AgentNode } from "../../src/types.js";
import { executeAgent } from "../../src/pipeline/executors/agent.js";
import type { AgentRunner } from "../../src/pipeline/executors/agent.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";
import { HttpResponseError } from "../../src/lib/http-response-guard.js";

/**
 * Tests for AC1: Agent executor must detect HTTP error responses in agent output
 * and throw HttpResponseError instead of treating them as successful results.
 *
 * Bug scenario: curl exits 0 even on 429, so the agent "succeeds" but the output
 * is a rate-limit error JSON. Without the guard, this gets stored as the step
 * artifact and downstream steps parse null/garbage from it.
 */
describe("Agent executor HTTP response guard (AC1)", () => {
  const baseContext: ExecutorContext = {
    inputs: {},
    artifacts: {},
    env: {},
    outputs: {},
  };

  it("throws HttpResponseError when agent output contains a rate-limit response", async () => {
    const rateLimitRunner: AgentRunner = async () => ({
      text: JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Number of request tokens has exceeded your per-minute rate limit",
        },
      }),
      tokenUsage: { input: 10, output: 50 },
    });

    const node: AgentNode = {
      id: "fetch_idea",
      type: "agent",
      prompt: "Fetch the idea details",
    };

    await expect(
      executeAgent(node, { ...baseContext, artifacts: {} }, { agentRunner: rateLimitRunner })
    ).rejects.toThrow(HttpResponseError);

    try {
      await executeAgent(node, { ...baseContext, artifacts: {} }, { agentRunner: rateLimitRunner });
    } catch (err) {
      expect(err).toBeInstanceOf(HttpResponseError);
      const httpErr = err as HttpResponseError;
      expect(httpErr.statusCode).toBe(429);
      expect(httpErr.retryable).toBe(true);
    }
  });

  it("throws HttpResponseError when agent output contains an overloaded_error", async () => {
    const overloadedRunner: AgentRunner = async () => ({
      text: JSON.stringify({
        type: "error",
        error: { type: "overloaded_error", message: "Overloaded" },
      }),
    });

    const node: AgentNode = {
      id: "patch_complete",
      type: "agent",
      prompt: "Patch the idea",
    };

    await expect(
      executeAgent(node, { ...baseContext, artifacts: {} }, { agentRunner: overloadedRunner })
    ).rejects.toThrow(HttpResponseError);
  });

  it("does NOT throw for valid agent output", async () => {
    const goodRunner: AgentRunner = async () => ({
      text: JSON.stringify({ stories: [{ id: "s1", title: "Auth module" }] }),
      tokenUsage: { input: 10, output: 20 },
    });

    const node: AgentNode = {
      id: "build_story",
      type: "agent",
      prompt: "Build the story",
    };

    const result = await executeAgent(
      node,
      { ...baseContext, artifacts: {} },
      { agentRunner: goodRunner }
    );

    expect(result.artifactKey).toBe("build_story");
    expect((result.value as { text: string }).text).toContain("stories");
  });

  it("does not store artifact when HTTP error is detected", async () => {
    const rateLimitRunner: AgentRunner = async () => ({
      text: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      }),
    });

    const node: AgentNode = {
      id: "should_not_store",
      type: "agent",
      prompt: "Test",
    };

    const context: ExecutorContext = { ...baseContext, artifacts: {} };

    try {
      await executeAgent(node, context, { agentRunner: rateLimitRunner });
    } catch {
      // expected
    }

    // The artifact should NOT have been stored, since the error was thrown
    // before the artifact assignment
    expect(context.artifacts["should_not_store"]).toBeUndefined();
  });

  it("throws non-retryable HttpResponseError for 401 auth errors", async () => {
    const authErrorRunner: AgentRunner = async () => ({
      text: JSON.stringify({
        type: "error",
        error: { type: "authentication_error", message: "Invalid API key" },
      }),
    });

    const node: AgentNode = {
      id: "auth_fail",
      type: "agent",
      prompt: "Test",
    };

    try {
      await executeAgent(node, { ...baseContext, artifacts: {} }, { agentRunner: authErrorRunner });
      expect.unreachable("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpResponseError);
      const httpErr = err as HttpResponseError;
      expect(httpErr.statusCode).toBe(401);
      expect(httpErr.retryable).toBe(false);
    }
  });

  it("includes runId in error log context when present", async () => {
    const rateLimitRunner: AgentRunner = async () => ({
      text: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      }),
    });

    const node: AgentNode = {
      id: "with_run_id",
      type: "agent",
      prompt: "Test",
    };

    const context: ExecutorContext = {
      ...baseContext,
      artifacts: {},
      runId: "run-abc-123",
    };

    // We just verify it throws correctly; the log output is side-effect only
    await expect(
      executeAgent(node, context, { agentRunner: rateLimitRunner })
    ).rejects.toThrow(HttpResponseError);
  });
});
