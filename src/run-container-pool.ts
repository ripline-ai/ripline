/**
 * RunContainerPool — manages run-level persistent containers.
 *
 * When a pipeline defines a run-level `container`, one container is started at the
 * beginning of the run.  All nodes that participate in container execution share that
 * single container, enabling file/artifact hand-off through the shared filesystem.
 *
 * Lifecycle:
 *   1. `acquire(runId, config)` — start (or return existing) container for the run.
 *   2. `exec(runId, command, env?)` — run a command inside the container via `docker exec`.
 *   3. `release(runId)` — stop and remove the container when the run finishes.
 *
 * Node-level `container: "isolated"` bypasses the pool entirely — those nodes use
 * ContainerManager directly to spawn fresh one-shot containers.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { createLogger, type Logger } from "./log.js";
import type { NodeContainerConfig } from "./types.js";

/* ── Types ──────────────────────────────────────────────────────────── */

export interface PoolContainerOptions {
  /** Docker image to use. */
  image: string;
  /** Environment variables to inject into the container. */
  env?: Record<string, string>;
  /** Volume mounts as host:container pairs. */
  volumes?: Record<string, string>;
  /** Working directory inside the container. */
  workdir?: string;
  /** Resource limits. */
  resourceLimits?: { cpus?: string; memory?: string };
  /** Log file path for container stdout/stderr. */
  logFile: string;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/* ── DEFAULT BUILD IMAGE ─────────────────────────────────────────────── */

export const DEFAULT_BUILD_IMAGE = "ghcr.io/craigjmidwinter/wintermute-build-env:latest";

/* ── RunContainerPool ───────────────────────────────────────────────── */

export class RunContainerPool {
  private readonly containers: Map<string, string> = new Map(); // runId → containerId
  private readonly logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? createLogger();
  }

  /**
   * Acquire a persistent container for a run.
   * If a container already exists for this runId, returns its ID.
   * Otherwise starts a new long-running container (sleeps indefinitely until stopped).
   */
  async acquire(runId: string, options: PoolContainerOptions): Promise<string> {
    const existing = this.containers.get(runId);
    if (existing) return existing;

    const { image, env, volumes, workdir = "/workspace", resourceLimits, logFile } = options;

    // Ensure log directory exists
    fs.mkdirSync(path.dirname(logFile), { recursive: true });

    // Build docker run args for a persistent (long-running) container.
    // We use `sleep infinity` as the command so the container stays alive for the run.
    const args: string[] = ["run", "--detach", "--network", "host"];

    const name = `ripline-run-${runId.slice(0, 8)}`;
    args.push("--name", name);

    if (workdir) {
      args.push("--workdir", workdir);
    }

    if (env) {
      for (const [key, value] of Object.entries(env)) {
        args.push("--env", `${key}=${value}`);
      }
    }

    if (volumes) {
      for (const [hostPath, containerPath] of Object.entries(volumes)) {
        args.push("--volume", `${hostPath}:${containerPath}`);
      }
    }

    if (resourceLimits?.cpus) {
      args.push("--cpus", resourceLimits.cpus);
    }
    if (resourceLimits?.memory) {
      args.push("--memory", resourceLimits.memory);
    }

    args.push(image);
    // Keep the container alive indefinitely; steps exec into it
    args.push("sleep", "infinity");

    this.logger.log("info", `[run-container-pool] Starting container for run ${runId}: docker ${args.join(" ")}`);

    const containerId = await new Promise<string>((resolve, reject) => {
      execFile("docker", args, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`docker run failed: ${stderr || err.message}`));
          return;
        }
        const id = stdout.trim().slice(0, 12);
        if (!id) {
          reject(new Error(`docker run returned no container ID. stderr: ${stderr}`));
          return;
        }
        resolve(id);
      });
    });

    this.containers.set(runId, containerId);
    this.logger.log("info", `[run-container-pool] Container ${containerId} started for run ${runId}`);
    return containerId;
  }

  /**
   * Execute a command inside the persistent container for a run.
   * Returns the exit code, stdout, and stderr.
   */
  async exec(
    runId: string,
    command: string[],
    env?: Record<string, string>,
    workdir?: string,
  ): Promise<ExecResult> {
    const containerId = this.containers.get(runId);
    if (!containerId) {
      throw new Error(`No container found for run ${runId} — call acquire() first`);
    }

    const args: string[] = ["exec"];
    if (workdir) {
      args.push("--workdir", workdir);
    }
    if (env) {
      for (const [key, value] of Object.entries(env)) {
        args.push("--env", `${key}=${value}`);
      }
    }
    args.push(containerId);
    args.push(...command);

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      const proc = spawn("docker", args, {
        stdio: ["ignore", "pipe", "pipe"],
      });

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

      proc.on("close", (code: number | null) => {
        resolve({ exitCode: code ?? 1, stdout, stderr });
      });

      proc.on("error", (err: Error) => {
        resolve({ exitCode: 1, stdout, stderr: stderr + err.message });
      });
    });
  }

  /**
   * Release (stop and remove) the persistent container for a run.
   * Safe to call multiple times.
   */
  release(runId: string): void {
    const containerId = this.containers.get(runId);
    if (!containerId) return;

    this.containers.delete(runId);
    try {
      execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
      this.logger.log("info", `[run-container-pool] Container ${containerId} removed for run ${runId}`);
    } catch {
      this.logger.log("warn", `[run-container-pool] Failed to remove container ${containerId} for run ${runId}`);
    }
  }

  /**
   * Release all containers (used during graceful shutdown).
   */
  releaseAll(): void {
    for (const runId of [...this.containers.keys()]) {
      this.release(runId);
    }
  }

  /**
   * Get the container ID for a run (undefined if none).
   */
  getContainerId(runId: string): string | undefined {
    return this.containers.get(runId);
  }

  /**
   * Check if a container is active for a run.
   */
  hasContainer(runId: string): boolean {
    return this.containers.has(runId);
  }
}

