import type { RunnerRegistry } from "../../interfaces/runner-registry.js";
import { createOpenClawAgentRunner, type OpenClawPluginApi } from "./openclaw-runner.js";

export { createOpenClawAgentRunner, type OpenClawPluginApi } from "./openclaw-runner.js";

/** Returns true when the OpenClaw runtime is available (i.e. plugin is running inside OpenClaw). */
export function hasOpenClawRuntime(
  api: { runtime?: OpenClawPluginApi["runtime"] }
): api is { runtime: OpenClawPluginApi["runtime"] } {
  return Boolean(
    api.runtime?.system?.runCommandWithTimeout &&
    typeof api.runtime.system.runCommandWithTimeout === "function"
  );
}

/** Register the OpenClaw agent runner into the registry when the runtime is detected. */
export function registerOpenClawRunner(
  registry: RunnerRegistry,
  api: { runtime?: OpenClawPluginApi["runtime"] }
): void {
  if (!hasOpenClawRuntime(api)) return;
  registry.register("openclaw", createOpenClawAgentRunner(api as OpenClawPluginApi));
}
