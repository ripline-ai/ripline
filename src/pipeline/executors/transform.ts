import vm from "node:vm";
import type { TransformNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Run expression in a sandbox with only inputs, artifacts, env. No require/process.
 * Timeout to guard against long-running code.
 */
export async function executeTransform(
  node: TransformNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const timeoutMs = DEFAULT_TIMEOUT_MS;
  const sandbox = {
    inputs: context.inputs,
    artifacts: context.artifacts,
    env: context.env,
    loop: context.artifacts["loop"],
    JSON,
  };
  vm.createContext(sandbox);

  const code = `(function() { return (${node.expression}); })()`;
  const value = vm.runInContext(code, sandbox, {
    timeout: timeoutMs,
  });

  const artifactKey = node.assigns ?? node.id;
  context.artifacts[artifactKey] = value;
  return { artifactKey, value };
}
