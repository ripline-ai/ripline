import { spawnSync } from "child_process";
import os from "os";
import type { ExecNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

/**
 * Interpolate {{varName}} placeholders from an artifact map.
 */
function interpolate(template: string, artifacts: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const val = artifacts[key];
    return val !== undefined ? String(val) : _match;
  });
}

/**
 * Execute a shell command node.
 *
 * - Interpolates {{varName}} in `command` and `cwd` from context.artifacts.
 * - Runs via spawnSync with shell: true.
 * - On non-zero exit, throws with stderr content.
 * - Captures stdout as the node artifact (keyed by node.id) when captureOutput
 *   is true (the default).
 */
export async function executeExecNode(
  node: ExecNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const command = interpolate(node.command, context.artifacts);
  const cwd = node.cwd ? interpolate(node.cwd, context.artifacts) : undefined;
  const captureOutput = node.captureOutput !== false;

  const defaultShell = os.platform() === "win32" ? "cmd.exe" : "/bin/sh";
  const shell = node.shell ?? defaultShell;

  const mergedEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...context.env,
    ...(node.env ?? {}),
  };

  const result = spawnSync(command, {
    shell,
    cwd,
    env: mergedEnv,
    encoding: "utf-8",
    timeout: 120_000,
  });

  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").trim();
    const stdout = (result.stdout ?? "").trim();
    const detail = stderr || stdout || `exit code ${result.status}`;
    throw new Error(
      `exec node "${node.id}" failed (exit ${result.status}): ${detail}`
    );
  }

  const stdout = (result.stdout ?? "").trim();
  const value = captureOutput ? stdout : null;

  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
