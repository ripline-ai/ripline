import { spawn } from "node:child_process";
import type { ShellNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import { normalizeContainerConfig, DEFAULT_BUILD_IMAGE } from "../../run-container-pool.js";
import { interpolateTemplate } from "../../expression.js";

const DEFAULT_TIMEOUT_S = 120;

const interpolationContext = (context: ExecutorContext) => ({
  inputs: context.inputs,
  ...context.inputs,
  ...context.artifacts,
  env: context.env,
  run: { inputs: context.inputs },
});

/**
 * Run a shell command, capture combined stdout+stderr, return structured result.
 * Non-zero exit either throws (failOnNonZero=true, default) or is captured in result.
 */
export async function executeShell(
  node: ShellNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const ctx = interpolationContext(context);
  const command = interpolateTemplate(node.command, ctx);
  const cwd = node.cwd ? interpolateTemplate(node.cwd, ctx) : process.cwd();
  const timeoutMs = (node.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;
  const failOnNonZero = node.failOnNonZero !== false;

  // Route through container pool when:
  //   1. A containerPool is in context, AND
  //   2. Either the node has an explicit container config OR the pool already holds
  //      a run-level container (acquired by the runner before node execution).
  const { exitCode, output } = await (
    context.containerPool &&
    context.runId &&
    (node.container !== undefined || context.containerPool.hasContainer(context.runId))
      ? runCommandInContainer(
          command,
          context.containerPool,
          context.runId,
          node.container,
          cwd,
          context.defaultContainerImage,
          timeoutMs,
        )
      : runCommand(command, cwd, timeoutMs)
  );

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

/**
 * Execute a shell command inside the run-level persistent container.
 * If the node has an isolated container config, the pool must already hold a
 * container for the run (acquired by the runner).  Env from the node's container
 * config is merged into the exec call.
 */
async function runCommandInContainer(
  command: string,
  pool: import("../../run-container-pool.js").RunContainerPool,
  runId: string,
  nodeContainer: import("../../types.js").NodeContainerConfig | undefined,
  workdir: string,
  defaultImage?: string,
  timeoutMs?: number,
): Promise<{ exitCode: number; output: string }> {
  // Resolve node-level container config for extra env / workdir override
  const resolved = nodeContainer !== undefined
    ? normalizeContainerConfig(nodeContainer, { image: defaultImage ?? DEFAULT_BUILD_IMAGE, workdir })
    : undefined;

  const effectiveWorkdir = resolved?.workdir ?? workdir;
  const env = resolved?.env;

  const result = await pool.exec(runId, ["sh", "-c", command], env, effectiveWorkdir, timeoutMs);
  if (result.timedOut) {
    throw new Error(`shell: command timed out after ${Math.ceil((timeoutMs ?? 0) / 1000)}s`);
  }
  const output = result.stdout + (result.stderr ? result.stderr : "");
  return { exitCode: result.exitCode, output };
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
