import { spawn } from "node:child_process";
import type { AgentRunner, AgentRunParams, AgentEvent } from "./pipeline/executors/agent.js";

const DEFAULT_BINARY = "gemini";
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MODEL = "gemini-2.5-pro-preview-05-06";
const HEARTBEAT_INTERVAL_MS = 5_000;

export type GeminiRunnerConfig = {
  /** Path to the gemini CLI binary. Defaults to 'gemini' (resolved from PATH). */
  binaryPath?: string;
  /** Maximum time in milliseconds before the run is aborted. Defaults to 600_000 (10 min). */
  timeoutMs?: number;
  /** Working directory for the gemini process. Defaults to process.cwd(). */
  cwd?: string;
};

// ---------------------------------------------------------------------------
// Gemini stream-json line parser (mirrors Chorus parseGemini)
// ---------------------------------------------------------------------------

type ParsedGeminiLine =
  | { kind: "text_delta"; text: string }
  | { kind: "message_done" }
  | { kind: "error"; message: string; isQuotaExhausted: boolean }
  | { kind: "ignore" };

function tryJson(line: string): Record<string, unknown> | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function looksLikeQuotaExhausted(s: string): boolean {
  return /quota|exhausted|429|capacity|rate.?limit|QUOTA_EXHAUSTED/i.test(s);
}

function extractResetWindow(s: string): string | null {
  const m = s.match(/(?:reset|resets|in)\s*(?:after|in)?\s*(\d+\s*(?:d|h|m|s)\s*)+/i);
  if (!m) return null;
  return m[0].replace(/^(?:reset|resets|in)\s*(?:after|in)?\s*/i, "").trim();
}

function extractErrorMessage(obj: Record<string, unknown>, status: string | undefined): string {
  if (typeof obj.error === "string") return obj.error;
  if (typeof obj.message === "string") return obj.message;

  const err = obj.error;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e.message === "string" && e.message.length > 0) return e.message;
    const cause = e.cause;
    if (cause && typeof cause === "object") {
      const c = cause as Record<string, unknown>;
      if (typeof c.message === "string" && c.message.length > 0) return c.message;
    }
  }
  return `Gemini result status=${status ?? "unknown"}`;
}

function parseGeminiLine(line: string): ParsedGeminiLine {
  const obj = tryJson(line);
  if (!obj) return { kind: "ignore" };

  const t = obj.type;

  // Streaming assistant content delta
  if (t === "message" && obj.role === "assistant" && obj.delta === true) {
    if (typeof obj.content === "string" && obj.content.length > 0) {
      return { kind: "text_delta", text: obj.content };
    }
    return { kind: "ignore" };
  }

  // Terminal result line
  if (t === "result") {
    const status = obj.status as string | undefined;
    if (status === "success") {
      return { kind: "message_done" };
    }

    const message = extractErrorMessage(obj, status);
    const combined = message + JSON.stringify(obj);
    const isQuotaExhausted = looksLikeQuotaExhausted(combined);
    return { kind: "error", message, isQuotaExhausted };
  }

  // init, user-echo, tool calls etc — ignored for now
  return { kind: "ignore" };
}

/**
 * Scan stderr captured on process exit for quota or auth errors that Gemini
 * CLI logs outside the JSON stream (mirrors Chorus parseGeminiExit).
 */
