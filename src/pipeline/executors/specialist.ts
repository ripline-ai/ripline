import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SpecialistNode } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import { interpolateTemplate } from "../../expression.js";

const DEFAULT_TIMEOUT_S = 300;

const interpolationContext = (context: ExecutorContext): Record<string, unknown> => ({
  inputs: context.inputs,
  ...context.inputs,
  ...context.artifacts,
  env: context.env,
  run: { inputs: context.inputs },
});

/**
 * Invoke a named specialist agent via the Claude Code CLI.
 *
 * Resolves the agent's working directory as ~/agents/{agent}/, then runs:
 *   claude --cwd ~/agents/{agent}/ -p "{fullPrompt}" --output-format text
 *
 * Returns the agent's stdout as `text` on the artifact.
 */
export async function executeSpecialist(
  node: SpecialistNode,
  context: ExecutorContext,
): Promise<NodeResult> {
  const ctx = interpolationContext(context);

  const agentName = interpolateTemplate(node.agent, ctx).trim();
  // Treat interpolation errors (e.g. [[error:...]]) and blank strings as invalid
  if (!agentName || agentName.startsWith("[[error:")) {
    throw new Error(`specialist: agent name must not be empty (got: "${agentName}")`);
  }

  const agentDir = path.join(os.homedir(), "agents", agentName);

  if (!fs.existsSync(agentDir)) {
    throw new Error(`specialist: agent directory not found: ${agentDir}`);
  }

  const prompt = interpolateTemplate(node.prompt, ctx);
  const contextText = node.context ? interpolateTemplate(node.context, ctx) : undefined;
  const fullPrompt = contextText ? `${contextText}\n\n${prompt}` : prompt;

  const timeoutMs = (node.timeoutSeconds ?? DEFAULT_TIMEOUT_S) * 1000;

  const text = await runClaude(agentDir, fullPrompt, timeoutMs);

  const value = { text };
  const artifactKey = node.assigns ?? node.id;
  context.artifacts[artifactKey] = value;
  return { artifactKey, value };
}

function runClaude(cwd: string, prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const proc = spawn("claude", ["-p", prompt, "--output-format", "text"], {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    proc.stdout.on("data", (d: Buffer) => stdoutChunks.push(d.toString()));
    proc.stderr.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`specialist: claude timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const stderr = stderrChunks.join("").slice(0, 500);
        reject(new Error(`specialist: claude exited with code ${code}${stderr ? `: ${stderr}` : ""}`));
        return;
      }
      resolve(stdoutChunks.join("").trim());
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`specialist: failed to spawn claude: ${err.message}`));
    });
  });
}
