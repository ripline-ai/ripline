import fs from "node:fs";
import path from "node:path";
import type { McpServerConfig } from "./types.js";
import type { AgentRunner, AgentRunParams, AgentEvent, TokenUsage, AgentErrorKind } from "./pipeline/executors/agent.js";
import { stripAnsi, extractLastJson } from "./stdout-parser.js";
import { normalizeContainerConfig, DEFAULT_BUILD_IMAGE } from "./run-container-pool.js";

const PLAN_MODE_DENY_TOOLS = ["Write", "Edit", "MultiEdit"];
const MAX_TURNS_CEILING_EXECUTE = 200;
const MAX_TURNS_CEILING_PLAN = 10;
const DEFAULT_TIMEOUT_SECONDS = 300;
const DEFAULT_MAX_TURNS_EXECUTE = 200;
const DEFAULT_MAX_TURNS_PLAN = 3;
const HEARTBEAT_INTERVAL_MS = 5_000;

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

// ---------------------------------------------------------------------------
// SDK message shapes (narrowed from @anthropic-ai/claude-agent-sdk types)
// ---------------------------------------------------------------------------

/** Streamlined shape of a single BetaRawMessageStreamEvent for mapping. */
type StreamEvent = {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string; input?: unknown; text?: string };
  delta?: { type: string; text?: string; partial_json?: string; input_json?: string };
};

/** Narrowed result message shape from the SDK. */
type SDKResultMessage = {
  type: "result";
  subtype: string;
  result?: string;
  errors?: string[];
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    // ModelUsage shape variant (used when usage is the consolidated ModelUsage)
    inputTokens?: number;
    outputTokens?: number;
    cacheReadInputTokens?: number;
  };
};

/** Narrowed partial assistant message (streaming events). */
type SDKPartialMessage = {
  type: "stream_event";
  event: StreamEvent;
};

/** Narrowed completed assistant turn message. */
type SDKAssistantMessage = {
  type: "assistant";
  message: {
    content: Array<{
      type: string;
      id?: string;
      name?: string;
      input?: unknown;
      text?: string;
    }>;
  };
};

// ---------------------------------------------------------------------------
// Event mappers
// ---------------------------------------------------------------------------

/** Extract TokenUsage from a result message's usage field. */
function extractTokenUsage(msg: SDKResultMessage): TokenUsage | undefined {
  const u = msg.usage;
  if (!u || typeof u !== "object") return undefined;

  // Try both naming conventions the SDK may use
  const inputTokens =
    typeof u.input_tokens === "number"
      ? u.input_tokens
      : typeof u.inputTokens === "number"
        ? u.inputTokens
        : undefined;
  const outputTokens =
    typeof u.output_tokens === "number"
      ? u.output_tokens
      : typeof u.outputTokens === "number"
        ? u.outputTokens
        : undefined;
  const cachedInputTokens =
    typeof u.cache_read_input_tokens === "number"
      ? u.cache_read_input_tokens
      : typeof u.cacheReadInputTokens === "number"
        ? u.cacheReadInputTokens
        : undefined;

  const costUsd =
    typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined;

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    cachedInputTokens === undefined &&
    costUsd === undefined
  ) {
    return undefined;
  }

  return {
    ...(inputTokens !== undefined && { inputTokens }),
    ...(outputTokens !== undefined && { outputTokens }),
    ...(cachedInputTokens !== undefined && { cachedInputTokens }),
    ...(costUsd !== undefined && { costUsd }),
  };
}

