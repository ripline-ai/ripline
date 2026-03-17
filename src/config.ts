import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { RiplineUserConfig } from "./types.js";

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
    return result;
  } catch {
    return {};
  }
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
