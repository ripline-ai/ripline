import { spawn } from "node:child_process";
import type { AgentRunner, AgentRunParams, AgentEvent, AgentErrorKind, TokenUsage } from "./pipeline/executors/agent.js";

export type OpenCodeRunnerConfig = {
  /** Path to the opencode binary. Defaults to "opencode". */
  binaryPath?: string;
  /** Timeout in milliseconds. Defaults to 600_000 (10 minutes). */
  timeoutMs?: number;
  /** Working directory for the opencode process. */
  cwd?: string;
};

const DEFAULT_TIMEOUT_MS = 600_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Parse a single JSON-Lines output line from `opencode run --format json`.
 *
 * OpenCode v1.14+ emits JSON-Lines — one event per line:
 *   {"type":"text","part":{"text":"..."}}         — streaming text delta
 *   {"type":"step_finish","part":{"tokens":{...},"cost":<usd>}} — usage
 *   {"type":"message_done",...}                   — final event (older builds)
 *
 * Legacy formats also supported:
 *   {"type":"text","text":"..."}                  — older text delta
 *   {"type":"result","result":"..."}              — Claude Code compat
 *   {"type":"message","message":{"role":"assistant","content":"..."}}
 *   {"type":"message_done","message":{"content":"..."}}
 */
type OpenCodeParsed =
  | { kind: 'text_delta'; text: string }
  | { kind: 'step_finish'; usage: TokenUsage }
  | { kind: 'message_done'; text: string | null }
  | { kind: 'result'; text: string }
  | { kind: 'ignored' };

function parseOpenCodeLine(
  line: string,
  textBuffer: { value: string }
): OpenCodeParsed {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'ignored' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'ignored' };
  }

  if (!parsed || typeof parsed !== "object") return { kind: 'ignored' };
  const event = parsed as Record<string, unknown>;

  // Modern format: text delta via part.text
  if (event["type"] === "text") {
    const part = event["part"] as Record<string, unknown> | undefined;
    if (part && typeof part["text"] === "string" && part["text"].length > 0) {
      textBuffer.value += part["text"];
      return { kind: 'text_delta', text: part["text"] as string };
    }
    // Legacy format: direct text field
    if (typeof event["text"] === "string") {
      textBuffer.value += event["text"] as string;
      return { kind: 'text_delta', text: event["text"] as string };
    }
    return { kind: 'ignored' };
  }

  // step_finish — carries token counts and cost (modern opencode format)
  if (event["type"] === "step_finish") {
    const part = event["part"] as Record<string, unknown> | undefined;
    const tokens = part?.["tokens"] as
      | { input?: number; output?: number; cache?: { read?: number } }
      | undefined;
    const cost = typeof part?.["cost"] === "number" ? part["cost"] as number : undefined;

    const usage: TokenUsage = {
      ...(typeof tokens?.input === "number" && { inputTokens: tokens.input }),
      ...(typeof tokens?.output === "number" && { outputTokens: tokens.output }),
      ...(typeof tokens?.cache?.read === "number" && { cachedInputTokens: tokens.cache.read }),
      ...(cost !== undefined && { costUsd: cost }),
    };
    if (Object.keys(usage).length > 0) {
      return { kind: 'step_finish', usage };
    }
    return { kind: 'ignored' };
  }

  // Final result field (Claude-Code-compatible format)
  if (event["type"] === "result" && typeof event["result"] === "string") {
    return { kind: 'result', text: event["result"] as string };
  }

  // message_done — final assistant message (older opencode / legacy format)
  if (event["type"] === "message_done") {
    const msg = event["message"] as Record<string, unknown> | undefined;
    const content = msg?.["content"];
    if (typeof content === "string" && content.length > 0) {
      return { kind: 'message_done', text: content };
    }
    // Fall back to accumulated buffer
    if (textBuffer.value.length > 0) {
      return { kind: 'message_done', text: textBuffer.value };
    }
    return { kind: 'message_done', text: null };
  }

  // Assistant message event (legacy streaming format)
  if (event["type"] === "message") {
    const msg = event["message"] as Record<string, unknown> | undefined;
    if (msg?.["role"] === "assistant") {
      const content = msg["content"];
      if (typeof content === "string") {
        textBuffer.value = content;
      }
    }
    return { kind: 'ignored' };
  }

  return { kind: 'ignored' };
}

