import { spawn } from "node:child_process";
import type { AgentRunner, AgentRunParams, AgentEvent } from "./pipeline/executors/agent.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_BINARY = "codex";
const HEARTBEAT_INTERVAL_MS = 5_000;

/**
 * Quota-exhausted sentinel: anchored on "ERROR:" prefix to avoid false
 * positives from Codex echoing the user prompt to stderr.
 */
const QUOTA_EXHAUSTED_RE = /^ERROR:.*hit your usage limit/im;

export type CodexRunnerConfig = {
  /** Path to codex binary. Default: 'codex'. */
  binaryPath?: string;
  /** Milliseconds before the subprocess is killed. Default: 600_000 (10 min). */
  timeoutMs?: number;
  /** Working directory for the subprocess. Default: process.cwd(). */
  cwd?: string;
};

/**
 * Create an AgentRunner that invokes the Codex CLI (`codex exec -`).
 * The prompt is piped to stdin so large prompts don't hit OS argv limits.
 *
 * Emits a real AsyncGenerator<AgentEvent> stream:
 * - text_delta: yields text chunks as they arrive on stdout
 * - progress: heartbeat every 5s while waiting
 * - message_done: on successful exit with accumulated text
 * - error { kind: 'quota_exhausted' }: when stderr matches the usage limit regex
 * - error { kind: 'cli_failed' }: on other non-zero exit
 * - error { kind: 'spawn_failed' }: when the subprocess fails to start
 * - error { kind: 'aborted' }: when the AbortSignal fires
 * - error { kind: 'timeout' }: when timeoutMs elapses
 */
export function createCodexRunner(config?: CodexRunnerConfig): AgentRunner {
  const binary = config?.binaryPath ?? DEFAULT_BINARY;
  const defaultTimeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const defaultCwd = config?.cwd;

  async function* runImpl(params: AgentRunParams, signal?: AbortSignal): AsyncGenerator<AgentEvent> {
    const cwd = params.cwd ?? defaultCwd ?? process.cwd();
    const timeoutMs = params.timeoutSeconds !== undefined
      ? params.timeoutSeconds * 1000
      : defaultTimeoutMs;

    const logErr = (msg: string): void => {
      if (params.log) params.log.log("error", msg);
      else process.stderr.write(msg + "\n");
    };

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
      yield { type: "error", kind: "aborted", message: "Codex runner: aborted" } satisfies AgentEvent;
      return;
    }

    const args = ["exec", "--skip-git-repo-check", "-"];
    if (params.model) {
      args.push("--model", params.model);
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(binary, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: "error", kind: "spawn_failed", message: `Codex runner: failed to spawn codex: ${msg}` } satisfies AgentEvent;
      return;
    }

    // Write prompt to stdin (stdio is ["pipe","pipe","pipe"] so stdin is always non-null)
    child.stdin!.write(params.prompt, "utf-8");
    child.stdin!.end();

    let accumulated = "";
    let stderrBuf = "";
    let stdoutBuf = "";
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
        event: { type: "error", kind: "timeout", message: `Codex runner: request timed out after ${timeoutMs / 1000}s` },
      });
    }, timeoutMs);

    // AbortSignal
    const onAbort = (): void => {
      killAndSettle({
        tag: "event",
        event: { type: "error", kind: "aborted", message: "Codex runner: aborted" },
      });
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    // stdout — line-by-line text_delta events (stdio is ["pipe","pipe","pipe"] so stdout/stderr are non-null)
    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      const text = chunk.toString("utf-8");
      stdoutBuf += text;

      // Yield complete lines as text_delta events
      let newline: number;
      while ((newline = stdoutBuf.indexOf("\n")) !== -1) {
        const line = stdoutBuf.slice(0, newline);
        stdoutBuf = stdoutBuf.slice(newline + 1);
        if (line.length > 0) {
          accumulated += line + "\n";
          enqueue({ tag: "event", event: { type: "text_delta", text: line + "\n" } });
        }
      }
      // Any remaining partial chunk in stdoutBuf is held until next newline or close
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });

    child.on("error", (err: Error) => {
      settle({
        tag: "event",
        event: { type: "error", kind: "spawn_failed", message: `Codex runner: failed to spawn codex: ${err.message}` },
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
      // Flush any remaining partial line in stdoutBuf
      if (stdoutBuf.length > 0) {
        accumulated += stdoutBuf;
        enqueue({ tag: "event", event: { type: "text_delta", text: stdoutBuf } });
        stdoutBuf = "";
      }

      // Quota-exhausted detection
      if (QUOTA_EXHAUSTED_RE.test(stderrBuf)) {
        settle({
          tag: "event",
          event: {
            type: "error",
            kind: "quota_exhausted",
            message: `Codex runner: quota_exhausted — hit usage limit. stderr: ${stderrBuf.slice(0, 500)}`,
          },
        });
        return;
      }

      if (code !== 0) {
        logErr(`[codex-runner] FAILED: exit=${code ?? "null"} stderr=${stderrBuf.slice(0, 500)}`);
        settle({
          tag: "event",
          event: {
            type: "error",
            kind: "cli_failed",
            message: `Codex runner: process exited with code ${code ?? "null"}. stderr: ${stderrBuf.slice(0, 500)}`,
          },
        });
        return;
      }

      settle({
        tag: "event",
        event: { type: "message_done", text: accumulated.trim() },
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
