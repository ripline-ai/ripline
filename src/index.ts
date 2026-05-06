import path from "node:path";
import type { Command } from "commander";
import { createRiplineCliProgram } from "./cli/program.js";
import { startServer, type StartServerOptions } from "./server.js";
import type { OpenClawPluginApi } from "./integrations/openclaw/index.js";
import { registerOpenClawRunner } from "./integrations/openclaw/index.js";
import { createLlmAgentRunner } from "./llm-agent-runner.js";
import { createClaudeCodeRunner } from "./claude-code-runner.js";
import { createCodexRunner } from "./codex-runner.js";
import {
  normalizeLlmAgentConfigFromPlugin,
  normalizeClaudeCodeConfigFromPlugin,
  normalizeCodexConfigFromPlugin,
} from "./agent-runner-config.js";
import { resolveConfig } from "./config.js";
import { DefaultRunnerRegistry } from "./interfaces/runner-registry.js";

interface PluginLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/** Optional OpenClaw runtime; when present, agent nodes delegate to openclaw agent --json. */
interface PluginApi {
  pluginConfig?: unknown;
  logger: PluginLogger;
  registerCli: (builder: (ctx: { program: Command }) => void, opts: { commands: string[] }) => void;
  registerService: (svc: { id: string; start: () => Promise<void> | void; stop: () => Promise<void> | void }) => void;
  /** When the plugin runs inside OpenClaw, runtime provides runCommandWithTimeout for agent runs. */
  runtime?: OpenClawPluginApi["runtime"];
}

/** Build the runner registry for the given plugin API. */
function buildRunnerRegistry(api: PluginApi): DefaultRunnerRegistry {
  const registry = new DefaultRunnerRegistry();

  // Core runners
  const claudeCodeConfig = normalizeClaudeCodeConfigFromPlugin(api.pluginConfig);
  if (claudeCodeConfig) registry.register("claude-code", createClaudeCodeRunner(claudeCodeConfig));
  const codexConfig = normalizeCodexConfigFromPlugin(api.pluginConfig);
  if (codexConfig) registry.register("codex", createCodexRunner(codexConfig));

  const llmConfig = normalizeLlmAgentConfigFromPlugin(api.pluginConfig);
  if (llmConfig) registry.register("llm-agent", createLlmAgentRunner(llmConfig));

  // OpenClaw integration: auto-registers when runtime is detected
  registerOpenClawRunner(registry, api);

  return registry;
}

const DEFAULT_RUNS_DIR = ".ripline/runs";

export type NormalizedConfig = {
  pipelinesDir: string;
  runsDir: string;
  httpPort: number;
  httpPath: string;
  maxConcurrency: number;
  authToken?: string;
};

/** Resolve path: absolute unchanged, relative from process.cwd() (workspace). */
function resolvePath(value: string): string {
  return path.isAbsolute(value) ? path.resolve(value) : path.join(process.cwd(), value);
}

export { createOpenClawAgentRunner, type OpenClawPluginApi } from "./integrations/openclaw/index.js";
export type { AgentEvent, AgentErrorKind, TokenUsage } from "./pipeline/executors/agent.js";
export { collectAgentResult } from "./pipeline/executors/agent.js";
export { createLlmAgentRunner, type LlmAgentRunnerConfig } from "./llm-agent-runner.js";
export { createClaudeCodeRunner, type ClaudeCodeRunnerConfig } from "./claude-code-runner.js";
export { createCodexRunner, type CodexRunnerConfig } from "./codex-runner.js";
export { createGeminiRunner, type GeminiRunnerConfig } from "./gemini-runner.js";
export { createKimiRunner, type KimiRunnerConfig } from "./kimi-runner.js";
export { createOpenCodeRunner, type OpenCodeRunnerConfig } from "./opencode-runner.js";
export {
  executeReviewPhase,
  type ReviewPhaseEvent,
  type ReviewPhaseResult,
  type ReviewPhaseExecutorOptions,
  type VoiceRegistryLike,
  type ReviewerFeedbackEntry,
} from "./pipeline/executors/review-phase.js";
export type { RunDoneEvent } from "./pipeline/runner.js";
export {
  normalizeLlmAgentConfigFromPlugin,
  normalizeClaudeCodeConfigFromPlugin,
  normalizeCodexConfigFromPlugin,
  resolveStandaloneLlmAgentConfig,
  resolveClaudeCodeConfig,
  resolveCodexConfig,
  resolveLlmAgentConfigFromEnv,
  loadLlmAgentConfigFromFile,
} from "./agent-runner-config.js";
export { promoteStep, type PromoteStepParams, type PromoteStepResult } from "./promote-step.js";
export {
  ContainerManager,
  type ContainerSpawnOptions,
  type ContainerResult,
  type ContainerManagerConfig,
} from "./container-manager.js";
export {
  runContainerBuild,
  isDockerAvailable,
  type ContainerBuildConfig,
  type ContainerBuildResult,
} from "./container-build-runner.js";
export {
  mapContainerBuildToRunStatus,
  PROMOTE_STATUS_TO_RUN_STATUS,
  type ContainerStatusMapping,
} from "./container-status-map.js";
export {
  validatePipelineDefinition,
  validateContainerBuildPipeline,
  smokeTestPipelineDefinition,
  type ValidationResult,
  type ValidationIssue,
  type ValidationSeverity,
} from "./pipeline-validator.js";

