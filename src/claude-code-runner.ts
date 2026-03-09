import fs from "node:fs";
import path from "node:path";
import type { AgentResult, AgentRunner } from "./pipeline/executors/agent.js";

const PLAN_MODE_DENY_TOOLS = ["Write", "Edit", "MultiEdit"];
const MAX_TURNS_CEILING_EXECUTE = 20;
const MAX_TURNS_CEILING_PLAN = 3;
const DEFAULT_TIMEOUT_SECONDS = 120;
const DEFAULT_MAX_TURNS_EXECUTE = 10;
const DEFAULT_MAX_TURNS_PLAN = 1;

export interface ClaudeCodeRunnerConfig {
  mode: "plan" | "execute";
  cwd?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  timeoutSeconds?: number;
  outputFormat?: "text" | "json";
}

function validateCwd(cwd: string): string {
  if (cwd.includes("..")) {
    throw new Error(`Claude Code runner: cwd must not contain ".." (got: ${cwd})`);
  }
  const resolved = path.resolve(cwd);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Claude Code runner: cwd must be an existing directory (got: ${resolved})`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`Claude Code runner: cwd does not exist (got: ${resolved})`);
    }
    throw err;
  }
  return resolved;
}

function applyMaxTurnsCeiling(mode: "plan" | "execute", maxTurns: number): number {
  const ceiling = mode === "plan" ? MAX_TURNS_CEILING_PLAN : MAX_TURNS_CEILING_EXECUTE;
  return Math.min(maxTurns, ceiling);
}

/**
 * Create an AgentRunner that invokes the Claude Code (Agent) SDK.
 * Use for nodes with runner: claude-code; supports plan (read-only) and execute modes.
 */
export function createClaudeCodeRunner(config: ClaudeCodeRunnerConfig): AgentRunner {
  const defaultMode = config.mode;
  const defaultCwd = config.cwd;
  const defaultMaxTurns =
    config.maxTurns ??
    (defaultMode === "plan" ? DEFAULT_MAX_TURNS_PLAN : DEFAULT_MAX_TURNS_EXECUTE);
  const defaultTimeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const outputFormat = config.outputFormat ?? "text";

  return async (params): Promise<AgentResult> => {
    const mode = params.mode ?? defaultMode;
    const rawCwd = params.cwd ?? defaultCwd ?? process.cwd();
    const cwd = validateCwd(rawCwd);

    const maxTurns = applyMaxTurnsCeiling(mode, config.maxTurns ?? defaultMaxTurns);
    const timeoutMs =
      (params.timeoutSeconds ?? defaultTimeout) * 1000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk");

      const planModeDenyTools = new Set(PLAN_MODE_DENY_TOOLS);
      const hooks: Record<string, Array<(input: unknown) => unknown>> = {};
      if (mode === "plan") {
        hooks.PreToolUse = [
          (input: unknown) => {
            const hookInput = input as { tool_name?: string };
            const toolName = hookInput?.tool_name;
            if (typeof toolName === "string" && planModeDenyTools.has(toolName)) {
              return {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: "Plan mode: write/edit tools are not allowed",
              };
            }
            return undefined;
          },
        ];
      }

      const allowedTools =
        mode === "plan"
          ? config.allowedTools ?? [
              "Read",
              "Glob",
              "Grep",
              "LS",
              "Bash(git log *)",
              "Bash(git diff *)",
              "Bash(find *)",
              "Bash(cat *)",
            ]
          : config.allowedTools;
      const disallowedTools =
        mode === "plan"
          ? [...(config.disallowedTools ?? []), "Write", "Edit", "MultiEdit"]
          : config.disallowedTools;

      const options: Record<string, unknown> = {
        cwd,
        permissionMode: mode === "plan" ? "plan" : "acceptEdits",
        allowDangerouslySkipPermissions: true,
        maxTurns,
        abortController: controller,
        ...(allowedTools !== undefined && { allowedTools }),
        ...(disallowedTools !== undefined && disallowedTools.length > 0 && { disallowedTools }),
        ...(Object.keys(hooks).length > 0 && { hooks }),
      };

      const q = query({
        prompt: params.prompt,
        options,
      });

      let resultText: string | undefined;
      let usage: { input?: number; output?: number } | undefined;

      for await (const message of q) {
        const m = message as { type?: string; subtype?: string; result?: string; usage?: unknown };
        if (m.type === "result") {
          clearTimeout(timeoutId);
          if (m.subtype === "success" && typeof m.result === "string") {
            resultText = m.result;
            const u = m.usage as
              | { input_tokens?: number; output_tokens?: number }
              | { input?: number; output?: number }
              | undefined;
            if (u && typeof u === "object") {
              const inputTokens =
                typeof (u as { input_tokens?: number }).input_tokens === "number"
                  ? (u as { input_tokens: number }).input_tokens
                  : (u as { input?: number }).input;
              const outputTokens =
                typeof (u as { output_tokens?: number }).output_tokens === "number"
                  ? (u as { output_tokens: number }).output_tokens
                  : (u as { output?: number }).output;
              if (typeof inputTokens === "number" || typeof outputTokens === "number") {
                usage = {};
                if (typeof inputTokens === "number") usage.input = inputTokens;
                if (typeof outputTokens === "number") usage.output = outputTokens;
              }
            }
          } else if (m.subtype !== "success") {
            const errMsg =
              (m as { errors?: string[] }).errors?.join("; ") ?? "Claude Code query did not succeed";
            throw new Error(`Claude Code runner: ${errMsg}`);
          }
          break;
        }
      }

      q.close?.();

      if (resultText === undefined) {
        throw new Error("Claude Code runner: no result message received");
      }

      if (outputFormat === "json") {
        try {
          JSON.parse(resultText);
        } catch {
          throw new Error(
            `Claude Code runner: outputFormat is "json" but response was not valid JSON: ${resultText.slice(0, 200)}`
          );
        }
      }

      const agentResult: AgentResult = { text: resultText };
      if (usage && (usage.input !== undefined || usage.output !== undefined)) {
        agentResult.tokenUsage = usage;
      }
      return agentResult;
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error) {
        if (err.name === "AbortError") {
          throw new Error(`Claude Code runner: request timed out after ${timeoutMs / 1000}s`);
        }
        throw err;
      }
      throw new Error(String(err));
    }
  };
}
