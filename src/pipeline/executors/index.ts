import type { PipelineNode, AgentDefinition, SkillsRegistry } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import { executeInput } from "./input.js";
import { executeTransform } from "./transform.js";
import { executeOutput } from "./output.js";
import { executeEnqueue } from "./enqueue.js";
import { executeCollectChildren } from "./collect-children.js";
import type { AgentRunner } from "./agent.js";
import { executeAgent } from "./agent.js";
import { executeLoop } from "./loop.js";
import { executeSwitch } from "./switch.js";
import { executeShell } from "./shell.js";

export type { NodeResult, ExecutorContext, NodeExecutor } from "./types.js";
export type { AgentRunner, AgentResult } from "./agent.js";
export { executeInput } from "./input.js";
export { executeTransform } from "./transform.js";
export { executeOutput } from "./output.js";
export { executeEnqueue } from "./enqueue.js";
export { executeCollectChildren } from "./collect-children.js";
export { executeAgent } from "./agent.js";
export { executeLoop } from "./loop.js";
export { executeSwitch } from "./switch.js";

export type ExecutorRegistryOptions = {
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
  /** Named agent definitions. Claude Code agents are routed automatically by their runner field. */
  agentDefinitions?: Record<string, AgentDefinition>;
  /** Skills registry for resolving agent skill shorthand names to MCP server configs. */
  skillsRegistry?: SkillsRegistry;
  /** Directory containing per-skill markdown files (e.g. ~/.ripline/skills/). */
  skillsDir?: string;
};

const executors: Map<string, (node: PipelineNode, context: ExecutorContext, options?: ExecutorRegistryOptions) => Promise<NodeResult>> = new Map();

function registerExecutors() {
  executors.set("input", (node, ctx) => executeInput(node as import("../../types.js").InputNode, ctx));
  executors.set("transform", (node, ctx) => executeTransform(node as import("../../types.js").TransformNode, ctx));
  executors.set("output", (node, ctx) => executeOutput(node as import("../../types.js").OutputNode, ctx));
  executors.set("enqueue", (node, ctx) => executeEnqueue(node as import("../../types.js").EnqueueNode, ctx));
  executors.set("collect_children", (node, ctx) => executeCollectChildren(node as import("../../types.js").CollectChildrenNode, ctx));
  executors.set("loop", (node, ctx, options) => executeLoop(
    node as import("../../types.js").LoopNode,
    ctx,
    {
      ...(options?.agentRunner !== undefined && { agentRunner: options.agentRunner }),
      ...(options?.claudeCodeRunner !== undefined && { claudeCodeRunner: options.claudeCodeRunner }),
      ...(options?.agentDefinitions !== undefined && { agentDefinitions: options.agentDefinitions }),
      ...(options?.skillsRegistry !== undefined && { skillsRegistry: options.skillsRegistry }),
      ...(options?.skillsDir !== undefined && { skillsDir: options.skillsDir }),
    }
  ));
  executors.set("switch", (node, ctx) => executeSwitch(node as import("../../types.js").SwitchNode, ctx));
  executors.set("shell", (node, ctx) => executeShell(node as import("../../types.js").ShellNode, ctx));
  executors.set("agent", (node, ctx, options) => {
    const agentNode = node as import("../../types.js").AgentNode;
    return executeAgent(
      agentNode,
      ctx,
      {
        ...(options?.agentRunner !== undefined && { agentRunner: options.agentRunner }),
        ...(options?.claudeCodeRunner !== undefined && { claudeCodeRunner: options.claudeCodeRunner }),
      },
      options?.agentDefinitions,
      options?.skillsRegistry,
      options?.skillsDir
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