// Voice registry
export { createVoiceRegistry } from "./voice-registry.js";
export type {
  VoiceRegistry,
  VoiceRegistryEntry,
  VoiceRegistryOptions,
} from "./voice-registry.js";

// Review pipeline parser
export { parseReviewPipeline, loadReviewPipeline } from "./review-pipeline-parser.js";
export type { ParseResult } from "./review-pipeline-parser.js";

// Review pipeline types and schemas
export type {
  AgentLineage,
  VoiceSpec,
  DoerConfig,
  ReviewerConfig,
  PhaseIterateConfig,
  PhaseInputsConfig,
  PlanPhase,
  ReviewPhase,
  ReviewOnlyPhase,
  ShipConfig,
  PipelinePhase,
  ReviewPipelineDefinition,
  RiplineLiteralPhase,
  RiplineInputPhase,
  RiplineTransformPhase,
  RiplineAgentPhase,
  RiplineRunPipelinePhase,
  RiplineLoopPhase,
  RiplineCheckpointPhase,
  RiplineOutputPhase,
  RiplineEnqueuePhase,
  RiplineCollectChildrenPhase,
} from "./review-phase-types.js";
export {
  agentLineageSchema,
  voiceSpecSchema,
  doerConfigSchema,
  reviewerConfigSchema,
  phaseIterateConfigSchema,
  phaseInputsConfigSchema,
  planPhaseSchema,
  reviewPhaseSchema,
  reviewOnlyPhaseSchema,
  shipConfigSchema,
  pipelinePhaseSchema,
  reviewPipelineDefinitionSchema,
  riplineLiteralPhaseSchema,
  riplineInputPhaseSchema,
  riplineTransformPhaseSchema,
  riplineAgentPhaseSchema,
  riplineRunPipelinePhaseSchema,
  riplineLoopPhaseSchema,
  riplineCheckpointPhaseSchema,
  riplineOutputPhaseSchema,
  riplineEnqueuePhaseSchema,
  riplineCollectChildrenPhaseSchema,
  edgeSchema,
} from "./review-phase-types.js";

export function normalizeConfig(raw: unknown): NormalizedConfig {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const pipelinesDir = typeof source.pipelinesDir === "string" && source.pipelinesDir.trim()
    ? resolvePath(source.pipelinesDir)
    : path.join(process.cwd(), "pipelines");
  const runsDir = typeof source.runsDir === "string" && source.runsDir.trim()
    ? resolvePath(source.runsDir)
    : path.join(process.cwd(), DEFAULT_RUNS_DIR);
  const riplineConfig = resolveConfig();
  const httpPort = typeof source.httpPort === "number" ? source.httpPort : riplineConfig.port;
  const httpPath = typeof source.httpPath === "string" ? source.httpPath : "/pipelines";
  const authToken = typeof source.authToken === "string" ? source.authToken : undefined;
  const maxConcurrency = typeof source.maxConcurrency === "number" ? source.maxConcurrency : 1;
  const config: NormalizedConfig = { pipelinesDir, runsDir, httpPort, httpPath, maxConcurrency };
  if (authToken) config.authToken = authToken;
  return config;
}

export default {
  id: "ripline",
  name: "Ripline",
  description: "Ripline pipeline engine + CLI",
  register(api: PluginApi) {
    const cfg = normalizeConfig(api.pluginConfig);
    const registry = buildRunnerRegistry(api);
    const agentRunner = registry.resolve("openclaw") ?? registry.resolve("llm-agent");
    const claudeCodeRunner = registry.resolve("claude-code");
    const codexRunner = registry.resolve("codex");
    let serverHandle: { close: () => Promise<void> } | null = null;

    api.registerCli(
      ({ program }) => {
        const ripline = createRiplineCliProgram({
          defaults: {
            runsDir: cfg.runsDir,
            pipelinesDir: cfg.pipelinesDir,
          },
          ...(agentRunner !== undefined && { agentRunner }),
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
          ...(codexRunner !== undefined && { codexRunner }),
        });
        program.addCommand(ripline);
      },
      { commands: ["ripline"] },
    );

    api.registerService({
      id: "ripline.http",
      start: async () => {
        const options: StartServerOptions = {
          pipelinesDir: cfg.pipelinesDir,
          runsDir: cfg.runsDir,
          httpPort: cfg.httpPort,
          httpPath: cfg.httpPath,
          maxConcurrency: cfg.maxConcurrency,
          ...(cfg.authToken ? { authToken: cfg.authToken } : {}),
          ...(agentRunner !== undefined && { agentRunner }),
          ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
          ...(codexRunner !== undefined && { codexRunner }),
        };
        api.logger.info(
          `[pipeline] serving pipelines from ${options.pipelinesDir} (runs=${options.runsDir}) on port ${options.httpPort}`,
        );
        serverHandle = await startServer(options);
      },
      stop: async () => {
        if (!serverHandle) return;
        await serverHandle.close();
        serverHandle = null;
      },
    });
  },
};
