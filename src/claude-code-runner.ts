import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "./types.js";
import type { AgentResult, AgentRunner } from "./pipeline/executors/agent.js";
import { stripAnsi, extractLastJson } from "./stdout-parser.js";
import { normalizeContainerConfig, DEFAULT_BUILD_IMAGE } from "./run-container-pool.js";

const PLAN_MODE_DENY_TOOLS = ["Write", "Edit", "MultiEdit"];
const MAX_TURNS_CEILING_EXECUTE = 200;
const MAX_TURNS_CEILING_PLAN = 10;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_TURNS_EXECUTE = 200;
const DEFAULT_MAX_TURNS_PLAN = 3;

/** Default execute-mode tool whitelist when permissionMode is dontAsk. Overridable via config.allowedTools. */
const DEFAULT_EXECUTE_ALLOWED_TOOLS = [
  "Read",
  "Write",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "Bash(git *)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git push *)",
  "Bash(git pull *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git branch *)",
  "Bash(git merge *)",
  "Bash(git rebase *)",
  "Bash(git stash *)",
  "Bash(git log *)",
  "Bash(git diff *)",
  "Bash(git status)",
  "Bash(git fetch *)",
  "Bash(find *)",
  "Bash(cat *)",
  "Bash(curl *)",
  "Bash(jq *)",
  "Bash(python3 *)",
  "WebFetch",
];

export interface ClaudeCodeRunnerConfig {
  mode: "plan" | "execute";
  cwd?: string;
  /** Default model for nodes that do not set model (e.g. claude-sonnet-4-6). */
  model?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  maxTurns?: number;
  timeoutSeconds?: number;
  outputFormat?: "text" | "json";
  /** Opt-in bypass; only from user config or env, never from pipeline/profile. */
  allowDangerouslySkipPermissions?: boolean;
  /** Default MCP servers applied to all runs (merged under call-level mcpServers; call-level wins). */
  mcpServers?: Record<string, McpServerConfig>;
}

