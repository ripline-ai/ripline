/**
 * App-wide logger: stderr by default, optional run-scoped sink (in-memory or file).
 * Use child({ runId, nodeId }) to tag subsequent log lines.
 */

import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = {
  ts: number;
  level: LogLevel;
  message: string;
  runId?: string;
  nodeId?: string;
};

/** Sink receives a structured entry and the formatted line (e.g. for file append). */
export type LogSink = (entry: LogEntry, line: string) => void;

export type LoggerContext = {
  runId?: string;
  nodeId?: string;
};

export type Logger = {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  /** Create a child logger with runId/nodeId set for subsequent logs. */
  child(context: LoggerContext): Logger;
};

function formatLine(entry: LogEntry): string {
  const parts: string[] = ["[ripline]"];
  if (entry.runId) parts.push(`[${entry.runId.slice(0, 8)}]`);
  if (entry.nodeId) parts.push(`[${entry.nodeId}]`);
  parts.push(`${entry.level}:`, entry.message);
  return parts.join(" ") + "\n";
}

function defaultStderrSink(_entry: LogEntry, line: string): void {
  process.stderr.write(line);
}

export type CreateLoggerOptions = {
  /** Optional extra sink (e.g. run-scoped file or in-memory buffer). */
  sink?: LogSink;
  /** Default runId for this logger. */
  runId?: string;
  /** Default nodeId for this logger. */
  nodeId?: string;
};

/**
 * Create a logger. Writes to stderr by default; if sink is provided, also invokes sink(entry, line).
 * Use .child({ runId, nodeId }) when executing a run/node so logs are tagged.
 */
export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const { sink, runId: defaultRunId, nodeId: defaultNodeId } = options;
  const sinks: LogSink[] = [defaultStderrSink];
  if (sink) sinks.push(sink);

  function log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
    runId?: string,
    nodeId?: string
  ): void {
    const r = runId ?? defaultRunId;
    const n = nodeId ?? defaultNodeId;
    const entry: LogEntry = {
      ts: Date.now(),
      level,
      message: meta ? `${message} ${JSON.stringify(meta)}` : message,
      ...(r !== undefined && { runId: r }),
      ...(n !== undefined && { nodeId: n }),
    };
    const line = formatLine(entry);
    for (const s of sinks) s(entry, line);
  }

  const logger: Logger = {
    log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
      log(level, message, meta, defaultRunId, defaultNodeId);
    },
    child(context: LoggerContext): Logger {
      const runId = context.runId ?? defaultRunId;
      const nodeId = context.nodeId ?? defaultNodeId;
      return createLogger({
        ...options,
        ...(runId !== undefined && { runId }),
        ...(nodeId !== undefined && { nodeId }),
      });
    },
  };
  return logger;
}

/** Default process logger (stderr only). Use for code that has no run context. */
export const defaultLogger = createLogger();

/** Log file name under each run directory (e.g. <runsDir>/<runId>/LOG_FILE_NAME). */
export const LOG_FILE_NAME = "log.txt";

/**
 * Sink that appends each log line to a run-specific file: <runsDir>/<entry.runId>/log.txt.
 * Use when creating a logger for the runner so all run-scoped logs (with runId) are written to the run dir.
 * Ensures run directory exists before writing.
 */
export function createRunScopedFileSink(runsDir: string): LogSink {
  return (entry: LogEntry, line: string): void => {
    if (!entry.runId) return;
    const dir = path.join(runsDir, entry.runId);
    const filePath = path.join(dir, LOG_FILE_NAME);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(filePath, line, "utf8");
    } catch {
      // Best-effort; avoid breaking the process if log file write fails
    }
  };
}