/**
 * Parse the full stdout of a completed `opencode run --format json` invocation.
 *
 * Used as a fallback when no streaming events resolved before close (the
 * isatty fallback path where opencode emits one blob on exit).
 *
 * Strategy: scan all lines in order. Prefer the last message_done or result
 * event with non-empty content. Aggregate step_finish usage events across the
 * whole session. If none, accumulate all text deltas and return the
 * concatenation.
 */
function parseOpenCodeOutput(fullOutput: string): { text: string | null; usage?: TokenUsage } {
  const trimmed = fullOutput.trim();
  if (!trimmed) return { text: null };

  const lines = trimmed.split("\n").filter((l) => l.trim());
  let accumulatedText = "";
  let finalText: string | null = null;
  const textBuffer = { value: "" };

  // Accumulated usage across all step_finish events
  const usageAcc: TokenUsage = {};
  let hasUsage = false;

  for (const line of lines) {
    if (!line) continue;
    const parsed = parseOpenCodeLine(line, textBuffer);

    if (parsed.kind === "text_delta") {
      accumulatedText += parsed.text;
    } else if (parsed.kind === "step_finish") {
      // Aggregate usage
      const u = parsed.usage;
      if (u.inputTokens !== undefined) { usageAcc.inputTokens = (usageAcc.inputTokens ?? 0) + u.inputTokens; hasUsage = true; }
      if (u.outputTokens !== undefined) { usageAcc.outputTokens = (usageAcc.outputTokens ?? 0) + u.outputTokens; hasUsage = true; }
      if (u.cachedInputTokens !== undefined) { usageAcc.cachedInputTokens = (usageAcc.cachedInputTokens ?? 0) + u.cachedInputTokens; hasUsage = true; }
      if (u.costUsd !== undefined) { usageAcc.costUsd = (usageAcc.costUsd ?? 0) + u.costUsd; hasUsage = true; }
    } else if (parsed.kind === "result") {
      finalText = parsed.text;
    } else if (parsed.kind === "message_done" && parsed.text !== null) {
      finalText = parsed.text;
    }
  }

  const text = finalText ?? (accumulatedText.length > 0 ? accumulatedText : null);
  if (hasUsage) {
    return { text, usage: usageAcc };
  }
  return { text };
}

/**
 * Create an AgentRunner that invokes the OpenCode CLI.
 *
 * OpenCode is a one-shot CLI that runs a model and exits:
 *   `opencode run --format json [--model <model>] "<prompt>"`
 *
 * The prompt is passed as a positional argument (opencode's `run`
 * sub-command does not support stdin). For large prompts this runner
 * relies on the OS ARG_MAX limit; callers should keep prompts
 * under ~100 KB or use a file-indirection pattern.
 *
 * OpenCode 1.14.x checks isatty(stdout) and emits zero bytes when
 * stdout is a pipe. This runner therefore collects all output and
 * falls back to a full-output parse if no streaming events resolve.
 *
 * Events emitted:
 *   - `text_delta` for each streaming text chunk
 *   - `progress` heartbeat every 5s (since opencode is often one-shot)
 *   - `message_done` with accumulated text + usage from step_finish events
 *   - `error` for spawn failures, non-zero exit, timeout, and abort
 */
