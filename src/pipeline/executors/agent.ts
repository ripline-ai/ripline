import type { AgentNode } from "../../types.js";
import { interpolateTemplate } from "../../expression.js";
import type { ExecutorContext, NodeResult } from "./types.js";

/** Result of a single agent (sessions_spawn) call. */
export type AgentResult = {
  text: string;
  tokenUsage?: { input?: number; output?: number };
};

/** Injectable runner for agent nodes (e.g. OpenClaw sessions_spawn). */
export type AgentRunner = (params: {
  agentId: string;
  prompt: string;
  /** When true or omitted, use a new session (context isolation). When false, use sessionId for continuity. */
  resetSession?: boolean;
  /** Shared run-level session when resetSession is false. */
  sessionId?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  timeoutSeconds?: number;
}) => Promise<AgentResult>;

export async function executeAgent(
  node: AgentNode,
  context: ExecutorContext,
  agentRunner: AgentRunner
): Promise<NodeResult> {
  const agentId = node.agentId ?? "default";
  const prompt = interpolateTemplate(node.prompt, {
    ...context.inputs,
    ...context.artifacts,
    env: context.env,
  });

  const resetSession = node.resetSession ?? true;
  const result = await agentRunner({
    agentId,
    prompt,
    resetSession,
    ...(resetSession === false && context.sessionId !== undefined && { sessionId: context.sessionId }),
    ...(node.thinking !== undefined && { thinking: node.thinking }),
    ...(node.timeoutSeconds !== undefined && { timeoutSeconds: node.timeoutSeconds }),
  });

  const value = {
    text: result.text,
    tokenUsage: result.tokenUsage,
  };
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
