import { spawn } from "node:child_process";
import type { AgentRunner, AgentRunParams, AgentEvent, AgentErrorKind, TokenUsage } from "./pipeline/executors/agent.js";

export type KimiRunnerConfig = {
  /** Path to the kimi binary. Defaults to "kimi". */
  binaryPath?: string;
  /** Timeout in milliseconds. Defaults to 600_000 (10 minutes). */
  timeoutMs?: number;
  /** Working directory for the kimi process. */
  cwd?: string;
};

const DEFAULT_TIMEOUT_MS = 600_000;
const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Parse a single JSON-Lines output line from `kimi --print --output-format stream-json`.
 *
 * Kimi uses the same streaming JSON event format as Claude Code:
 *   {"type":"text","text":"..."}         — streaming text delta
 *   {"type":"result","result":"..."}     — final result (success)
 *   {"type":"result","subtype":"error","error":"..."} — error result
 *
 * Returns a parsed event descriptor or null for unrecognised lines.
 */
type KimiParsed =
  | { kind: 'text_delta'; text: string }
  | { kind: 'result'; text: string; usage?: TokenUsage }
  | { kind: 'error'; errorKind: AgentErrorKind; message: string }
  | { kind: 'ignored' };

function parseKimiLine(line: string, textBuffer: { value: string }): KimiParsed {
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

  // Streaming text delta
  if (event["type"] === "text" && typeof event["text"] === "string") {
    textBuffer.value += event["text"];
    return { kind: 'text_delta', text: event["text"] as string };
  }

  // Final result event
  if (event["type"] === "result") {
    const subtype = event["subtype"];
    const isError = event["is_error"];

    // Error result
    if (subtype === "error" || isError === true) {
      const errMsg = typeof event["error"] === "string"
        ? event["error"]
        : typeof event["result"] === "string"
          ? event["result"]
          : "Kimi reported an error";
      return { kind: 'error', errorKind: 'cli_failed', message: errMsg };
    }

    // Extract usage if available (Claude Code compatible format)
    let usage: TokenUsage | undefined;
    const usageField = event["usage"] as Record<string, unknown> | undefined;
    if (usageField && typeof usageField === "object") {
      usage = {
        ...(typeof usageField["input_tokens"] === "number" && { inputTokens: usageField["input_tokens"] as number }),
        ...(typeof usageField["output_tokens"] === "number" && { outputTokens: usageField["output_tokens"] as number }),
        ...(typeof usageField["cache_read_input_tokens"] === "number" && { cachedInputTokens: usageField["cache_read_input_tokens"] as number }),
      };
      if (Object.keys(usage).length === 0) usage = undefined;
    }

    // Prefer explicit result field, else fall back to accumulated buffer
    const resultText = typeof event["result"] === "string"
      ? event["result"]
      : textBuffer.value;

    return usage !== undefined
      ? { kind: 'result', text: resultText, usage }
      : { kind: 'result', text: resultText };
  }

  return { kind: 'ignored' };
}

/**
 * Create an AgentRunner that invokes the Kimi (MoonshotAI) CLI.
 *
 * Spawns `kimi --print --output-format stream-json` with the prompt on
 * stdin. The CLI emits JSON-Lines where text deltas are yielded as
 * `text_delta` events, a heartbeat `progress` event is emitted every 5s,
 * and a final `result` event signals completion with `message_done`.
 *
 * Errors (spawn failure, non-zero exit, abort, timeout) yield typed
 * `error` events instead of throwing.
 */
