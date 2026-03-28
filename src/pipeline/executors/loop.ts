import vm from "node:vm";
import type { LoopNode, PipelineNode, AgentDefinition, SkillsRegistry } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import type { AgentRunner } from "./agent.js";
import { executeAgent } from "./agent.js";
import { executeTransform } from "./transform.js";

const DEFAULT_TIMEOUT_MS = 5000;

type LoopOptions = {
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
  agentDefinitions?: Record<string, AgentDefinition>;
  skillsRegistry?: SkillsRegistry;
  skillsDir?: string;
};

/**
 * Execute a single body node inside a loop iteration.
 * Handles agent and transform types; other types are skipped.
 */
async function executeBodyNode(
  node: PipelineNode,
  context: ExecutorContext,
  options?: LoopOptions
): Promise<NodeResult | null> {
  if (node.type === "agent") {
    const agentNode = node as import("../../types.js").AgentNode;
    return executeAgent(
      agentNode,
      context,
      {
        ...(options?.agentRunner !== undefined && { agentRunner: options.agentRunner }),
        ...(options?.claudeCodeRunner !== undefined && { claudeCodeRunner: options.claudeCodeRunner }),
      },
      options?.agentDefinitions,
      options?.skillsRegistry,
      options?.skillsDir
    );
  }
  if (node.type === "transform") {
    const transformNode = node as import("../../types.js").TransformNode;
    return executeTransform(transformNode, context);
  }
  return null;
}

/**
 * Loop node executor: iterates over a collection artifact, running body nodes
 * for each item. The current item is exposed as `loop.{itemVar}` (default: `loop.item`)
 * in the interpolation context (via context.artifacts.loop).
 */
export async function executeLoop(
  node: LoopNode,
  context: ExecutorContext,
  options?: LoopOptions
): Promise<NodeResult> {
  // Evaluate collection expression in a sandboxed VM
  const sandbox = {
    inputs: context.inputs,
    artifacts: context.artifacts,
    env: context.env,
    JSON,
  };
  vm.createContext(sandbox);

  const code = `(function() { return (${node.collection}); })()`;
  const collection = vm.runInContext(code, sandbox, { timeout: DEFAULT_TIMEOUT_MS });

  if (!Array.isArray(collection)) {
    throw new Error(
      `Loop node "${node.id}": collection expression must evaluate to an array (got ${typeof collection})`
    );
  }

  const maxIterations = node.maxIterations ?? collection.length;
  const itemVar = node.itemVar ?? "item";
  const indexVar = node.indexVar;
  const bodyNodes = node.body.nodes ?? [];
  const iterationResults: unknown[] = [];

  for (let i = 0; i < Math.min(collection.length, maxIterations); i++) {
    const item = collection[i];

    // Expose current item as loop.{itemVar} in artifacts so agent prompts can
    // reference {{ loop.idea.title }} etc. via interpolateTemplate's spread of artifacts.
    context.artifacts["loop"] = {
      [itemVar]: item,
      ...(indexVar !== undefined ? { [indexVar]: i } : {}),
      index: i,
      results: iterationResults,
    };

    // Execute body nodes in declaration order (edges ignored for now — simple linear body)
    for (const bodyNode of bodyNodes) {
      const result = await executeBodyNode(bodyNode, context, options);
      if (result) {
        context.artifacts[result.artifactKey] = result.value;
      }
    }

    // Capture last body node's artifact as the iteration result
    const lastBodyNode = bodyNodes[bodyNodes.length - 1];
    iterationResults.push(lastBodyNode ? context.artifacts[lastBodyNode.id] : null);

    // Evaluate exitCondition after each iteration; break early if truthy
    if (node.exitCondition) {
      const exitSandbox = {
        inputs: context.inputs,
        artifacts: context.artifacts,
        env: context.env,
        loop: context.artifacts["loop"],
        JSON,
      };
      vm.createContext(exitSandbox);
      const exitCode = `(function() { return (${node.exitCondition}); })()`;
      const shouldExit = vm.runInContext(exitCode, exitSandbox, { timeout: DEFAULT_TIMEOUT_MS });
      if (shouldExit) {
        break;
      }
    }
  }

  // Clean up loop context variable
  delete context.artifacts["loop"];

  const value = iterationResults;
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
