/**
 * containerManager — wraps Docker container lifecycle operations.
 *
 * Provides: spawn container with image/env/volumes, stream logs to file,
 * poll for exit, cleanup completed containers, and TTL-based cleanup for
 * failed containers.
 *
 * Uses Docker CLI subprocess (no external deps required).
 */

import { spawn, execFileSync, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createLogger, type Logger } from "./log.js";

/* ── Types ──────────────────────────────────────────────────────────── */

export interface ContainerSpawnOptions {
  /** Docker image to run (e.g. "node:20-slim"). */
  image: string;
  /** Command + args to run inside the container. If omitted, uses image default. */
  command?: string[];
  /** Environment variables to pass into the container. */
  env?: Record<string, string>;
  /** Volume mounts as host:container pairs (e.g. { "/host/path": "/container/path" }). */
  volumes?: Record<string, string>;
  /** Working directory inside the container. */
  workdir?: string;
  /** Absolute path on host where stdout/stderr will be streamed. */
  logFile: string;
  /** Optional container name (must be unique). Auto-generated if omitted. */
  name?: string;
  /** Timeout in milliseconds. Container is killed if it exceeds this. 0 = no timeout. */
  timeoutMs?: number;
  /** Resource limits (CPU, memory) applied to the container. */
  resourceLimits?: { cpus?: string; memory?: string };
}

export interface ContainerResult {
  /** Docker container ID (short hash). */
  containerId: string;
  /** Process exit code. null if killed or timed out. */
  exitCode: number | null;
  /** Whether the container timed out. */
  timedOut: boolean;
  /** Absolute path to the log file on host. */
  logFile: string;
}

export interface ContainerManagerConfig {
  /** How long (ms) to retain failed containers before removing them. Default: 30 minutes. */
  failedContainerTTL?: number;
  /** Logger instance. */
  logger?: Logger;
}

/* ── Internal bookkeeping for TTL-based cleanup ─────────────────────── */

interface FailedContainerEntry {
  containerId: string;
  failedAt: number; // Date.now() when failure was recorded
}

/* ── ContainerManager ───────────────────────────────────────────────── */

export class ContainerManager {
  private readonly failedContainerTTL: number;
  private readonly logger: Logger;
  private readonly failedContainers: FailedContainerEntry[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: ContainerManagerConfig = {}) {
    this.failedContainerTTL = config.failedContainerTTL ?? 30 * 60 * 1000;
    this.logger = config.logger ?? createLogger();
    this.startCleanupLoop();
  }

  /* ── Public API ─────────────────────────────────────────────────── */

  /**
   * Spawn a Docker container, stream its stdout/stderr to a log file,
   * wait for it to exit, and handle cleanup.
   */
  async spawn(options: ContainerSpawnOptions): Promise<ContainerResult> {
    const {
      image,
      command,
      env,
      volumes,
      workdir,
      logFile,
      name,
      timeoutMs = 0,
      resourceLimits,
    } = options;

    // Ensure log directory exists
    fs.mkdirSync(path.dirname(logFile), { recursive: true });

    // Build docker run args
    const args = this.buildRunArgs({
      image,
      ...(command !== undefined && { command }),
      ...(env !== undefined && { env }),
      ...(volumes !== undefined && { volumes }),
      ...(workdir !== undefined && { workdir }),
      ...(name !== undefined && { name }),
      ...(resourceLimits !== undefined && { resourceLimits }),
    });

    this.logger.log("info", `Spawning container: docker run ${args.join(" ")}`);

    const result = await this.runContainer(args, logFile, timeoutMs);

    // Cleanup logic
    if (result.exitCode === 0) {
      this.removeContainer(result.containerId);
      this.logger.log("info", `Container ${result.containerId} completed successfully and removed`);
    } else {
      this.logger.log("warn", `Container ${result.containerId} failed (exit=${result.exitCode}, timedOut=${result.timedOut})`);
      this.scheduleFailedCleanup(result.containerId);
    }

    return result;
  }

  /**
   * Forcibly remove a container by ID.
   */
  removeContainer(containerId: string): void {
    try {
      execFileSync("docker", ["rm", "-f", containerId], { stdio: "ignore" });
    } catch {
      // Best-effort removal
      this.logger.log("warn", `Failed to remove container ${containerId}`);
    }
  }

  /**
   * Stop the background cleanup timer. Call when shutting down.
   */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Immediately run TTL-based cleanup of failed containers.
   * Exposed for testing purposes.
   */
  cleanupExpiredContainers(): void {
    const now = Date.now();
    const expired: string[] = [];

    for (let i = this.failedContainers.length - 1; i >= 0; i--) {
      const entry = this.failedContainers[i]!;
      if (now - entry.failedAt >= this.failedContainerTTL) {
        expired.push(entry.containerId);
        this.failedContainers.splice(i, 1);
      }
    }

    for (const id of expired) {
      this.logger.log("info", `TTL expired for failed container ${id}, removing`);
      this.removeContainer(id);
    }
  }

