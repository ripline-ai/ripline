import type { AgentRunner } from "../pipeline/executors/agent.js";

/**
 * RunnerRegistry — pluggable registry for mapping runner type strings to
 * AgentRunner implementations.
 *
 * Consumers register runner factories by name and resolve them at execution
 * time, allowing third-party runners to be added without modifying core code.
 */
export interface RunnerRegistry {
  register(runnerType: string, runner: AgentRunner): void;
  resolve(runnerType: string): AgentRunner | undefined;
}

/** Default Map-backed RunnerRegistry implementation. */
export class DefaultRunnerRegistry implements RunnerRegistry {
  private readonly runners = new Map<string, AgentRunner>();

  register(runnerType: string, runner: AgentRunner): void {
    this.runners.set(runnerType, runner);
  }

  resolve(runnerType: string): AgentRunner | undefined {
    return this.runners.get(runnerType);
  }
}