/* ── Singleton for process-level pool ───────────────────────────────── */

let _globalPool: RunContainerPool | null = null;

export function getGlobalContainerPool(logger?: Logger): RunContainerPool {
  if (!_globalPool) {
    _globalPool = new RunContainerPool(logger);
  }
  return _globalPool;
}

/** Reset the global pool (for testing). */
export function resetGlobalContainerPool(): void {
  if (_globalPool) {
    _globalPool.releaseAll();
    _globalPool = null;
  }
}

/* ── Helpers ─────────────────────────────────────────────────────────── */

/**
 * Resolve the effective container image from a NodeContainerConfig.
 * Falls back to DEFAULT_BUILD_IMAGE if not specified.
 */
export function resolveContainerImage(config: NodeContainerConfig, defaultImage?: string): string {
  if (config === "isolated") return defaultImage ?? DEFAULT_BUILD_IMAGE;
  return config.image ?? defaultImage ?? DEFAULT_BUILD_IMAGE;
}

/**
 * Resolve a NodeContainerConfig into a normalized object form.
 * "isolated" expands to default object with the given image.
 */
export function normalizeContainerConfig(
  config: NodeContainerConfig,
  defaults?: { image?: string; env?: Record<string, string>; volumes?: Record<string, string>; workdir?: string },
): Exclude<NodeContainerConfig, "isolated"> {
  if (config === "isolated") {
    const result: Exclude<NodeContainerConfig, "isolated"> = {
      image: defaults?.image ?? DEFAULT_BUILD_IMAGE,
      workdir: defaults?.workdir ?? "/workspace",
    };
    if (defaults?.env !== undefined) result.env = defaults.env;
    if (defaults?.volumes !== undefined) result.volumes = defaults.volumes;
    return result;
  }
  const mergedEnv: Record<string, string> = { ...defaults?.env, ...config.env };
  const mergedVolumes: Record<string, string> = { ...defaults?.volumes, ...config.volumes };
  const result: Exclude<NodeContainerConfig, "isolated"> = {
    image: config.image ?? defaults?.image ?? DEFAULT_BUILD_IMAGE,
    workdir: config.workdir ?? defaults?.workdir ?? "/workspace",
  };
  if (Object.keys(mergedEnv).length > 0) result.env = mergedEnv;
  if (Object.keys(mergedVolumes).length > 0) result.volumes = mergedVolumes;
  if (config.timeoutMs !== undefined) result.timeoutMs = config.timeoutMs;
  if (config.resourceLimits !== undefined) result.resourceLimits = config.resourceLimits;
  return result;
}