function validateCwd(cwd: string): string {
  const segments = cwd.split(path.sep).filter(Boolean);
  if (segments.some((seg) => seg === "..")) {
    throw new Error(
      `Claude Code runner: cwd must not contain parent directory reference ".." (got: ${cwd})`
    );
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

type ExecuteOptionsResult = {
  permissionMode: "dontAsk" | "bypassPermissions";
  allowedTools?: string[];
  disallowedTools: string[];
  maxTurns: number;
  bypassActive: boolean;
};

function buildExecuteOptions(
  config: ClaudeCodeRunnerConfig,
  resolvedCwd: string,
  cwdExplicit: boolean,
  maxTurns: number,
  nodeRequestsBypass: boolean
): ExecuteOptionsResult {
  const bypassEligible =
    config.allowDangerouslySkipPermissions === true &&
    nodeRequestsBypass === true &&
    config.mode === "execute" &&
    !!resolvedCwd &&
    cwdExplicit;

  if (bypassEligible) {
    return {
      permissionMode: "bypassPermissions",
      disallowedTools: [...(config.disallowedTools ?? [])],
      maxTurns,
      bypassActive: true,
    };
  }
  return {
    permissionMode: "dontAsk",
    allowedTools: config.allowedTools ?? DEFAULT_EXECUTE_ALLOWED_TOOLS,
    disallowedTools: config.disallowedTools ?? [],
    maxTurns,
    bypassActive: false,
  };
}

/**
 * Create an AgentRunner that invokes the Claude Code (Agent) SDK.
 * Use for nodes with runner: claude-code; supports plan (read-only) and execute modes.
 */
export function createClaudeCodeRunner(config: ClaudeCodeRunnerConfig): AgentRunner {
  const defaultMode = config.mode;
  const defaultCwd = config.cwd;
  const defaultTimeout = config.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const outputFormat = config.outputFormat ?? "text";

  return async (params): Promise<AgentResult> => {
    if (params.containerContext) {
      return runClaudeCodeInContainer(params, outputFormat);
    }

    const mode = params.mode ?? defaultMode;
    const rawCwd = params.cwd ?? defaultCwd ?? process.cwd();
    const cwd = validateCwd(rawCwd);
    const cwdExplicit = params.cwd !== undefined || defaultCwd !== undefined;
    const modelRaw = params.model ?? config.model;
    const model = typeof modelRaw === "string" && modelRaw.trim() !== "" ? modelRaw.trim() : undefined;

    const effectiveMcpServers = (() => {
      const merged = { ...(config.mcpServers ?? {}), ...(params.mcpServers ?? {}) };
      return Object.keys(merged).length > 0 ? merged : undefined;
    })();

    const defaultMaxTurnsForCall =
      mode === "plan" ? DEFAULT_MAX_TURNS_PLAN : DEFAULT_MAX_TURNS_EXECUTE;
    const maxTurns = applyMaxTurnsCeiling(mode, config.maxTurns ?? defaultMaxTurnsForCall);
    const timeoutMs =
      (params.timeoutSeconds ?? defaultTimeout) * 1000;
    const logErr = (msg: string): void => {
      if (params.log) params.log.log("error", msg);
      else console.error(msg);
    };
    if (process.env.RIPLINE_LOG_CONFIG === "1") {
      logErr(
        `[claude-code-runner] maxTurns=${maxTurns} timeoutMs=${timeoutMs} mode=${mode} cwd=${cwd}`
      );
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const savedClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;
    try {
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

        let permissionMode: string;
        let allowedTools: string[] | undefined;
        let disallowedTools: string[];
        let bypassActive = false;

        if (mode === "plan") {
          permissionMode = "plan";
          allowedTools =
            config.allowedTools ??
            ["Read", "Glob", "Grep", "LS", "Bash(git log *)", "Bash(git diff *)", "Bash(find *)", "Bash(cat *)"];
          disallowedTools = [...(config.disallowedTools ?? []), "Write", "Edit", "MultiEdit"];
        } else {
          const nodeRequestsBypass = params.dangerouslySkipPermissions === true;
          const effectiveConfig = { ...config, mode: "execute" as const };
          const execOpts = buildExecuteOptions(effectiveConfig, cwd, cwdExplicit, maxTurns, nodeRequestsBypass);
          permissionMode = execOpts.permissionMode;
          allowedTools = execOpts.allowedTools;
          disallowedTools = execOpts.disallowedTools;
          bypassActive = execOpts.bypassActive;
          if (config.allowDangerouslySkipPermissions === true && !bypassActive) {
            const reason = !nodeRequestsBypass
              ? "node does not set dangerouslySkipPermissions: true"
              : !cwdExplicit
                ? "cwd not explicitly set (set cwd in config or params for bypass)"
                : "cwd invalid or missing";
            process.stderr.write(
              `⚠  Bypass not activated: ${reason}. Using default execute mode (dontAsk + allowedTools).\n`
            );
          }
        }

        if (bypassActive) {
          process.stderr.write(
            `⚠  Claude Code running with dangerously-skip-permissions enabled.\n   cwd: ${cwd}\n   Ensure this environment is isolated (container or VM) before proceeding.\n`
          );
        }

        const options: Record<string, unknown> = {
          cwd,
          permissionMode,
          maxTurns,
          abortController: controller,
          ...(allowedTools !== undefined && allowedTools.length > 0 && { allowedTools }),
          ...(disallowedTools.length > 0 && { disallowedTools }),
          ...(Object.keys(hooks).length > 0 && { hooks }),
          ...(model !== undefined && { model }),
          ...(effectiveMcpServers !== undefined && { mcpServers: effectiveMcpServers }),
        };

        const q = query({
          prompt: params.prompt,
          options,
        });

        let resultText: string | undefined;
        let usage: { input?: number; output?: number } | undefined;

        for await (const message of q) {
          const m = message as { type?: string; subtype?: string; result?: string; usage?: unknown; errors?: string[]; message?: { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }> }; error?: string };
          if (params.log && m.type === "assistant") {
            for (const block of (m.message?.content ?? [])) {
              if (block.type === "text" && block.text) {
                params.log.log("info", block.text.trimEnd());
              } else if (block.type === "tool_use" && block.name) {
                const inp = block.input as Record<string, unknown> | undefined;
                const detail = inp?.command ?? inp?.file_path ?? inp?.path ?? inp?.pattern ?? inp?.prompt;
                const suffix = typeof detail === "string" ? `: ${detail.slice(0, 200)}` : "";
                params.log.log("info", `tool: ${block.name}${suffix}`);
              }
            }
            if (m.error) {
              logErr(`[claude-code-runner] assistant error: ${m.error}`);
            }
          }
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
              const errors = (m as { errors?: string[] }).errors;
              const errDetail = [
                `subtype=${m.subtype ?? "unknown"}`,
                `errors=${JSON.stringify(errors ?? [])}`,
                `result=${typeof m.result === "string" ? m.result.slice(0, 500) : String(m.result ?? "")}`,
              ].join(", ");
              logErr(`[claude-code-runner] FAILED: ${errDetail}`);
              throw new Error(`Claude Code runner: ${errDetail}`);
            }
            break;
          }
        }

        q.close?.();

        if (resultText === undefined) {
          throw new Error("Claude Code runner: no result message received");
        }

        // Clean ANSI escape codes from result text unconditionally
        resultText = stripAnsi(resultText);

        if (outputFormat === "json") {
          // Try to extract a valid JSON object even if surrounded by noise
          const extracted = extractLastJson(resultText);
          if (extracted !== undefined) {
            resultText = extracted;
          } else {
            // Fall back to trimmed text and let the parse check fail with a clear message
            resultText = resultText.trim();
          }
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
      } finally {
        if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
        else delete process.env.CLAUDECODE;
      }
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

async function runClaudeCodeInContainer(
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

  const claudeArgs: string[] = ["claude", "-p", params.prompt, "--output-format", "text"];
  if (params.dangerouslySkipPermissions) {
    claudeArgs.push("--dangerously-skip-permissions");
  }
  if (params.model) {
    claudeArgs.push("--model", params.model);
  }
  if (params.mode === "plan") {
    claudeArgs.push("--disallowed-tools", "Write,Edit,MultiEdit");
  }

  const args =
    params.timeoutSeconds !== undefined
      ? ["timeout", String(params.timeoutSeconds), ...claudeArgs]
      : claudeArgs;

  const result = await params.containerContext!.pool.exec(
    params.containerContext!.runId,
    args,
    env,
    effectiveWorkdir,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `agent container exec failed with exit code ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 500)}`
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
        `Claude Code runner: outputFormat is "json" but response was not valid JSON: ${text.slice(0, 200)}`
      );
    }
  }
  return { text };
}