export function createOpenCodeRunner(config?: OpenCodeRunnerConfig): AgentRunner {
  const binary = config?.binaryPath ?? "opencode";
  const configTimeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configCwd = config?.cwd;

  async function* runImpl(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const timeoutMs =
      params.timeoutSeconds !== undefined
        ? params.timeoutSeconds * 1000
        : configTimeoutMs;
    const cwd = params.cwd ?? configCwd ?? process.cwd();

    const openCodeArgs = ["run", "--format", "json"];
    if (params.model) {
      openCodeArgs.push("--model", params.model);
    }
    openCodeArgs.push(params.prompt);

    // Queue-based bridge between Node.js event emitters and async generator
    type QueueItem =
      | { done: false; event: AgentEvent }
      | { done: true };

    const queue: QueueItem[] = [];
    let resolver: (() => void) | null = null;
    let finished = false;

    const enqueue = (event: AgentEvent): void => {
      queue.push({ done: false, event });
      if (resolver) { resolver(); resolver = null; }
    };

    const closeQueue = (): void => {
      if (finished) return;
      finished = true;
      queue.push({ done: true });
      if (resolver) { resolver(); resolver = null; }
    };

    // Spawn child process
    const child = spawn(binary, openCodeArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    let stderrOutput = "";
    let fullStdout = "";
    const textBuffer = { value: "" };
    // Accumulated usage from step_finish events during streaming
    const streamUsageAcc: TokenUsage = {};
    let hasStreamUsage = false;
    // Whether we already emitted a message_done during streaming
    let messageDoneEmitted = false;

    const finish = (cleanup?: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (heartbeatHandle) clearInterval(heartbeatHandle);
      cleanup?.();
      closeQueue();
    };

    // Timeout
    timeoutId = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      finish(() => {
        enqueue({
          type: "error",
          kind: "timeout",
          message: `OpenCode runner: request timed out after ${timeoutMs / 1000}s`,
        });
      });
    }, timeoutMs);

    // AbortSignal
    const onAbort = (): void => {
      if (settled) return;
      child.kill("SIGTERM");
      finish(() => {
        enqueue({ type: "error", kind: "aborted", message: "OpenCode runner: aborted" });
      });
    };

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
        finish(() => {
          enqueue({ type: "error", kind: "aborted", message: "OpenCode runner: aborted" });
        });
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Heartbeat every 5s (opencode is often one-shot; keeps UI alive)
    heartbeatHandle = setInterval(() => {
      if (!settled) enqueue({ type: "progress" });
    }, HEARTBEAT_INTERVAL_MS);

    // Stdout parsing
    let stdoutBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString("utf-8");
      fullStdout += text;
      stdoutBuf += text;

      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const parsed = parseOpenCodeLine(line, textBuffer);

        if (parsed.kind === "text_delta") {
          enqueue({ type: "text_delta", text: parsed.text });
        } else if (parsed.kind === "step_finish") {
          // Accumulate usage across all step_finish events (multi-step agents)
          const u = parsed.usage;
          if (u.inputTokens !== undefined) { streamUsageAcc.inputTokens = (streamUsageAcc.inputTokens ?? 0) + u.inputTokens; hasStreamUsage = true; }
          if (u.outputTokens !== undefined) { streamUsageAcc.outputTokens = (streamUsageAcc.outputTokens ?? 0) + u.outputTokens; hasStreamUsage = true; }
          if (u.cachedInputTokens !== undefined) { streamUsageAcc.cachedInputTokens = (streamUsageAcc.cachedInputTokens ?? 0) + u.cachedInputTokens; hasStreamUsage = true; }
          if (u.costUsd !== undefined) { streamUsageAcc.costUsd = (streamUsageAcc.costUsd ?? 0) + u.costUsd; hasStreamUsage = true; }
        } else if (parsed.kind === "result") {
          // Claude Code compat: result event is terminal
          messageDoneEmitted = true;
          enqueue({
            type: "message_done",
            text: parsed.text,
            ...(hasStreamUsage && { usage: { ...streamUsageAcc } }),
          });
          finish();
          return;
        } else if (parsed.kind === "message_done") {
          // Legacy message_done event
          if (parsed.text !== null) {
            messageDoneEmitted = true;
            enqueue({
              type: "message_done",
              text: parsed.text,
              ...(hasStreamUsage && { usage: { ...streamUsageAcc } }),
            });
            finish();
            return;
          }
          // message_done with empty content — continue accumulating
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrOutput += chunk.toString("utf-8");
    });

    child.on("error", (err: Error) => {
      if (settled) return;
      const isEnoent = (err as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT/.test(err.message);
      const kind: AgentErrorKind = isEnoent ? "cli_not_in_path" : "spawn_failed";
      finish(() => {
        enqueue({
          type: "error",
          kind,
          message: `OpenCode runner: failed to spawn "${binary}": ${err.message}`,
        });
      });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;

      // Process any remaining buffered output
      if (stdoutBuf.trim()) {
        fullStdout += stdoutBuf;
        const parsed = parseOpenCodeLine(stdoutBuf, textBuffer);
        stdoutBuf = "";

        if (parsed.kind === "text_delta" && !messageDoneEmitted) {
          enqueue({ type: "text_delta", text: parsed.text });
        } else if (parsed.kind === "result" && !messageDoneEmitted) {
          messageDoneEmitted = true;
          finish(() => {
            enqueue({
              type: "message_done",
              text: parsed.text,
              ...(hasStreamUsage && { usage: { ...streamUsageAcc } }),
            });
          });
          return;
        } else if (parsed.kind === "message_done" && parsed.text !== null && !messageDoneEmitted) {
          messageDoneEmitted = true;
          finish(() => {
            enqueue({
              type: "message_done",
              text: parsed.text!,
              ...(hasStreamUsage && { usage: { ...streamUsageAcc } }),
            });
          });
          return;
        }
      }

      if (messageDoneEmitted) {
        finish();
        return;
      }

      // Non-zero exit with no output
      if (code !== 0 && !fullStdout.trim()) {
        const errDetail = stderrOutput.trim().slice(0, 300) || `exit code ${code ?? "null"}`;
        const cmdNotFound = /command not found|: not found/i;
        const isPathErr = code === 127 || cmdNotFound.test(errDetail);
        const kind: AgentErrorKind = isPathErr ? "cli_not_in_path" : "cli_failed";
        finish(() => {
          enqueue({
            type: "error",
            kind,
            message: `OpenCode runner: process failed: ${errDetail}`,
          });
        });
        return;
      }

      // Fall back to full-output parse (handles one-shot JSON blob on exit)
      const { text: parsedText, usage: parsedUsage } = parseOpenCodeOutput(fullStdout);
      if (parsedText !== null) {
        finish(() => {
          enqueue({
            type: "message_done",
            text: parsedText,
            ...(parsedUsage && { usage: parsedUsage }),
          });
        });
        return;
      }

      // If we accumulated streaming text, use it
      if (textBuffer.value.length > 0) {
        finish(() => {
          enqueue({
            type: "message_done",
            text: textBuffer.value,
            ...(hasStreamUsage && { usage: { ...streamUsageAcc } }),
          });
        });
        return;
      }

      const errDetail = stderrOutput.trim().slice(0, 300) || `exit code ${code ?? "null"}`;
      const cmdNotFound = /command not found|: not found/i;
      const isPathErr = code === 127 || cmdNotFound.test(errDetail);
      const kind: AgentErrorKind = isPathErr ? "cli_not_in_path" : "cli_failed";
      finish(() => {
        enqueue({
          type: "error",
          kind,
          message: `OpenCode runner: process exited without output: ${errDetail}`,
        });
      });
    });

    // Drain the queue as an async generator
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => { resolver = resolve; });
      }
      const item = queue.shift();
      if (!item) continue;
      if (item.done) break;
      yield item.event;
    }
  }

  return {
    run(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      return runImpl(params, signal);
    },
  };
}
