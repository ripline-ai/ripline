import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RiplineUserConfig, QueueConfig, ContainerBuildUserConfig } from "./types.js";
import { queuesConfigSchema } from "./schema.js";

/* ── Stage-aware configuration ──────────────────────────────────────── */

export type Stage = "production" | "staging";

export interface StageConfig {
  /** The stage name (production or staging). */
  stage: Stage;
  /** HTTP port for Ripline to listen on. */
  port: number;
  /** Wintermute base URL (no trailing slash). */
  wintermuteBaseUrl: string;
}

const STAGE_MAP: Record<Stage, { port: number; wintermuteBaseUrl: string }> = {
  production: { port: 4001, wintermuteBaseUrl: "http://localhost:3000" },
  staging:    { port: 4002, wintermuteBaseUrl: "http://localhost:3001" },
};

/**
 * Resolve port and wintermuteBaseUrl from the STAGE environment variable.
 * Accepted values: "production", "staging". Unset or unrecognised defaults to production.
 */
export function resolveStageConfig(env?: Record<string, string | undefined>): StageConfig {
  const raw = (env ?? process.env).STAGE;
  const stage: Stage = raw === "staging" ? "staging" : "production";
  return { stage, ...STAGE_MAP[stage] };
}

/**
 * Expand leading ~ to homedir. Other occurrences of ~ are left unchanged.
 */
export function expandTilde(p: string, homedir: string): string {
  if (p === "~") return homedir;
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(homedir, p.slice(2));
  }
  return p;
}

/**
 * Load user config from ~/.ripline/config.json.
 * Returns {} when file is missing or invalid. Expands ~ in path values.
 */
export function loadUserConfig(homedir?: string): RiplineUserConfig {
  const home = homedir ?? os.homedir();
  const configPath = path.join(home, ".ripline", "config.json");
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const result: RiplineUserConfig = {};
    if (typeof parsed.pipelineDir === "string") {
      result.pipelineDir = expandTilde(parsed.pipelineDir.trim(), home);
    }
    if (typeof parsed.profileDir === "string") {
      result.profileDir = expandTilde(parsed.profileDir.trim(), home);
    }
    if (typeof parsed.skillsDir === "string") {
      result.skillsDir = expandTilde(parsed.skillsDir.trim(), home);
    }
    if (typeof parsed.defaultProfile === "string") {
      const v = parsed.defaultProfile.trim();
      if (v) result.defaultProfile = v;
    }
    const claudeBlock = parsed.claudeCode;
    if (claudeBlock && typeof claudeBlock === "object" && (claudeBlock as Record<string, unknown>).allowDangerouslySkipPermissions === true) {
      result.claudeCode = { allowDangerouslySkipPermissions: true };
    }

    // Background queue config (defaults: enabled=false, maxRetries=3)
    const bgBlock = parsed.backgroundQueue;
    if (bgBlock && typeof bgBlock === "object") {
      const bg = bgBlock as Record<string, unknown>;
      result.backgroundQueue = {
        enabled: bg.enabled === true,
        maxRetries: typeof bg.maxRetries === "number" ? bg.maxRetries : 3,
      };
    }

    // Telegram config
    const tgBlock = parsed.telegram;
    if (tgBlock && typeof tgBlock === "object") {
      const tg = tgBlock as Record<string, unknown>;
      if (typeof tg.botToken === "string" && typeof tg.chatId === "string") {
        result.telegram = {
          botToken: tg.botToken,
          chatId: tg.chatId,
        };
      }
    }

    // Container build configuration
    const cbBlock = parsed.containerBuild;
    if (cbBlock && typeof cbBlock === "object" && !Array.isArray(cbBlock)) {
      const cb = cbBlock as Record<string, unknown>;
      const containerBuild: ContainerBuildUserConfig = {};
      if (cb.enabled === true) containerBuild.enabled = true;
      if (typeof cb.repoPath === "string") containerBuild.repoPath = expandTilde(cb.repoPath.trim(), home);
      if (typeof cb.targetBranch === "string") containerBuild.targetBranch = cb.targetBranch.trim();
      if (typeof cb.buildImage === "string") containerBuild.buildImage = cb.buildImage.trim();
      if (typeof cb.testCommand === "string") containerBuild.testCommand = cb.testCommand.trim();
      if (typeof cb.secretsMountPath === "string") containerBuild.secretsMountPath = expandTilde(cb.secretsMountPath.trim(), home);
      if (typeof cb.containerTimeoutMs === "number") containerBuild.containerTimeoutMs = cb.containerTimeoutMs;
      result.containerBuild = containerBuild;
    }

    // Per-queue configuration (concurrency + resource limits)
    // Validate with Zod schema; fall back to manual parsing on validation failure.
    const queuesBlock = parsed.queues;
    if (queuesBlock && typeof queuesBlock === "object" && !Array.isArray(queuesBlock)) {
      const zodResult = queuesConfigSchema.safeParse(queuesBlock);
      if (zodResult.success) {
        const queues: Record<string, QueueConfig> = {};
        for (const [name, qc] of Object.entries(zodResult.data)) {
          const entry: QueueConfig = { concurrency: qc.concurrency };
          if (qc.resourceLimits) {
            const limits: { cpus?: string; memory?: string } = {};
            if (qc.resourceLimits.cpus) limits.cpus = qc.resourceLimits.cpus;
            if (qc.resourceLimits.memory) limits.memory = qc.resourceLimits.memory;
            if (Object.keys(limits).length > 0) entry.resourceLimits = limits;
          }
          queues[name] = entry;
        }
        if (Object.keys(queues).length > 0) {
          result.queues = queues;
        }
      } else {
        // Schema validation failed — log warning and fall back to manual parsing
        console.warn(`[config] queues config validation warning: ${zodResult.error.issues.map((i) => i.message).join("; ")}. Falling back to manual parsing.`);
        const queues: Record<string, QueueConfig> = {};
        for (const [name, raw] of Object.entries(queuesBlock as Record<string, unknown>)) {
          if (raw && typeof raw === "object" && !Array.isArray(raw)) {
            const q = raw as Record<string, unknown>;
            const concurrency = typeof q.concurrency === "number" ? Math.max(1, q.concurrency) : 1;
            const qc: QueueConfig = { concurrency };
            if (q.resourceLimits && typeof q.resourceLimits === "object" && !Array.isArray(q.resourceLimits)) {
              const rl = q.resourceLimits as Record<string, unknown>;
              const limits: { cpus?: string; memory?: string } = {};
              if (typeof rl.cpus === "string") limits.cpus = rl.cpus;
              if (typeof rl.memory === "string") limits.memory = rl.memory;
              if (Object.keys(limits).length > 0) qc.resourceLimits = limits;
            }
            queues[name] = qc;
          }
        }
        if (Object.keys(queues).length > 0) {
          result.queues = queues;
        }
      }
    }

    return result;
  } catch {
    return {};
  }
}