/** Determine AgentErrorKind from an SDK error message or string. */
function classifyError(msg: string, subtypeOrName?: string): AgentErrorKind {
  if (subtypeOrName === "AbortError" || /aborted/i.test(msg)) return "aborted";
  if (/timed?\s*out/i.test(msg)) return "timeout";
  if (/authentication_failed|auth.*fail|not authenticated/i.test(msg)) return "auth_error";
  if (/quota|rate.?limit|429|billing/i.test(msg)) return "quota_exhausted";
  if (/not found.*path|not in path|ENOENT.*claude|command not found/i.test(msg)) return "cli_not_in_path";
  if (/max.*turn|error_max_turn/i.test(msg)) return "cli_failed";
  if (/error_during_execution|error_max_budget/i.test(msg)) return "cli_failed";
  if (/output.*truncat|truncat.*output/i.test(msg)) return "output_truncated";
  if (/parse|json|unexpected token/i.test(msg)) return "parse_error";
  return "cli_failed";
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

  async function* runImpl(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    if (params.containerContext) {
      // Container path: delegate to container exec helper then yield result
      try {
        const result = await runClaudeCodeInContainer(params, outputFormat);
        yield { type: "message_done", text: result.text } satisfies AgentEvent;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        yield { type: "error", kind: classifyError(errMsg), message: errMsg } satisfies AgentEvent;
      }
      return;
    }

    const mode = params.mode ?? defaultMode;
    const rawCwd = params.cwd ?? defaultCwd ?? process.cwd();
    let cwd: string;
    try {
      cwd = validateCwd(rawCwd);
    } catch (err) {
      yield {
        type: "error",
        kind: "spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      } satisfies AgentEvent;
      return;
    }

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
    const timeoutMs = (params.timeoutSeconds ?? defaultTimeout) * 1000;

    const logErr = (msg: string): void => {
      if (params.log) params.log.log("error", msg);
      else console.error(msg);
    };

    if (process.env.RIPLINE_LOG_CONFIG === "1") {
      logErr(
        `[claude-code-runner] maxTurns=${maxTurns} timeoutMs=${timeoutMs} mode=${mode} cwd=${cwd}`
      );
    }

    // Compose AbortController: respect external signal + internal timeout
    const controller = new AbortController();
    if (signal) {
      if (signal.aborted) {
        controller.abort();
      } else {
        signal.addEventListener("abort", () => controller.abort(), { once: true });
      }
    }
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let heartbeatId: ReturnType<typeof setInterval> | undefined;

    const savedClaudeCode = process.env.CLAUDECODE;
    delete process.env.CLAUDECODE;

    try {
      let resultText: string | undefined;
      let tokenUsage: TokenUsage | undefined;
      let accumulatedText = "";

      // Tool-call tracking: input JSON is streamed incrementally
      const pendingToolInputs = new Map<number, string>(); // index -> partial JSON

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

        // Heartbeat: track last-yield time and emit progress between messages
        let lastProgressAt = Date.now();

        for await (const message of q) {
          // Check if we should emit a heartbeat (approximate 5s interval)
          const now = Date.now();
          if (now - lastProgressAt >= HEARTBEAT_INTERVAL_MS) {
            yield { type: "progress" } satisfies AgentEvent;
            lastProgressAt = now;
          }

          const m = message as { type?: string; subtype?: string; result?: string; event?: StreamEvent };

          // ---------------------------------------------------------------
          // stream_event — streaming content from assistant
          // ---------------------------------------------------------------
          if (m.type === "stream_event" && m.event) {
            const ev = m.event;

            if (ev.type === "content_block_start") {
              const block = ev.content_block;
              if (block?.type === "tool_use" && block.id && block.name) {
                // Tool call starting; input arrives later via content_block_delta
                pendingToolInputs.set(ev.index ?? -1, "");
                yield {
                  type: "tool_call_start",
                  id: block.id,
                  name: block.name,
                  input: block.input ?? {},
                } satisfies AgentEvent;
              }
            } else if (ev.type === "content_block_delta") {
              const delta = ev.delta;
              if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
                accumulatedText += delta.text;
                yield { type: "text_delta", text: delta.text } satisfies AgentEvent;
              } else if (delta?.type === "input_json_delta") {
                const partial = delta.partial_json ?? delta.input_json ?? "";
                const existing = pendingToolInputs.get(ev.index ?? -1) ?? "";
                pendingToolInputs.set(ev.index ?? -1, existing + partial);
              }
            } else if (ev.type === "content_block_stop") {
              // If there's pending input JSON for this index, we've finished accumulating it
              // The tool_call_end will be emitted when we see the full assistant message
              // (SDKAssistantMessage with complete content blocks). Nothing to emit here
              // since we already emitted tool_call_start.
            }
            // message_start, message_delta, message_stop — ignore; result handles completion
            continue;
          }

          // ---------------------------------------------------------------
          // assistant — completed turn message (tool use content blocks)
          // ---------------------------------------------------------------
          if (m.type === "assistant") {
            const am = m as unknown as SDKAssistantMessage;
            for (const block of am.message?.content ?? []) {
              if (block.type === "tool_use" && block.id) {
                // Emit tool_call_end with resolved input
                yield {
                  type: "tool_call_end",
                  id: block.id,
                  output: block.input ?? {},
                } satisfies AgentEvent;
              } else if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
                // If we didn't get streaming text_deltas, accumulate from full message
                if (accumulatedText === "") {
                  accumulatedText += block.text;
                  yield { type: "text_delta", text: block.text } satisfies AgentEvent;
                }
              }
            }
            continue;
          }

          // ---------------------------------------------------------------
          // result — terminal message
          // ---------------------------------------------------------------
          if (m.type === "result") {
            clearTimeout(timeoutId);
            heartbeatId && clearInterval(heartbeatId);

            const rm = m as unknown as SDKResultMessage;
            logErr(
              `[claude-code-runner] result message: subtype=${rm.subtype}`
            );

            if (rm.subtype === "success" && typeof rm.result === "string") {
              resultText = rm.result;
              tokenUsage = extractTokenUsage(rm);
            } else {
              const errors = rm.errors ?? [];
              const errDetail = [
                `subtype=${rm.subtype ?? "unknown"}`,
                `errors=${JSON.stringify(errors)}`,
                `result=${typeof rm.result === "string" ? rm.result.slice(0, 500) : String(rm.result ?? "")}`,
              ].join(", ");
              logErr(`[claude-code-runner] FAILED: ${errDetail}`);
              const kind = classifyError(errDetail, rm.subtype);
              yield {
                type: "error",
                kind,
                message: `Claude Code runner: ${errDetail}`,
              } satisfies AgentEvent;
              return;
            }
            break;
          }

          // Other messages (user, system, tool_use_summary, etc.) — ignored
          const anyMsg = m as { type?: string; subtype?: string };
          logErr(
            `[claude-code-runner] message: type=${anyMsg.type ?? "n/a"} subtype=${anyMsg.subtype ?? "n/a"}`
          );
        }

        q.close?.();
        pendingToolInputs.clear();

        if (resultText === undefined) {
          yield {
            type: "error",
            kind: "cli_failed",
            message: "Claude Code runner: no result message received",
          } satisfies AgentEvent;
          return;
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
            yield {
              type: "error",
              kind: "parse_error",
              message: `Claude Code runner: outputFormat is "json" but response was not valid JSON: ${resultText.slice(0, 200)}`,
            } satisfies AgentEvent;
            return;
          }
        }

        yield {
          type: "message_done",
          text: resultText,
          ...(tokenUsage && { usage: tokenUsage }),
        } satisfies AgentEvent;

      } catch (err) {
        clearTimeout(timeoutId);
        heartbeatId && clearInterval(heartbeatId);

        const errMsg = err instanceof Error ? err.message : String(err);
        const errName = err instanceof Error ? err.name : undefined;

        // Classify the error
        let kind: AgentErrorKind;
        if (controller.signal.aborted || errName === "AbortError" || /aborted/i.test(errMsg)) {
          kind = "aborted";
        } else {
          kind = classifyError(errMsg, errName);
        }

        logErr(`[claude-code-runner] caught error: ${errMsg}`);
        yield {
          type: "error",
          kind,
          message: errMsg,
        } satisfies AgentEvent;
      }
    } finally {
      clearTimeout(timeoutId);
      heartbeatId && clearInterval(heartbeatId);
      if (savedClaudeCode !== undefined) process.env.CLAUDECODE = savedClaudeCode;
      else delete process.env.CLAUDECODE;
    }
  }

  return {
    run(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      return runImpl(params, signal);
    },
  };
}

async function runClaudeCodeInContainer(
  params: AgentRunParams,
  outputFormat: "text" | "json"
): Promise<{ text: string }> {
  const timeoutMs =
    params.timeoutSeconds !== undefined
      ? params.timeoutSeconds * 1000
      : undefined;
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
    timeoutMs,
  );

  if (result.timedOut) {
    throw new Error(`Claude Code runner: request timed out after ${Math.ceil((timeoutMs ?? 0) / 1000)}s`);
  }

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
