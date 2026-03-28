import type { SwitchNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import { evaluateExpression } from "../../expression.js";

/**
 * Evaluate a switch node's expression against the run context,
 * match the result to a case key, and store the active port as an artifact.
 */
export async function executeSwitch(
  node: SwitchNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const exprContext: Record<string, unknown> = {
    inputs: context.inputs,
    artifacts: context.artifacts,
    env: context.env,
  };

  const result = evaluateExpression<unknown>(node.expression, exprContext);
  const resultStr = String(result);

  // Check if result matches any case key
  if (resultStr in node.cases) {
    const value = { __activePort: resultStr };
    context.artifacts[node.id] = value;
    return { artifactKey: node.id, value };
  }

  // Fall back to default port if declared
  if (node.default !== undefined) {
    const value = { __activePort: node.default };
    context.artifacts[node.id] = value;
    return { artifactKey: node.id, value };
  }

  // No match and no default — throw descriptive error
  const caseKeys = Object.keys(node.cases).join(", ");
  throw new Error(
    `Switch node "${node.id}": expression "${node.expression}" evaluated to "${resultStr}" which does not match any case [${caseKeys}] and no default port is defined.`
  );
}
