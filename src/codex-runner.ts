import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentResult, AgentRunner } from "./pipeline/executors/agent.js";
import { extractLastJson, stripAnsi } from "./stdout-parser.js";
import { normalizeContainerConfig, DEFAULT_BUILD_IMAGE } from "./run-container-pool.js";

const DEFAULT_TIMEOUT_SECONDS = 300;

export interface CodexRunnerConfig {
  mode: "plan" | "execute";
  cwd?: string;
  model?: string;
  timeoutSeconds?: number;
  outputFormat?: "text" | "json";
  allowDangerouslySkipPermissions?: boolean;
}

function validateCwd(cwd: string): string {
  const segments = cwd.split(path.sep).filter(Boolean);
  if (segments.some((seg) => seg === "..")) {
    throw new Error(`Codex runner: cwd must not contain parent directory reference ".." (got: ${cwd})`);
  }
  const resolved = path.resolve(cwd);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Codex runner: cwd must be an existing directory (got: ${resolved})`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Codex runner: cwd does not exist (got: ${resolved})`);
    }
    throw err;
  }
  return resolved;
}

function parseOutput(raw: string, outputFormat: "text" | "json"): string {
  const cleaned = stripAnsi(raw);
  if (outputFormat === "text") return cleaned;
  const extracted = extractLastJson(cleaned);
  const text = extracted ?? cleaned.trim();
  try {
    JSON.parse(text);
  } catch {
    throw new Error(
      `Codex runner: outputFormat is "json" but response was not valid JSON: ${text.slice(0, 200)}`
    );
  }
  return text;
}

function logChunk(
  raw: string,
  log: { log: (level: "info" | "error", message: string) => void } | undefined,
  level: "info" | "error"
): void {
  if (!log) return;
  const lines = stripAnsi(raw)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  for (const line of lines) {
    log.log(level, line);
  }
}

function summarizeCommandFailure(stdout: string, stderr: string): string {
  const combined = stripAnsi(`${stderr}\n${stdout}`)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  const tail = combined.slice(-12).join("\n").trim();
  if (tail) return tail.slice(0, 2000);
  const fallback = stripAnsi(stderr || stdout).trim();
  return fallback.slice(0, 2000);
}

export function createCodexRunner(config: CodexRunnerConfig): AgentRunner {
  const defaultMode = config.mode;
  const defaultCwd = config.cwd;
  const defaultTimeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const outputFormat = config.outputFormat ?? "text";

  return async (params): Promise<AgentResult> => {
    if (params.containerContext) {
      return runCodexInContainer(params, outputFormat);
    }

    const mode = params.mode ?? defaultMode;
    const rawCwd = params.cwd ?? defaultCwd ?? process.cwd();
    const cwd = validateCwd(rawCwd);
    const modelRaw = params.model ?? config.model;
    const model = typeof modelRaw === "string" && modelRaw.trim() !== "" ? modelRaw.trim() : undefined;
    const timeoutMs = (params.timeoutSeconds ?? defaultTimeout) * 1000;
    const bypassActive =
      config.allowDangerouslySkipPermissions === true && params.dangerouslySkipPermissions === true;

    if (process.env.RIPLINE_LOG_CONFIG === "1") {
      const msg = `[codex-runner] timeoutMs=${timeoutMs} mode=${mode} cwd=${cwd}`;
      if (params.log) params.log.log("error", msg);
      else console.error(msg);
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ripline-codex-"));
    const outputPath = path.join(tempDir, "last-message.txt");
    const args = [
      ...(bypassActive ? [] : ["-a", "never"]),
      "exec",
      ...(bypassActive ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", mode === "plan" ? "read-only" : "workspace-write"]),
      "--skip-git-repo-check",
      "--color",
      "never",
      "--output-last-message",
      outputPath,
      "-C",
      cwd,
      ...(model !== undefined ? ["--model", model] : []),
      params.prompt,
    ];

    if (bypassActive) {
      process.stderr.write(
        `⚠  Codex running with dangerously-bypass-approvals-and-sandbox enabled.\n   cwd: ${cwd}\n   Ensure this environment is isolated (container or VM) before proceeding.\n`
      );
    }

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn("codex", args, {
        cwd,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const timeoutId = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stdout += text;
        logChunk(text, params.log, "info");
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
        stderr += text;
        logChunk(text, params.log, "error");
      });
      child.on("error", (err) => {
        clearTimeout(timeoutId);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timeoutId);
        if (timedOut) {
          reject(new Error(`Codex runner: request timed out after ${timeoutMs / 1000}s`));
          return;
        }
        resolve({ code, stdout, stderr });
      });
    });

    try {
      if (result.code !== 0) {
        const detail = stripAnsi(`${result.stderr}\n${result.stdout}`).trim().slice(0, 500);
        throw new Error(`Codex runner exited with code ${result.code ?? "unknown"}: ${detail}`);
      }

      let text: string;
      try {
        text = fs.readFileSync(outputPath, "utf8");
      } catch {
        const fallback = stripAnsi(result.stdout).trim();
        if (!fallback) {
          throw new Error("Codex runner: no final message captured");
        }
        text = fallback;
      }

      return { text: parseOutput(text, outputFormat) };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

async function runCodexInContainer(
  params: Parameters<AgentRunner>[0],
  outputFormat: "text" | "json"
): Promise<AgentResult> {
  const resolved = params.containerContext?.nodeContainer !== undefined
    ? normalizeContainerConfig(params.containerContext.nodeContainer, {
        image: params.containerContext.defaultImage ?? DEFAULT_BUILD_IMAGE,
        ...(params.cwd !== undefined && { workdir: params.cwd }),
      })
    : undefined;

  const effectiveWorkdir = resolved?.workdir ?? params.cwd;
  const env = resolved?.env;
  const outputPath = "/tmp/ripline-codex-last-message.txt";
  const args = [
    "codex",
    ...(params.dangerouslySkipPermissions
      ? ["exec", "--dangerously-bypass-approvals-and-sandbox"]
      : ["-a", "never", "exec", "--sandbox", params.mode === "plan" ? "read-only" : "workspace-write"]),
    "--skip-git-repo-check",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
    "-C",
    effectiveWorkdir ?? "/workspace",
    ...(params.model !== undefined ? ["--model", params.model] : []),
    params.prompt,
  ];

  const result = await params.containerContext!.pool.exec(
    params.containerContext!.runId,
    args,
    env,
    effectiveWorkdir,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `agent container exec failed with exit code ${result.exitCode}: ${summarizeCommandFailure(result.stdout, result.stderr)}`
    );
  }

  let text = stripAnsi(result.stdout).trim();
  if (outputFormat === "json") {
    const extracted = extractLastJson(text);
    text = extracted ?? text;
    try {
      JSON.parse(text);
    } catch {
      throw new Error(
        `Codex runner: outputFormat is "json" but response was not valid JSON: ${text.slice(0, 200)}`
      );
    }
  }
  return { text };
}
