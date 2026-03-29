/* ------------------------------------------------------------------ */
/*  Usage-tracking types for the Claude Usage Battery Meter            */
/* ------------------------------------------------------------------ */

/** A single usage event recorded after a pipeline run or LLM call. */
export interface UsageEvent {
  /** Unique event identifier. */
  id: string;
  /** ISO-8601 timestamp of when the usage occurred. */
  timestamp: string;
  /** Pipeline that generated this usage (if applicable). */
  pipelineId?: string | undefined;
  /** Human-readable pipeline name. */
  pipelineName?: string | undefined;
  /** Number of input (prompt) tokens consumed. */
  inputTokens: number;
  /** Number of output (completion) tokens consumed. */
  outputTokens: number;
  /** Total tokens (inputTokens + outputTokens). */
  totalTokens: number;
  /** Optional model identifier (e.g. "claude-sonnet-4-20250514"). */
  model?: string | undefined;
  /** Free-form metadata attached by the caller. */
  meta?: Record<string, unknown> | undefined;
}

/** Per-pipeline breakdown entry inside an aggregate. */
export interface PipelineBreakdown {
  pipelineId: string;
  pipelineName: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  eventCount: number;
}

/** A single hourly bucket inside an aggregate. */
export interface HourlyBucket {
  /** ISO-8601 hour start (e.g. "2026-03-29T14:00:00.000Z"). */
  hour: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  eventCount: number;
}

/** Aggregated usage statistics returned by the store. */
export interface UsageAggregate {
  /** Start of the queried window (ISO-8601). */
  since: string;
  /** End of the queried window (ISO-8601). */
  until: string;
  /** Total input tokens in the window. */
  inputTokens: number;
  /** Total output tokens in the window. */
  outputTokens: number;
  /** Total tokens in the window. */
  totalTokens: number;
  /** Total number of events in the window. */
  eventCount: number;
  /** Breakdown by pipeline. */
  byPipeline: PipelineBreakdown[];
  /** Hourly buckets within the window. */
  hourlyBuckets: HourlyBucket[];
}

/** Persistent configuration for usage tracking / battery meter. */
export interface UsageConfig {
  /** Maximum tokens allowed per week (0 = unlimited). */
  weeklyTokenCap: number;
  /** Percentage thresholds that trigger visual warnings (sorted ascending). */
  thresholdPercents: number[];
  /** Whether usage tracking is enabled. */
  enabled: boolean;
  /** Day-of-week the weekly window resets (0 = Sunday, 1 = Monday, …). */
  resetDay: number;
}

/** Sensible defaults written on first access. */
export const DEFAULT_USAGE_CONFIG: UsageConfig = {
  weeklyTokenCap: 5_000_000,
  thresholdPercents: [50, 75, 90],
  enabled: true,
  resetDay: 1, // Monday
};
