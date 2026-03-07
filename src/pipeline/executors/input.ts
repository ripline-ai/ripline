import type { InputNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function selectPath(obj: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".").filter(Boolean);
  let current: unknown = obj;
  for (const segment of segments) {
    if (current != null && typeof current === "object" && segment in (current as object)) {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export async function executeInput(
  node: InputNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const raw = node.path
    ? selectPath(context.inputs as Record<string, unknown>, node.path)
    : context.inputs;
  const value = raw !== undefined ? deepClone(raw) : undefined;
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