  /**
   * Get the list of currently tracked failed containers (for testing/diagnostics).
   */
  get trackedFailedContainers(): ReadonlyArray<{ containerId: string; failedAt: number }> {
    return [...this.failedContainers];
  }

  /* ── Private helpers ────────────────────────────────────────────── */

  private buildRunArgs(opts: {
    image: string;
    command?: string[];
    env?: Record<string, string>;
    volumes?: Record<string, string>;
    workdir?: string;
    name?: string;
    resourceLimits?: { cpus?: string; memory?: string };
  }): string[] {
    const args: string[] = ["run", "--detach", "--network", "host"];

    if (opts.name) {
      args.push("--name", opts.name);
    }

    if (opts.workdir) {
      args.push("--workdir", opts.workdir);
    }

    if (opts.env) {
      for (const [key, value] of Object.entries(opts.env)) {
        args.push("--env", `${key}=${value}`);
      }
    }

    if (opts.volumes) {
      for (const [hostPath, containerPath] of Object.entries(opts.volumes)) {
        args.push("--volume", `${hostPath}:${containerPath}`);
      }
    }

    // Apply resource limits (CPU and memory)
    if (opts.resourceLimits) {
      if (opts.resourceLimits.cpus) {
        args.push("--cpus", opts.resourceLimits.cpus);
      }
      if (opts.resourceLimits.memory) {
        args.push("--memory", opts.resourceLimits.memory);
      }
    }

    args.push(opts.image);

    if (opts.command && opts.command.length > 0) {
      args.push(...opts.command);
    }

    return args;
  }

  /**
   * Run a detached container, stream its logs to a file, and poll for exit.
   */
  private async runContainer(
    dockerRunArgs: string[],
    logFile: string,
    timeoutMs: number,
  ): Promise<ContainerResult> {
    // Start container (detached) — returns container ID
    const containerId = await this.dockerCreate(dockerRunArgs);

    // Start streaming logs to file
    const logStream = this.streamLogs(containerId, logFile);

    // Poll for exit (or timeout)
    const { exitCode, timedOut } = await this.waitForExit(containerId, timeoutMs);

    // Give log stream a moment to flush, then clean up
    await new Promise((r) => setTimeout(r, 500));
    logStream.kill();

    return { containerId, exitCode, timedOut, logFile };
  }

  /**
   * Run `docker run --detach ...` and return the container ID.
   */
  private dockerCreate(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile("docker", args, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`docker run failed: ${stderr || err.message}`));
          return;
        }
        const containerId = stdout.trim().slice(0, 12);
        if (!containerId) {
          reject(new Error(`docker run returned no container ID. stderr: ${stderr}`));
          return;
        }
        resolve(containerId);
      });
    });
  }

  /**
   * Spawn `docker logs -f <id>` and pipe stdout/stderr to logFile.
   * Returns the child process so caller can kill it when done.
   */
  private streamLogs(
    containerId: string,
    logFile: string,
  ): ReturnType<typeof spawn> {
    const logFd = fs.openSync(logFile, "a");
    const proc = spawn("docker", ["logs", "-f", containerId], {
      stdio: ["ignore", logFd, logFd],
    });

    proc.on("error", () => {
      // best-effort; container may already be gone
    });

    proc.on("exit", () => {
      try {
        fs.closeSync(logFd);
      } catch {
        // ignore
      }
    });

    return proc;
  }

  /**
   * Poll `docker wait <id>` for the container's exit code.
   * If timeoutMs > 0, kills the container after the timeout.
   */
  private waitForExit(
    containerId: string,
    timeoutMs: number,
  ): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolve) => {
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const waitProc = execFile(
        "docker",
        ["wait", containerId],
        (err, stdout) => {
          if (timer) clearTimeout(timer);

          if (timedOut) {
            resolve({ exitCode: null, timedOut: true });
            return;
          }

          if (err) {
            resolve({ exitCode: null, timedOut: false });
            return;
          }

          const code = parseInt(stdout.trim(), 10);
          resolve({ exitCode: Number.isNaN(code) ? null : code, timedOut: false });
        },
      );

      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          // Kill the container
          try {
            execFileSync("docker", ["kill", containerId], { stdio: "ignore" });
          } catch {
            // may already be exited
          }
          waitProc.kill();
        }, timeoutMs);
      }
    });
  }

  private scheduleFailedCleanup(containerId: string): void {
    this.failedContainers.push({ containerId, failedAt: Date.now() });
  }

  private startCleanupLoop(): void {
    // Check every 60 seconds for expired failed containers
    const intervalMs = Math.min(this.failedContainerTTL, 60_000);
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredContainers();
    }, intervalMs);

    // Don't prevent process exit
    if (this.cleanupTimer && typeof this.cleanupTimer === "object" && "unref" in this.cleanupTimer) {
      this.cleanupTimer.unref();
    }
  }
}
