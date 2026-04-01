import path from "node:path";
import os from "node:os";
import { resolvePipelineDir } from "../config.js";
import { resolveStandaloneLlmAgentConfig, resolveClaudeCodeConfig, resolveCodexConfig } from "../agent-runner-config.js";
import { createLlmAgentRunner } from "../llm-agent-runner.js";
import { createClaudeCodeRunner } from "../claude-code-runner.js";
import { createCodexRunner } from "../codex-runner.js";
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

  const pipelinesDir = resolvePipelineDir({
    ...(pipelinesDirFlag !== undefined && { flag: pipelinesDirFlag }),
    homedir,
  });

  return {
    pipelinesDir,
    runsDir: runsDir !== undefined ? path.resolve(runsDir) : path.join(homedir, ".ripline", "runs"),
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

/**
 * Build the Claude Code runner for nodes with runner: claude-code.
 * Returns the runner when config is available, undefined otherwise.
 */
export function resolveStandaloneClaudeCodeRunner(homedir: string = os.homedir()): AgentRunner | undefined {
  const config = resolveClaudeCodeConfig({ homedir });
  if (!config) return undefined;
  return createClaudeCodeRunner(config);
}

/**
 * Build the Codex runner for nodes with runner: codex.
 * Returns the runner when config is available, undefined otherwise.
 */
export function resolveStandaloneCodexRunner(homedir: string = os.homedir()): AgentRunner | undefined {
  const config = resolveCodexConfig({ homedir });
  if (!config) return undefined;
  return createCodexRunner(config);
}
