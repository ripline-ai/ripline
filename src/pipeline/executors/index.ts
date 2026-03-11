import type { PipelineNode, AgentDefinition } from "../../types.js";
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
  /** Named agent definitions. Claude Code agents are routed automatically by their runner field. */
  agentDefinitions?: Record<string, AgentDefinition>;
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
    return executeAgent(
      agentNode,
      ctx,
      {
        ...(options?.agentRunner !== undefined && { agentRunner: options.agentRunner }),
        ...(options?.claudeCodeRunner !== undefined && { claudeCodeRunner: options.claudeCodeRunner }),
      },
      options?.agentDefinitions
    );
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