function parseGeminiStderr(stderr: string): string | null {
  if (!stderr) return null;

  const apiKeyMissing =
    /(GEMINI|GOOGLE(?:_GENAI)?)_API_KEY\s+(?:environment variable\s+)?not\s+(?:found|set)/i.exec(stderr);
  if (apiKeyMissing) {
    const envName = apiKeyMissing[0].split(/\s+/)[0];
    return (
      `Gemini CLI not authenticated — ${envName} is not set. ` +
      `Get a key at aistudio.google.com/apikey, or run \`gemini\` for the OAuth flow.`
    );
  }

  if (looksLikeQuotaExhausted(stderr)) {
    const reset = extractResetWindow(stderr);
    return reset
      ? `Gemini quota exhausted — resets in ${reset}.`
      : `Gemini quota exhausted (Google API returned 429).`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Create an AgentRunner that invokes the Gemini CLI in headless stream-json mode.
 *
 * Emits a real AsyncGenerator<AgentEvent> stream:
 * - text_delta: yields text chunks as delta lines arrive
 * - progress: heartbeat every 5s while waiting
 * - message_done: on { type: 'result', status: 'success' }
 * - error { kind: 'quota_exhausted' }: on quota/auth detection
 * - error { kind: 'cli_failed' }: on non-zero exit without done signal
 * - error { kind: 'spawn_failed' }: when subprocess fails to start
 * - error { kind: 'aborted' }: when the AbortSignal fires
 * - error { kind: 'timeout' }: when timeoutMs elapses
 */
export function createGeminiRunner(config?: GeminiRunnerConfig): AgentRunner {
  const binaryPath = config?.binaryPath ?? DEFAULT_BINARY;
  const defaultTimeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultCwd = config?.cwd;

  async function* runImpl(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const cwd = params.cwd ?? defaultCwd ?? process.cwd();
    const timeoutMs =
      params.timeoutSeconds !== undefined ? params.timeoutSeconds * 1000 : defaultTimeoutMs;
    const model = (() => {
      const raw = params.model;
      return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : DEFAULT_MODEL;
    })();

    const logErr = (msg: string): void => {
      if (params.log) params.log.log("error", msg);
      else process.stderr.write(msg + "\n");
    };

    if (process.env.RIPLINE_LOG_CONFIG === "1") {
      logErr(
        `[gemini-runner] timeoutMs=${timeoutMs} model=${model} cwd=${cwd}`
      );
    }

    // Queue-based bridge: child process events → async generator yields
    type QueueItem =
      | { tag: "event"; event: AgentEvent }
      | { tag: "done" };

    const queue: QueueItem[] = [];
    let resolver: ((value: void) => void) | null = null;

    const enqueue = (item: QueueItem): void => {
      queue.push(item);
      if (resolver) {
        const r = resolver;
        resolver = null;
        r();
      }
    };

    // Check abort before spawning
    if (signal?.aborted) {
      yield { type: "error", kind: "aborted", message: "Gemini runner: aborted" } satisfies AgentEvent;
      return;
    }

    // Build CLI args — prompt delivered via stdin; -p " " puts gemini in
    // non-interactive mode while avoiding argv overflow on large prompts.
    const args = [
      "-p",
      " ",
      "--output-format",
      "stream-json",
      "--skip-trust",
      "--approval-mode",
      "auto_edit",
      "-m",
      model,
    ];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binaryPath, args, {
        cwd,
        env: {
          ...process.env,
          // Defense-in-depth: env-var trust override mirrors --skip-trust flag
          GEMINI_CLI_TRUST_WORKSPACE: "true",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", kind: "spawn_failed", message: `Gemini runner: failed to spawn '${binaryPath}': ${msg}` } satisfies AgentEvent;
      return;
    }

    // Write the full prompt to stdin then close the write end
    // (stdio is ["pipe","pipe","pipe"] so stdin/stdout/stderr are always non-null)
    child.stdin!.write(params.prompt, "utf8");
    child.stdin!.end();

    let accumulated = "";
    let stderrBuf = "";
    let stdoutBuf = "";
    let doneSignaled = false;
    let settled = false;
    // Set before kill() so that a synchronous 'close' emission from the mock
    // (or a real process) can detect that the kill was intentional.
    let pendingKillItem: QueueItem | null = null;

    const settle = (item: QueueItem): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (heartbeatId) clearInterval(heartbeatId);
      if (signal) signal.removeEventListener("abort", onAbort);
      enqueue(item);
      enqueue({ tag: "done" });
    };

    const killAndSettle = (item: QueueItem): void => {
      if (settled) return;
      pendingKillItem = item;
      child.kill("SIGTERM");
      // If child.kill() triggers a synchronous 'close', the close handler
      // will call settle(pendingKillItem). If not (real async case), settle here.
      settle(item);
    };

    // Heartbeat — emit progress every 5s while waiting
    const heartbeatId = setInterval(() => {
      if (!settled) {
        enqueue({ tag: "event", event: { type: "progress" } });
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatId.unref?.();

    // Timeout
    const timeoutId = setTimeout(() => {
      killAndSettle({
        tag: "event",
        event: {
          type: "error",
          kind: "timeout",
          message: `Gemini runner: request timed out after ${timeoutMs / 1000}s`,
        },
      });
    }, timeoutMs);

    // AbortSignal
    const onAbort = (): void => {
      killAndSettle({
        tag: "event",
        event: { type: "error", kind: "aborted", message: "Gemini runner: aborted" },
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // stdout — parse stream-json line by line
    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      stdoutBuf += chunk.toString("utf8");
      let newline: number;
      while ((newline = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, newline);
        stdoutBuf = stdoutBuf.slice(newline + 1);
        const parsed = parseGeminiLine(line);

        if (parsed.kind === "text_delta") {
          accumulated += parsed.text;
          enqueue({ tag: "event", event: { type: "text_delta", text: parsed.text } });
        } else if (parsed.kind === "message_done") {
          doneSignaled = true;
          // Don't settle here — wait for process close to emit message_done
          // so we've fully accumulated all deltas first.
        } else if (parsed.kind === "error") {
          if (parsed.isQuotaExhausted) {
            settle({
              tag: "event",
              event: {
                type: "error",
                kind: "quota_exhausted",
                message: `Gemini quota exhausted. ${parsed.message}`,
              },
            });
          } else {
            settle({
              tag: "event",
              event: {
                type: "error",
                kind: "cli_failed",
                message: `Gemini runner: ${parsed.message}`,
              },
            });
          }
        }
        // "ignore" lines are silently dropped
      }
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf8");
    });

    child.on("error", (err: Error) => {
      settle({
        tag: "event",
        event: {
          type: "error",
          kind: "spawn_failed",
          message: `Gemini runner: failed to spawn '${binaryPath}': ${err.message}`,
        },
      });
    });

    child.on("close", (_code: number | null) => {
      // If a kill was already initiated (timeout or abort), use that event.
      // This handles the case where child.kill() triggers a synchronous 'close'.
      if (pendingKillItem) {
        settle(pendingKillItem);
        return;
      }
      if (settled) return;

      const code = _code;
      // Check stderr for structured auth / quota messages
      const stderrError = parseGeminiStderr(stderrBuf);
      if (stderrError) {
        const isQuota = looksLikeQuotaExhausted(stderrBuf);
        settle({
          tag: "event",
          event: {
            type: "error",
            kind: isQuota ? "quota_exhausted" : "auth_error",
            message: `Gemini runner: ${stderrError}`,
          },
        });
        return;
      }

      if (code !== 0 && !doneSignaled) {
        const tail = stderrBuf.slice(-500).trim();
        settle({
          tag: "event",
          event: {
            type: "error",
            kind: "cli_failed",
            message:
              `Gemini runner: process exited with code ${String(code)}` +
              (tail ? `\n${tail}` : ""),
          },
        });
        return;
      }

      if (!doneSignaled && accumulated === "") {
        settle({
          tag: "event",
          event: {
            type: "error",
            kind: "cli_failed",
            message: "Gemini runner: no output received from gemini CLI",
          },
        });
        return;
      }

      settle({
        tag: "event",
        event: { type: "message_done", text: accumulated },
      });
    });

    // Drain the queue
    while (true) {
      while (queue.length > 0) {
        const item = queue.shift()!;
        if (item.tag === "done") return;
        yield item.event;
      }
      // Wait for more items
      await new Promise<void>((resolve) => {
        resolver = resolve;
      });
    }
  }

  return {
    run(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
      return runImpl(params, signal);
    },
  };
}
