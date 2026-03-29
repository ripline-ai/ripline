import { spawn } from "node:child_process";
import type { ShellNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

const DEFAULT_TIMEOUT_S = 120;

/** Interpolate {{key}} placeholders from artifacts and inputs into a string. */
function interpolate(template: string, context: ExecutorContext): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_, key) => {
    const parts = key.split(".");
    let val: unknown = parts[0] in context.artifacts
      ? context.artifacts[parts[0]]
      : context.inputs[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (val == null || typeof val !== "object") return "";
      val = (val as Record<string, unknown>)[parts[i]];
    }
    return val != null ? String(val) : "";
  });
}

/**
 * Run a shell command, capture combined stdout+stderr, return structured result.
 * Non-zero exit either throws (failOnNonZero=true, default) or is captured in result.
 */
export async function executeShell(
  node: ShellNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const command = interpolate(node.command, context);
  const cwd = node.cwd ?? process.cwd();
  const timeoutMs = (node.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
  const failOnNonZero = node.failOnNonZero !== false;

  const { exitCode, output } = await runCommand(command, cwd, timeoutMs);

  // Filter to only failing test lines if output looks like jest/npm test output
  const failingOutput = extractFailures(output);

  const value = {
    exitCode,
    passed: exitCode === 0,
    output: failingOutput || output.slice(-3000), // fall back to last 3KB if no failures found
    rawOutput: output.slice(-200000), // up to 200KB for data-fetching use cases
  };

  if (failOnNonZero && exitCode !== 0) {
    throw new Error(`shell: command exited with code ${exitCode}\n${value.output.slice(0, 1000)}`);
  }

  const artifactKey = node.assigns ?? node.id;
  context.artifacts[artifactKey] = value;
  return { artifactKey, value };
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = [];
    const proc = spawn("sh", ["-c", command], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (d: Buffer) => chunks.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => chunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`shell: command timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: chunks.join("") });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Extract only failing test lines from jest/npm test output.
 * Returns empty string if no failures detected (i.e. all passed).
 */
function extractFailures(output: string): string {
  const lines = output.split("\n");
  const failLines: string[] = [];
  let inFailBlock = false;

  for (const line of lines) {
    // Jest failure markers
    if (/^\s*(FAIL|✕|✗|×)\s/.test(line) || /●\s/.test(line) || /FAIL\s+\S+\.test/.test(line)) {
      inFailBlock = true;
    }
    // Summary lines always useful
    if (/Tests?:|Test Suites?:|FAIL|PASS|failed|passed/i.test(line) && line.trim().length > 0) {
      if (!failLines.includes(line)) failLines.push(line);
      continue;
    }
    if (inFailBlock) {
      failLines.push(line);
      // End of a failure block (blank line after content)
      if (line.trim() === "" && failLines.length > 3) inFailBlock = false;
    }
  }

  return failLines.length > 0 ? failLines.join("\n").slice(0, 4000) : "";
}
