#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PipelineRunStore } from "./run-store.js";
import { createRunQueue } from "./run-queue.js";
import { PipelineRegistry } from "./registry.js";
import { createScheduler } from "./scheduler.js";
import { resolveMcpConfig, resolveStandaloneAgentRunner, resolveStandaloneClaudeCodeRunner, resolveStandaloneCodexRunner } from "./mcp/config.js";
import { createMcpServer } from "./mcp/server.js";
import type { McpToolContext } from "./mcp/tools.js";

async function main() {
  const config = resolveMcpConfig();

  const store = new PipelineRunStore(config.runsDir);
  await store.init();

  const queue = createRunQueue(store);
  const registry = new PipelineRegistry(config.pipelinesDir);
  const agentRunner = resolveStandaloneAgentRunner();
  const claudeCodeRunner = resolveStandaloneClaudeCodeRunner();
  const codexRunner = resolveStandaloneCodexRunner();

  const scheduler = createScheduler({
    store,
    queue,
    registry,
    maxConcurrency: config.maxConcurrency,
    agentRunner,
    ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
    ...(codexRunner !== undefined && { codexRunner }),
  });

  scheduler.start();

  const ctx: McpToolContext = {
    registry,
    queue,
    store,
    runsDir: config.runsDir,
  };

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Graceful shutdown
  const shutdown = () => {
    scheduler.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[ripline-mcp] fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
