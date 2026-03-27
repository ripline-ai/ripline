/** Source systems that can emit activity events. */
export type ActivitySource = "ripline" | "claude-agent" | "system";

/** Lifecycle statuses for an activity event. */
export type ActivityStatus =
  | "started"
  | "running"
  | "success"
  | "error"
  | "info";

/** A single activity event recorded in the unified feed. */
export interface ActivityEvent {
  /** Unique event identifier (UUID v4). */
  id: string;
  /** ISO-8601 timestamp of when the event occurred. */
  timestamp: string;
  /** Which subsystem produced this event. */
  source: ActivitySource;
  /** Identifier within the source (e.g. run ID, agent session ID). */
  sourceId: string;
  /** Optional project / pipeline name for grouping. */
  project?: string;
  /** Optional channel / topic for further grouping. */
  channel?: string;
  /** Short verb describing what happened (e.g. "run.started", "node.completed"). */
  action: string;
  /** Human-readable one-line summary. */
  summary: string;
  /** Optional extended details (free-form). */
  details?: string;
  /** Current status of the activity. */
  status: ActivityStatus;
}

/** Query filter for retrieving activity events. */
export interface ActivityQuery {
  source?: ActivitySource;
  project?: string;
  status?: ActivityStatus;
  /** Return events with timestamp >= this ISO-8601 string. */
  since?: string;
  /** Maximum number of events to return (most recent first). */
  limit?: number;
}
