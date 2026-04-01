import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { LlmAgentRunnerConfig } from "./llm-agent-runner.js";
import type { ClaudeCodeRunnerConfig } from "./claude-code-runner.js";
import type { CodexRunnerConfig } from "./codex-runner.js";
import { loadUserConfig } from "./config.js";
import { agentDefinitionSchema, skillsRegistrySchema } from "./schema.js";
import type { AgentDefinition, SkillsRegistry } from "./types.js";

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
 * Used by CLI when no external agent runner is provided.
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

const ENV_CLAUDE_CODE_MODE = "RIPLINE_CLAUDE_CODE_MODE";
const ENV_CLAUDE_CODE_CWD = "RIPLINE_CLAUDE_CODE_CWD";
const ENV_CLAUDE_CODE_MODEL = "RIPLINE_CLAUDE_CODE_MODEL";
const ENV_CLAUDE_CODE_MAX_TURNS = "RIPLINE_CLAUDE_CODE_MAX_TURNS";
const ENV_CLAUDE_CODE_TIMEOUT = "RIPLINE_CLAUDE_CODE_TIMEOUT";
const ENV_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS = "RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS";
const ENV_CODEX_MODE = "RIPLINE_CODEX_MODE";
const ENV_CODEX_CWD = "RIPLINE_CODEX_CWD";
const ENV_CODEX_MODEL = "RIPLINE_CODEX_MODEL";
const ENV_CODEX_TIMEOUT = "RIPLINE_CODEX_TIMEOUT";
const ENV_CODEX_DANGEROUSLY_SKIP_PERMISSIONS = "RIPLINE_CODEX_DANGEROUSLY_SKIP_PERMISSIONS";

function parseClaudeCodeMode(value: string): ClaudeCodeRunnerConfig["mode"] | null {
  const lower = value.toLowerCase();
  if (lower === "plan" || lower === "execute") return lower;
  return null;
}

/**
 * Extract Claude Code runner config from plugin config (claudeCode key).
 */
export function normalizeClaudeCodeConfigFromPlugin(raw: unknown): ClaudeCodeRunnerConfig | null {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const block = source.claudeCode as unknown;
  if (!block || typeof block !== "object") return null;

  const b = block as Record<string, unknown>;
  const modeRaw = typeof b.mode === "string" ? b.mode : undefined;
  const mode = modeRaw ? parseClaudeCodeMode(modeRaw) : "execute";
  if (!mode) return null;

  const config: ClaudeCodeRunnerConfig = { mode };
  if (typeof b.cwd === "string" && b.cwd.trim()) config.cwd = b.cwd.trim();
  if (typeof b.model === "string" && b.model.trim()) config.model = b.model.trim();
  if (Array.isArray(b.allowedTools)) config.allowedTools = b.allowedTools.filter((t): t is string => typeof t === "string");
  if (Array.isArray(b.disallowedTools)) config.disallowedTools = b.disallowedTools.filter((t): t is string => typeof t === "string");
  if (typeof b.maxTurns === "number" && b.maxTurns > 0) config.maxTurns = b.maxTurns;
  if (typeof b.timeoutSeconds === "number" && b.timeoutSeconds > 0) config.timeoutSeconds = b.timeoutSeconds;
  if (b.outputFormat === "json" || b.outputFormat === "text") config.outputFormat = b.outputFormat;
  return config;
}

/**
 * Resolve Claude Code config from environment variables.
 */
export function resolveClaudeCodeConfigFromEnv(
  env?: Record<string, string>
): ClaudeCodeRunnerConfig | null {
  const modeRaw = getEnv(env, ENV_CLAUDE_CODE_MODE);
  const mode = modeRaw ? parseClaudeCodeMode(modeRaw) : "execute";
  if (!mode) return null;

  const config: ClaudeCodeRunnerConfig = { mode };
  const cwd = getEnv(env, ENV_CLAUDE_CODE_CWD);
  if (cwd) config.cwd = cwd;
  const model = getEnv(env, ENV_CLAUDE_CODE_MODEL);
  if (model) config.model = model;
  if (getEnv(env, ENV_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS) === "true") {
    config.allowDangerouslySkipPermissions = true;
  }
  const maxTurnsRaw = getEnv(env, ENV_CLAUDE_CODE_MAX_TURNS);
  if (maxTurnsRaw) {
    const n = parseInt(maxTurnsRaw, 10);
    if (Number.isInteger(n) && n > 0) config.maxTurns = n;
  }
  const timeoutRaw = getEnv(env, ENV_CLAUDE_CODE_TIMEOUT);
  if (timeoutRaw) {
    const n = parseInt(timeoutRaw, 10);
    if (Number.isInteger(n) && n > 0) config.timeoutSeconds = n;
  }
  return config;
}

