import path from "node:path";
import os from "node:os";
import { resolvePipelineDir, loadUserConfig } from "../config.js";
import { resolveStandaloneLlmAgentConfig } from "../agent-runner-config.js";
import { createLlmAgentRunner } from "../llm-agent-runner.js";
import type { AgentRunner } from "../pipeline/executors/agent.js";

export type McpServerConfig = {
  pipelinesDir: string;
  runsDir: string;
  maxConcurrency: number;
};

/**
 * Parse CLI args and resolve final MCP server config.
 * runsDir is CLI-only — it does not exist on RiplineUserConfig.
 * pipelinesDir: CLI --pipelines-dir > ~/.ripline/config.json pipelineDir > default.
 */
export function resolveMcpConfig(argv: string[] = process.argv.slice(2), homedir: string = os.homedir()): McpServerConfig {
  let pipelinesDirFlag: string | undefined;
  let runsDir: string | undefined;
  let maxConcurrency = 4;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--pipelines-dir" && argv[i + 1]) {
      pipelinesDirFlag = argv[++i];
    } else if (arg === "--runs-dir" && argv[i + 1]) {
      runsDir = argv[++i];
    } else if (arg === "--max-concurrency" && argv[i + 1]) {
      const n = parseInt(argv[++i]!, 10);
      if (Number.isInteger(n) && n > 0) maxConcurrency = n;
    }
  }

  const pipelinesDir = resolvePipelineDir({ flag: pipelinesDirFlag, homedir });

  return {
    pipelinesDir,
    runsDir: runsDir ?? ".ripline/runs",
    maxConcurrency,
  };
}

/**
 * Build the agent runner for non-claude-code nodes.
 * Returns LlmAgentRunner when credentials are configured, stub runner otherwise.
 * Logs a warning to stderr when falling back to stub.
 */
export function resolveStandaloneAgentRunner(): AgentRunner {
  const llmConfig = resolveStandaloneLlmAgentConfig();
  if (llmConfig) {
    return createLlmAgentRunner(llmConfig);
  }
  process.stderr.write("[ripline-mcp] no LLM runner configured, using stub for agent nodes\n");
  return async (params) => ({
    text: `[stub] no LLM runner configured (agentId: ${params.agentId})`,
  });
}
