import { randomUUID } from "node:crypto";
import type { AgentResult, AgentRunner } from "./pipeline/executors/agent.js";

/** OpenClaw plugin API surface used to run agent commands. */
export type OpenClawPluginApi = {
  runtime: {
    system: {
      runCommandWithTimeout(
        command: string[],
        stdin?: string,
        timeoutMs?: number
      ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
  };
};

/** JSON envelope from `openclaw agent --json` (text + optional token usage). */
type AgentJsonEnvelope = {
  text: string;
  tokenUsage?: { input?: number; output?: number };
};

const DEFAULT_AGENT_TIMEOUT_MS = 300_000; // 5 min

/**
 * Create an AgentRunner that delegates to OpenClaw via `openclaw agent --json`.
 * Uses the plugin API's runCommandWithTimeout so pipelines use the configured models, tools, and sandbox.
 */
export function createOpenClawAgentRunner(api: OpenClawPluginApi): AgentRunner {
  const { runCommandWithTimeout } = api.runtime.system;

  return async (params): Promise<AgentResult> => {
    const args = ["openclaw", "agent", "--json", "--agent", params.agentId];
    const sessionId =
      params.resetSession === false && params.sessionId !== undefined
        ? params.sessionId
        : randomUUID();
    args.push("--session", sessionId);
    if (params.thinking !== undefined) {
      args.push("--thinking", params.thinking);
    }
    if (params.timeoutSeconds !== undefined) {
      args.push("--timeout", String(params.timeoutSeconds));
    }

    const timeoutMs =
      params.timeoutSeconds !== undefined
        ? params.timeoutSeconds * 1000
        : DEFAULT_AGENT_TIMEOUT_MS;

    const { exitCode, stdout, stderr } = await runCommandWithTimeout(
      args,
      params.prompt,
      timeoutMs
    );

    if (exitCode !== 0) {
      const msg = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
      throw new Error(`Agent run failed: ${msg}`);
    }

    let envelope: unknown;
    try {
      envelope = JSON.parse(stdout.trim()) as AgentJsonEnvelope;
    } catch {
      throw new Error(
        `Agent output was not valid JSON. stdout: ${stdout.slice(0, 200)}`
      );
    }

    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("text" in envelope) ||
      typeof (envelope as AgentJsonEnvelope).text !== "string"
    ) {
      throw new Error(
        `Agent JSON envelope must have a "text" string. Got: ${JSON.stringify(envelope).slice(0, 200)}`
      );
    }

    const { text, tokenUsage } = envelope as AgentJsonEnvelope;
    const result: AgentResult = { text };
    if (tokenUsage && typeof tokenUsage === "object") {
      result.tokenUsage = {
        ...(typeof tokenUsage.input === "number" && { input: tokenUsage.input }),
        ...(typeof tokenUsage.output === "number" && {
          output: tokenUsage.output,
        }),
      };
    }
    return result;
  };
}