export function createKimiRunner(config?: KimiRunnerConfig): AgentRunner {
  const binary = config?.binaryPath ?? "kimi";
  const configTimeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const configCwd = config?.cwd;

  async function* runImpl(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const timeoutMs =
      params.timeoutSeconds !== undefined
        ? params.timeoutSeconds * 1000
        : configTimeoutMs;
    const cwd = params.cwd ?? configCwd ?? process.cwd();
    const modelArgs: string[] = [];
    if (params.model) {
      modelArgs.push("-m", params.model);
    }

    const args = ["--print", "--output-format", "stream-json", ...modelArgs];

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

    const close = (): void => {
      if (finished) return;
      finished = true;
      queue.push({ done: true });
      if (resolver) { resolver(); resolver = null; }
    };

    // Spawn the child process
    const child = spawn(binary, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let heartbeatHandle: ReturnType<typeof setInterval> | undefined;
    let settled = false;
    let stderrOutput = "";
    const textBuffer = { value: "" };

    const finish = (cleanup?: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener("abort", onAbort);
      if (heartbeatHandle) clearInterval(heartbeatHandle);
      cleanup?.();
      close();
    };

    // Timeout
    timeoutId = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      finish(() => {
        enqueue({
          type: "error",
          kind: "timeout",
          message: `Kimi runner: request timed out after ${timeoutMs / 1000}s`,
        });
      });
    }, timeoutMs);

    // AbortSignal
    const onAbort = (): void => {
      if (settled) return;
      child.kill("SIGTERM");
      finish(() => {
        enqueue({ type: "error", kind: "aborted", message: "Kimi runner: aborted" });
      });
    };

    if (signal) {
      if (signal.aborted) {
        child.kill("SIGTERM");
        finish(() => {
          enqueue({ type: "error", kind: "aborted", message: "Kimi runner: aborted" });
        });
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Write prompt to stdin
    child.stdin.write(params.prompt, "utf-8");
    child.stdin.end();

    // Heartbeat every 5s
    heartbeatHandle = setInterval(() => {
      if (!settled) enqueue({ type: "progress" });
    }, HEARTBEAT_INTERVAL_MS);

    // Stdout parsing
    let stdoutBuf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBuf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, nl);
        stdoutBuf = stdoutBuf.slice(nl + 1);
        const parsed = parseKimiLine(line, textBuffer);
        if (parsed.kind === "text_delta") {
          enqueue({ type: "text_delta", text: parsed.text });
        } else if (parsed.kind === "result") {
          enqueue({ type: "message_done", text: parsed.text, ...(parsed.usage && { usage: parsed.usage }) });
          child.kill("SIGTERM");
          finish();
          return;
        } else if (parsed.kind === "error") {
          enqueue({ type: "error", kind: parsed.errorKind, message: parsed.message });
          child.kill("SIGTERM");
          finish();
          return;
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
          message: `Kimi runner: failed to spawn "${binary}": ${err.message}`,
        });
      });
    });

    child.on("close", (code: number | null) => {
      if (settled) return;

      // Drain any remaining buffered output
      if (stdoutBuf.trim()) {
        const parsed = parseKimiLine(stdoutBuf, textBuffer);
        stdoutBuf = "";
        if (parsed.kind === "result") {
          finish(() => {
            enqueue({ type: "message_done", text: parsed.text, ...(parsed.usage && { usage: parsed.usage }) });
          });
          return;
        } else if (parsed.kind === "error") {
          finish(() => {
            enqueue({ type: "error", kind: parsed.errorKind, message: parsed.message });
          });
          return;
        }
      }

      // If we accumulated text via streaming deltas, emit message_done
      if (textBuffer.value.length > 0) {
        finish(() => {
          enqueue({ type: "message_done", text: textBuffer.value });
        });
        return;
      }

      // Non-zero exit with no output
      const errDetail = stderrOutput.trim().slice(0, 300) || `exit code ${code ?? "null"}`;
      const cmdNotFound = /command not found|: not found/i;
      const isPathErr = code === 127 || cmdNotFound.test(errDetail);
      const kind: AgentErrorKind = isPathErr ? "cli_not_in_path" : "cli_failed";
      finish(() => {
        enqueue({
          type: "error",
          kind,
          message: `Kimi runner: process exited without output: ${errDetail}`,
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