/** Default queue configuration: concurrency 1, no resource limits. */
const DEFAULT_QUEUE_CONFIG: QueueConfig = { concurrency: 1 };

/**
 * Retrieve the effective queue config for a given queue name.
 * Falls back to default (concurrency 1, no resource limits) if not configured.
 */
export function getQueueConfig(queueName: string, homedir?: string): QueueConfig {
  const userConfig = loadUserConfig(homedir);
  return userConfig.queues?.[queueName] ?? DEFAULT_QUEUE_CONFIG;
}

/**
 * Resolve pipeline directory in order: flag > user config pipelineDir >
 * ripline.config.json in cwd pipelineDir > default ~/.ripline/pipelines.
 */
export function resolvePipelineDir(options?: {
  flag?: string;
  cwd?: string;
  homedir?: string;
}): string {
  const home = options?.homedir ?? os.homedir();
  const cwd = options?.cwd ?? process.cwd();

  if (options?.flag?.trim()) {
    const p = options.flag.trim();
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
  }

  const userConfig = loadUserConfig(home);
  if (userConfig.pipelineDir) {
    return path.isAbsolute(userConfig.pipelineDir)
      ? path.resolve(userConfig.pipelineDir)
      : path.resolve(home, userConfig.pipelineDir);
  }

  const localConfigPath = path.join(cwd, "ripline.config.json");
  try {
    const raw = fs.readFileSync(localConfigPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed.pipelineDir === "string" && parsed.pipelineDir.trim()) {
      const p = parsed.pipelineDir.trim();
      return path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
    }
  } catch {
    // ignore missing or invalid local config
  }

  return path.join(home, ".ripline", "pipelines");
}

/**
 * Resolve skills directory in order: flag > user config skillsDir >
 * default ~/.ripline/skills.
 */
export function resolveSkillsDir(options?: {
  flag?: string;
  homedir?: string;
}): string {
  const home = options?.homedir ?? os.homedir();

  if (options?.flag?.trim()) {
    const p = options.flag.trim();
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p);
  }

  const userConfig = loadUserConfig(home);
  if (userConfig.skillsDir) {
    return path.isAbsolute(userConfig.skillsDir)
      ? path.resolve(userConfig.skillsDir)
      : path.resolve(home, userConfig.skillsDir);
  }

  return path.join(home, ".ripline", "skills");
}

/**
 * Resolve profile directory in order: flag > user config profileDir >
 * default ~/.ripline/profiles.
 */
export function resolveProfileDir(options?: {
  flag?: string;
  homedir?: string;
}): string {
  const home = options?.homedir ?? os.homedir();

  if (options?.flag?.trim()) {
    const p = options.flag.trim();
    return path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p);
  }

  const userConfig = loadUserConfig(home);
  if (userConfig.profileDir) {
    return path.isAbsolute(userConfig.profileDir)
      ? path.resolve(userConfig.profileDir)
      : path.resolve(home, userConfig.profileDir);
  }

  return path.join(home, ".ripline", "profiles");
}