/**
 * Load Claude Code config from .ripline/agent.json or ripline.config.json (claudeCode key).
 */
export function loadClaudeCodeConfigFromFile(cwd: string): ClaudeCodeRunnerConfig | null {
  const tryFile = (filePath: string, getBlock: (data: Record<string, unknown>) => unknown) => {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as Record<string, unknown>;
      const block = getBlock(data);
      if (!block || typeof block !== "object") return null;
      return normalizeClaudeCodeConfigFromPlugin({ claudeCode: block });
    } catch {
      return null;
    }
  };

  const riplineAgent = path.join(cwd, ".ripline", "agent.json");
  if (fs.existsSync(riplineAgent)) {
    const cfg = tryFile(riplineAgent, (d) => d.claudeCode ?? d);
    if (cfg) return cfg;
  }

  const riplineConfig = path.join(cwd, "ripline.config.json");
  if (fs.existsSync(riplineConfig)) {
    const cfg = tryFile(riplineConfig, (d) => d.claudeCode);
    if (cfg) return cfg;
  }

  return null;
}

/**
 * Load named agent definitions from ripline.config.json (top-level `agents` key).
 * Returns null if file missing, unreadable, or has no agents section.
 */
export function loadAgentDefinitionsFromFile(cwd: string): Record<string, AgentDefinition> | null {
  const riplineConfig = path.join(cwd, "ripline.config.json");
  if (!fs.existsSync(riplineConfig)) return null;
  try {
    const content = fs.readFileSync(riplineConfig, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;
    if (!data.agents || typeof data.agents !== "object" || Array.isArray(data.agents)) return null;
    const raw = data.agents as Record<string, unknown>;
    const result: Record<string, AgentDefinition> = {};
    for (const [id, def] of Object.entries(raw)) {
      const parsed = agentDefinitionSchema.safeParse(def);
      if (parsed.success) result[id] = parsed.data as AgentDefinition;
    }
    return Object.keys(result).length > 0 ? result : null;
  } catch {
    return null;
  }
}

/**
 * Load named skills registry from ripline.config.json (top-level `skills` key).
 * Returns null if file missing, unreadable, or has no skills section.
 */
export function loadSkillsRegistryFromFile(cwd: string): SkillsRegistry | null {
  const riplineConfig = path.join(cwd, "ripline.config.json");
  if (!fs.existsSync(riplineConfig)) return null;
  try {
    const content = fs.readFileSync(riplineConfig, "utf-8");
    const data = JSON.parse(content) as Record<string, unknown>;
    if (!data.skills || typeof data.skills !== "object" || Array.isArray(data.skills)) return null;
    const parsed = skillsRegistrySchema.safeParse(data.skills);
    return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data as SkillsRegistry : null;
  } catch {
    return null;
  }
}

/**
 * Resolve Claude Code config: env + config file + user config (bypass flag only from env or ~/.ripline/config.json).
 */
export function resolveClaudeCodeConfig(options?: {
  cwd?: string;
  env?: Record<string, string>;
  homedir?: string;
}): ClaudeCodeRunnerConfig | null {
  const cwd = options?.cwd ?? process.cwd();
  const fromEnv = resolveClaudeCodeConfigFromEnv(options?.env);
  const fromFile = loadClaudeCodeConfigFromFile(cwd);
  const base = fromEnv ?? fromFile ?? null;
  if (!base) return null;
  const home = options?.homedir ?? os.homedir();
  const userConfig = loadUserConfig(home);
  const merged: ClaudeCodeRunnerConfig = { ...base };
  merged.allowDangerouslySkipPermissions =
    base.allowDangerouslySkipPermissions === true || userConfig.claudeCode?.allowDangerouslySkipPermissions === true;
  return merged;
}

function parseCodexMode(value: string): CodexRunnerConfig["mode"] | null {
  const lower = value.toLowerCase();
  if (lower === "plan" || lower === "execute") return lower;
  return null;
}

export function normalizeCodexConfigFromPlugin(raw: unknown): CodexRunnerConfig | null {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const block = source.codex as unknown;
  if (!block || typeof block !== "object") return null;

  const b = block as Record<string, unknown>;
  const modeRaw = typeof b.mode === "string" ? b.mode : undefined;
  const mode = modeRaw ? parseCodexMode(modeRaw) : "execute";
  if (!mode) return null;

  const config: CodexRunnerConfig = { mode };
  if (typeof b.cwd === "string" && b.cwd.trim()) config.cwd = b.cwd.trim();
  if (typeof b.model === "string" && b.model.trim()) config.model = b.model.trim();
  if (typeof b.timeoutSeconds === "number" && b.timeoutSeconds > 0) config.timeoutSeconds = b.timeoutSeconds;
  if (b.outputFormat === "json" || b.outputFormat === "text") config.outputFormat = b.outputFormat;
  return config;
}

export function resolveCodexConfigFromEnv(
  env?: Record<string, string>
): CodexRunnerConfig | null {
  const modeRaw = getEnv(env, ENV_CODEX_MODE);
  const mode = modeRaw ? parseCodexMode(modeRaw) : "execute";
  if (!mode) return null;

  const config: CodexRunnerConfig = { mode };
  const cwd = getEnv(env, ENV_CODEX_CWD);
  if (cwd) config.cwd = cwd;
  const model = getEnv(env, ENV_CODEX_MODEL);
  if (model) config.model = model;
  if (getEnv(env, ENV_CODEX_DANGEROUSLY_SKIP_PERMISSIONS) === "true") {
    config.allowDangerouslySkipPermissions = true;
  }
  const timeoutRaw = getEnv(env, ENV_CODEX_TIMEOUT);
  if (timeoutRaw) {
    const n = parseInt(timeoutRaw, 10);
    if (Number.isInteger(n) && n > 0) config.timeoutSeconds = n;
  }
  return config;
}

export function loadCodexConfigFromFile(cwd: string): CodexRunnerConfig | null {
  const tryFile = (filePath: string, getBlock: (data: Record<string, unknown>) => unknown) => {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) as Record<string, unknown>;
      const block = getBlock(data);
      if (!block || typeof block !== "object") return null;
      return normalizeCodexConfigFromPlugin({ codex: block });
    } catch {
      return null;
    }
  };

  const riplineAgent = path.join(cwd, ".ripline", "agent.json");
  if (fs.existsSync(riplineAgent)) {
    const cfg = tryFile(riplineAgent, (d) => d.codex ?? d);
    if (cfg) return cfg;
  }

  const riplineConfig = path.join(cwd, "ripline.config.json");
  if (fs.existsSync(riplineConfig)) {
    const cfg = tryFile(riplineConfig, (d) => d.codex);
    if (cfg) return cfg;
  }

  return null;
}

export function resolveCodexConfig(options?: {
  cwd?: string;
  env?: Record<string, string>;
  homedir?: string;
}): CodexRunnerConfig | null {
  const cwd = options?.cwd ?? process.cwd();
  const fromEnv = resolveCodexConfigFromEnv(options?.env);
  const fromFile = loadCodexConfigFromFile(cwd);
  const base = fromEnv ?? fromFile ?? null;
  if (!base) return null;
  const home = options?.homedir ?? os.homedir();
  const userConfig = loadUserConfig(home);
  const merged: CodexRunnerConfig = { ...base };
  merged.allowDangerouslySkipPermissions =
    base.allowDangerouslySkipPermissions === true || userConfig.codex?.allowDangerouslySkipPermissions === true;
  return merged;
}
