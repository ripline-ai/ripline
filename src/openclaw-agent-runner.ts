import { randomUUID } from "node:crypto";
import type { AgentResult, AgentRunner } from "./pipeline/executors/agent.js";

/** OpenClaw plugin API surface used to run agent commands. */
export type OpenClawPluginApi = {
  runtime: {
    system: {
      runCommandWithTimeout(
        command: string[],
        options?: { input?: string; timeoutMs?: number } | number
      ): Promise<{ code: number | null; signal?: string | null; stdout: string; stderr: string }>;
    };
  };
};

/** JSON envelope from `openclaw agent --json`. Supports both legacy {text} and current {status, result} formats. */
type AgentJsonEnvelope = {
  text?: string;
  tokenUsage?: { input?: number; output?: number };
  status?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
    meta?: { agentMeta?: { usage?: { input?: number; output?: number } } };
  };
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
    args.push("--session-id", sessionId);
    args.push("--message", params.prompt);
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

    const { code, stdout, stderr } = await runCommandWithTimeout(
      args,
      { timeoutMs }
    );

    if (code !== 0) {
      const msg = stderr.trim() || stdout.trim() || `exit code ${code}`;
      throw new Error(`Agent run failed: ${msg}`);
    }

    // Strip any config warning lines that precede the JSON object
    const jsonStart = stdout.indexOf("{");
    const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart).trim() : stdout.trim();

    let envelope: unknown;
    try {
      envelope = JSON.parse(jsonText) as AgentJsonEnvelope;
    } catch {
      throw new Error(
        `Agent output was not valid JSON. stdout: ${stdout.slice(0, 200)}`
      );
    }

    if (!envelope || typeof envelope !== "object") {
      throw new Error(
        `Agent JSON envelope must have a "text" string. Got: ${JSON.stringify(envelope).slice(0, 200)}`
      );
    }

    const env = envelope as AgentJsonEnvelope;
    // Support both legacy {text} format and current {status, result:{payloads:[{text}]}} format
    const text =
      typeof env.text === "string"
        ? env.text
        : env.result?.payloads?.[0]?.text ?? undefined;

    if (typeof text !== "string") {
      throw new Error(
        `Agent JSON envelope must have a "text" string. Got: ${JSON.stringify(envelope).slice(0, 200)}`
      );
    }

    const usageFromResult = env.result?.meta?.agentMeta?.usage;
    const tokenUsage = env.tokenUsage ?? usageFromResult;

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
