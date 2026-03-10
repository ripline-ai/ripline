import type { AgentNode } from "../../types.js";
import type { Logger } from "../../log.js";
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
  /** Set when node has runner: claude-code; runners that don't use it ignore. */
  runner?: "claude-code";
  mode?: "plan" | "execute";
  cwd?: string;
  /** When runner is claude-code: allow bypass for this node when global bypass is enabled. Omit/false = dontAsk. */
  dangerouslySkipPermissions?: boolean;
  /** When runner is claude-code: model to use (e.g. claude-sonnet-4-6). Omit to use config or CLI default. */
  model?: string;
  /** Current run ID (set when running a stored run); used for run-scoped logging. */
  runId?: string;
  /** Current node ID; used for run-scoped logging. */
  nodeId?: string;
  /** Run-scoped logger (child with runId/nodeId). When set, logs go here in addition to or instead of stderr. */
  log?: Logger;
}) => Promise<AgentResult>;

const interpolationContext = (context: ExecutorContext) => ({
  inputs: context.inputs,
  ...context.inputs,
  ...context.artifacts,
  env: context.env,
});

export async function executeAgent(
  node: AgentNode,
  context: ExecutorContext,
  agentRunner: AgentRunner
): Promise<NodeResult> {
  const agentId = node.agentId ?? "default";
  const ctx = interpolationContext(context);
  let prompt = interpolateTemplate(node.prompt, ctx);

  if (node.contracts?.output && typeof node.contracts.output === "object") {
    const schemaBlock = `\n\nRespond with a single JSON object only (no markdown, code fences, or explanation). Your response must conform to this schema:\n\`\`\`json\n${JSON.stringify(node.contracts.output, null, 2)}\n\`\`\``;
    prompt = prompt + schemaBlock;
  }

  const resolvedCwd =
    node.cwd !== undefined && node.cwd.trim() !== ""
      ? interpolateTemplate(node.cwd.trim(), ctx)
      : undefined;

  const resetSession = node.resetSession ?? true;
  const result = await agentRunner({
    agentId,
    prompt,
    resetSession,
    ...(resetSession === false && context.sessionId !== undefined && { sessionId: context.sessionId }),
    ...(node.thinking !== undefined && { thinking: node.thinking }),
    ...(node.timeoutSeconds !== undefined && { timeoutSeconds: node.timeoutSeconds }),
    ...(node.runner !== undefined && { runner: node.runner }),
    ...(node.mode !== undefined && { mode: node.mode }),
    ...(resolvedCwd !== undefined && { cwd: resolvedCwd }),
    ...(node.dangerouslySkipPermissions !== undefined && { dangerouslySkipPermissions: node.dangerouslySkipPermissions }),
    ...(node.model !== undefined && node.model.trim() !== "" && { model: node.model.trim() }),
    ...(context.runId !== undefined && { runId: context.runId, nodeId: node.id }),
    ...(context.log !== undefined && { log: context.log }),
  });

  const value = {
    text: result.text,
    tokenUsage: result.tokenUsage,
  };
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
