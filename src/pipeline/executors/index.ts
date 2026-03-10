import type { PipelineNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import { executeInput } from "./input.js";
import { executeTransform } from "./transform.js";
import { executeOutput } from "./output.js";
import { executeEnqueue } from "./enqueue.js";
import { executeCollectChildren } from "./collect-children.js";
import type { AgentRunner } from "./agent.js";
import { executeAgent } from "./agent.js";

export type { NodeResult, ExecutorContext, NodeExecutor } from "./types.js";
export type { AgentRunner, AgentResult } from "./agent.js";
export { executeInput } from "./input.js";
export { executeTransform } from "./transform.js";
export { executeOutput } from "./output.js";
export { executeEnqueue } from "./enqueue.js";
export { executeCollectChildren } from "./collect-children.js";
export { executeAgent } from "./agent.js";

export type ExecutorRegistryOptions = {
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
};

const executors: Map<string, (node: PipelineNode, context: ExecutorContext, options?: ExecutorRegistryOptions) => Promise<NodeResult>> = new Map();

function registerExecutors() {
  executors.set("input", (node, ctx) => executeInput(node as import("../../types.js").InputNode, ctx));
  executors.set("transform", (node, ctx) => executeTransform(node as import("../../types.js").TransformNode, ctx));
  executors.set("output", (node, ctx) => executeOutput(node as import("../../types.js").OutputNode, ctx));
  executors.set("enqueue", (node, ctx) => executeEnqueue(node as import("../../types.js").EnqueueNode, ctx));
  executors.set("collect_children", (node, ctx) => executeCollectChildren(node as import("../../types.js").CollectChildrenNode, ctx));
  executors.set("agent", (node, ctx, options) => {
    const agentNode = node as import("../../types.js").AgentNode;
    const runner =
      agentNode.runner === "claude-code" && options?.claudeCodeRunner !== undefined
        ? options.claudeCodeRunner
        : options?.agentRunner;
    if (!runner) {
      const msg =
        agentNode.runner === "claude-code"
          ? "Agent node has runner: claude-code but claudeCodeRunner was not provided (use standalone Ripline with Claude Code config; not available inside OpenClaw)"
          : "Agent node requires agentRunner in runner options (e.g. OpenClaw sessions_spawn)";
      return Promise.reject(new Error(msg));
    }
    return executeAgent(agentNode, ctx, runner);
  });
}
registerExecutors();

/**
 * Execute a single node and return result for telemetry.
 */
export async function executeNode(
  node: PipelineNode,
  context: ExecutorContext,
  options?: ExecutorRegistryOptions
): Promise<NodeResult | null> {
  const fn = executors.get(node.type);
  if (!fn) {
    return null;
  }
  return fn(node, context, options);
}
