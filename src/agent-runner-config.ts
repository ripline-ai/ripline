import fs from "node:fs";
import path from "node:path";
import type { LlmAgentRunnerConfig } from "./llm-agent-runner.js";

const ENV_PROVIDER = "RIPLINE_AGENT_PROVIDER";
const ENV_MODEL = "RIPLINE_AGENT_MODEL";
const ENV_BASE_URL = "RIPLINE_AGENT_BASE_URL";
const ENV_OPENAI_KEY = "OPENAI_API_KEY";
const ENV_ANTHROPIC_KEY = "ANTHROPIC_API_KEY";

const VALID_PROVIDERS = ["ollama", "openai", "anthropic"] as const;

function getEnv(env: Record<string, string> | undefined, key: string): string | undefined {
  const source = env ?? (typeof process !== "undefined" && process.env ? process.env as Record<string, string> : {});
  const v = source[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function parseProvider(value: string): LlmAgentRunnerConfig["provider"] | null {
  const lower = value.toLowerCase();
  if (VALID_PROVIDERS.includes(lower as LlmAgentRunnerConfig["provider"])) {
    return lower as LlmAgentRunnerConfig["provider"];
  }
  return null;
}

/**
 * Extract and validate LLM agent config from plugin config (agentRunner or agent key).
 * Fills apiKey from OPENAI_API_KEY / ANTHROPIC_API_KEY when not set.
 */
export function normalizeLlmAgentConfigFromPlugin(
  raw: unknown,
  env?: Record<string, string>
): LlmAgentRunnerConfig | null {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const block = (source.agentRunner ?? source.agent) as unknown;
  if (!block || typeof block !== "object") return null;

  const b = block as Record<string, unknown>;
  const providerRaw = typeof b.provider === "string" ? b.provider : undefined;
  const model = typeof b.model === "string" && b.model.trim() ? b.model.trim() : undefined;
  if (!providerRaw || !model) return null;

  const provider = parseProvider(providerRaw);
  if (!provider) return null;

  let apiKey = typeof b.apiKey === "string" && b.apiKey.trim() ? b.apiKey.trim() : undefined;
  if (!apiKey && provider === "openai") apiKey = getEnv(env, ENV_OPENAI_KEY);
  if (!apiKey && provider === "anthropic") apiKey = getEnv(env, ENV_ANTHROPIC_KEY);

  const baseURL = typeof b.baseURL === "string" && b.baseURL.trim() ? b.baseURL.trim() : undefined;

  const config: LlmAgentRunnerConfig = { provider, model };
  if (apiKey) config.apiKey = apiKey;
  if (baseURL) config.baseURL = baseURL;
  return config;
}

/**
 * Resolve LLM agent config from environment variables.
 * Requires RIPLINE_AGENT_PROVIDER and RIPLINE_AGENT_MODEL.
 */
export function resolveLlmAgentConfigFromEnv(
  env?: Record<string, string>
): LlmAgentRunnerConfig | null {
  const providerRaw = getEnv(env, ENV_PROVIDER);
  const model = getEnv(env, ENV_MODEL);
  if (!providerRaw || !model) return null;

  const provider = parseProvider(providerRaw);
  if (!provider) return null;

  let apiKey: string | undefined;
  if (provider === "openai") apiKey = getEnv(env, ENV_OPENAI_KEY);
  else if (provider === "anthropic") apiKey = getEnv(env, ENV_ANTHROPIC_KEY);

  const baseURL = getEnv(env, ENV_BASE_URL);

  const config: LlmAgentRunnerConfig = { provider, model };
  if (apiKey) config.apiKey = apiKey;
  if (baseURL) config.baseURL = baseURL;
  return config;
}

/**
 * Load LLM agent config from .ripline/agent.json or ripline.config.json (agent section).
 * Returns null if file missing or invalid.
 */
export function loadLlmAgentConfigFromFile(cwd: string): LlmAgentRunnerConfig | null {
  const tryFile = (filePath: string, getBlock: (data: Record<string, unknown>) => unknown) => {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as Record<string, unknown>;
      const block = getBlock(data);
      if (!block || typeof block !== "object") return null;
      return normalizeLlmAgentConfigFromPlugin({ agentRunner: block });
    } catch {
      return null;
    }
  };

  const riplineAgent = path.join(cwd, ".ripline", "agent.json");
  if (fs.existsSync(riplineAgent)) {
    const cfg = tryFile(riplineAgent, (d) => d);
    if (cfg) return cfg;
  }

  const riplineConfig = path.join(cwd, "ripline.config.json");
  if (fs.existsSync(riplineConfig)) {
    const cfg = tryFile(riplineConfig, (d) => d.agent ?? d.agentRunner);
    if (cfg) return cfg;
  }

  return null;
}

/**
 * Resolve standalone LLM agent config: overrides (e.g. CLI) > env > config file.
 * Used by CLI when no OpenClaw runner is provided.
 */
export function resolveStandaloneLlmAgentConfig(options?: {
  cwd?: string;
  overrides?: Partial<LlmAgentRunnerConfig>;
  env?: Record<string, string>;
}): LlmAgentRunnerConfig | null {
  const cwd = options?.cwd ?? process.cwd();
  const env = options?.env;
  const overrides = options?.overrides;

  const fromEnv = resolveLlmAgentConfigFromEnv(env);
  const fromFile = loadLlmAgentConfigFromFile(cwd);

  const base = fromEnv ?? fromFile ?? null;
  if (!base) return null;

  const merged: LlmAgentRunnerConfig = {
    provider: overrides?.provider ?? base.provider,
    model: overrides?.model ?? base.model,
  };
  const apiKey = overrides?.apiKey ?? base.apiKey;
  if (apiKey !== undefined) merged.apiKey = apiKey;
  const baseURL = overrides?.baseURL ?? base.baseURL;
  if (baseURL !== undefined) merged.baseURL = baseURL;

  return merged;
}
