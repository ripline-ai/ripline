import { randomUUID } from "node:crypto";
import type { AgentRunner, AgentRunParams, AgentEvent } from "../../pipeline/executors/agent.js";

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

/** JSON envelope from `openclaw agent --json`. Supports both legacy {text} and current {status, result:{payloads}} formats. */
type AgentJsonEnvelope = {
  // Legacy flat format
  text?: string;
  tokenUsage?: { input?: number; output?: number };
  // Current openclaw format
  status?: string;
  result?: {
    payloads?: Array<{ text?: string }>;
    meta?: {
      agentMeta?: {
        usage?: { input?: number; output?: number };
      };
    };
  };
};

const DEFAULT_AGENT_TIMEOUT_MS = 300_000; // 5 min

/**
 * Create an AgentRunner that delegates to OpenClaw via `openclaw agent --json`.
 * Uses the plugin API's runCommandWithTimeout so pipelines use the configured models, tools, and sandbox.
 */
export function createOpenClawAgentRunner(api: OpenClawPluginApi): AgentRunner {
  const { runCommandWithTimeout } = api.runtime.system;

  async function* runImpl(params: AgentRunParams): AsyncGenerator<AgentEvent> {
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

    // openclaw CLI may prepend config warning lines before the JSON payload
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
        `Agent output was not a JSON object. stdout: ${stdout.slice(0, 200)}`
      );
    }

    const env = envelope as AgentJsonEnvelope;

    // Extract text: support both legacy {text} and current {result:{payloads:[{text}]}} formats
    const text =
      typeof env.text === "string"
        ? env.text
        : env.result?.payloads?.[0]?.text ?? undefined;

    if (typeof text !== "string") {
      throw new Error(
        `Could not extract text from agent output. Got: ${JSON.stringify(envelope).slice(0, 200)}`
      );
    }

    // Extract token usage from either format
    const usageRaw = env.tokenUsage ?? env.result?.meta?.agentMeta?.usage;
    const usage: import("../../pipeline/executors/agent.js").TokenUsage = {};
    if (usageRaw && typeof usageRaw === "object") {
      if (typeof (usageRaw as { input?: number }).input === "number") {
        usage.inputTokens = (usageRaw as { input: number }).input;
      }
      if (typeof (usageRaw as { output?: number }).output === "number") {
        usage.outputTokens = (usageRaw as { output: number }).output;
      }
    }

    yield {
      type: "message_done",
      text,
      ...(Object.keys(usage).length > 0 && { usage }),
    } satisfies AgentEvent;
  }

  return {
    run(params: AgentRunParams): AsyncGenerator<AgentEvent> {
      return runImpl(params);
    },
  };
}
