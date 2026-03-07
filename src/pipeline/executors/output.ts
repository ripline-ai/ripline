import type { OutputNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

export async function executeOutput(
  node: OutputNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const key = node.path ?? node.id;
  const sourceKey = node.source ?? node.id;
  const value = context.artifacts[sourceKey];
  if (node.merge && typeof value === "object" && value !== null && typeof context.outputs[key] === "object" && context.outputs[key] !== null) {
    (context.outputs as Record<string, unknown>)[key] = {
      ...(context.outputs[key] as object),
      ...(value as object),
    };
  } else {
    (context.outputs as Record<string, unknown>)[key] = value;
  }
  const written = context.outputs[key];
  return { artifactKey: key, value: written };
}
