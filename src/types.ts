import type { JSONSchema7 } from "json-schema";

export type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

export type McpSSEServerConfig = {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
};

export type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

/** Serializable MCP server config (no live SDK instances). */
export type McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig;

/** A named skill: an MCP server config with an optional human-readable description. */
export type SkillDefinition = McpServerConfig & { description?: string };

/** Named library of skills available to agents. */
export type SkillsRegistry = Record<string, SkillDefinition>;

export type RiplineProfile = {
  name: string;
  description?: string;
  /** Agent definitions for this profile. Merged on top of global agents (profile wins). */
  agents?: Record<string, AgentDefinition>;
  /** Skills registry for this profile. Merged on top of global skills (profile wins). */
  skills?: SkillsRegistry;
  inputs: Record<string, unknown>;
};

export type RiplineUserConfig = {
  pipelineDir?: string;
  profileDir?: string;
  skillsDir?: string;
  defaultProfile?: string;
  /** Only from ~/.ripline/config.json; never from pipeline/profile/input. */
  claudeCode?: { allowDangerouslySkipPermissions?: boolean };
  /** Background queue configuration. */
  backgroundQueue?: BackgroundQueueConfig;
  /** Telegram notification configuration. */
  telegram?: TelegramConfig;
};

export type PipelinePluginConfig = {
  pipelinesDir: string;
  maxConcurrency?: number;
  httpPath?: string;
  httpPort?: number;
  authToken?: string;
  /** Directory for run state (default .ripline/runs). Used by HTTP server. */
  runsDir?: string;
  /** File path for the background queue YAML store (default ~/obsidian/Ops/queue.yaml). */
  queueFilePath?: string;
};

export type NodeContract = {
  input?: JSONSchema7;
  output?: JSONSchema7;
};

export type NodeRetryConfig = {
  maxAttempts: number;
  delayMs?: number;
};

/** Pipeline-level retry policy for resuming failed runs. */
export type RetryPolicy = {
  maxAttempts: number;
  backoffMs: number;
  backoffMultiplier: number;
  retryableCategories: ErrorCategory[];
};

export type ErrorCategory = "transient" | "permanent" | "unknown";

export type ClaudeCodeAgentDefinition = {
  runner: "claude-code";
  /** Prepended to the node's prompt at run time. */
  systemPrompt?: string;
  model?: string;
  mode?: "plan" | "execute";
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  timeoutSeconds?: number;
  cwd?: string;
  dangerouslySkipPermissions?: boolean;
  /** Named skills to attach from the skills registry (resolved to mcpServers at run time). */
  skills?: string[];
  /** Explicit MCP server configs. Merged with resolved skills; explicit entries win. */
  mcpServers?: Record<string, McpServerConfig>;
  /** Path to a markdown file describing available skills; injected into agent context. Relative to effective cwd, or absolute. */
  skillsFile?: string;
};

/** An agent with no special Ripline config (e.g. an OpenClaw agent whose definition lives externally). */
export type ExternalAgentDefinition = {
  runner?: "openclaw";
};

export type AgentDefinition = ClaudeCodeAgentDefinition | ExternalAgentDefinition;

export type NodeBase = {
  id: string;
  name?: string;
  description?: string;
  contracts?: NodeContract;
  metadata?: Record<string, unknown>;
  /** Retry transient failures: max attempts and optional delay between attempts. */
  retry?: NodeRetryConfig;
};

export type LiteralNode = NodeBase & {
  type: "data";
  value: unknown;
};

export type InputNode = NodeBase & {
  type: "input";
  path?: string;
};

export type TransformNode = NodeBase & {
  type: "transform";
  expression: string;
  assigns?: string;
};

export type AgentNode = NodeBase & {
  type: "agent";
  agentId?: string;
  sessionId?: string;
  /** When true or omitted, use a new session per run (context isolation). When false, use run-level sessionId for continuity. */
  resetSession?: boolean;
  prompt: string;
  channel?: string;
  deliver?: boolean;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  timeoutSeconds?: number;
  /** Opt-in to Claude Code runner for this node. When set, claudeCodeRunner must be provided in runner options. */
  runner?: "claude-code";
  /** For runner: claude-code — "plan" = read-only; "execute" = full access. Default when runner is claude-code: "execute". */
  mode?: "plan" | "execute";
  /** Working directory for Claude Code (supports template interpolation). */
  cwd?: string;
  /** When runner is claude-code and global bypass is allowed: set true to use bypass for this node only. Omit or false = dontAsk for this node. Safer to enable per-node than globally. */
  dangerouslySkipPermissions?: boolean;
  /** When runner is claude-code: model to use (e.g. claude-sonnet-4-6, claude-opus-4-6). Omit to use config or CLI default. */
  model?: string;
  /** Node-level skill names to attach from the registry (merged with agent-definition skills; node wins). */
  skills?: string[];
  /** Node-level explicit MCP server configs (merged on top of agent-definition mcpServers; node wins). */
  mcpServers?: Record<string, McpServerConfig>;
};

export type RunPipelineNode = NodeBase & {
  type: "run_pipeline";
  pipelineId: string;
  inputMapping?: Record<string, string>;
  mode?: "child" | "inline";
};

export type LoopNode = NodeBase & {
  type: "loop";
  collection: string;
  itemVar?: string;
  indexVar?: string;
  maxIterations?: number;
  exitCondition?: string;
  body: LoopBody;
  /** Execution mode: 'sequential' processes items one-by-one; 'parallel' uses dependency waves. Default 'sequential'. */
  mode?: "sequential" | "parallel";
  /** Maximum number of items to execute concurrently in parallel mode. */
  maxConcurrency?: number;
  /** Field name on each item that holds an array of dependency item IDs. Default 'dependsOn'. */
  dependsOnField?: string;
};

export type LoopBody = {
  pipelineId?: string;
  entry?: string[];
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
};

export type SwitchNode = NodeBase & {
  type: "switch";
  expression: string;
  cases: Record<string, object>;
  default?: string;
};

export type CheckpointNode = NodeBase & {
  type: "checkpoint";
  reason?: string;
  resumeKey?: string;
};

export type OutputNode = NodeBase & {
  type: "output";
  path?: string;
  /** Artifact key to write (default: this node's id). */
  source?: string;
  merge?: boolean;
};

/** Convention for breakdown nodes: emit tasks[] for downstream enqueue node. */
export type TaskItem = {
  id: string;
  title: string;
  detail?: string;
  priority?: number | string;
};

export type EnqueueNode = NodeBase & {
  type: "enqueue";
  /** Child pipeline to run for each task (or once with full list in batch mode). */
  pipelineId: string;
  /** Artifact key containing tasks array (default "tasks"). */
  tasksSource?: string;
  /** batch = one child run with inputs.tasks = full list; per-item = one run per task. */
  mode?: "batch" | "per-item";
};

export type CollectChildrenNode = NodeBase & {
  type: "collect_children";
};

export type ShellNode = NodeBase & {
  type: "shell";
  /** Shell command to run. Supports {{artifact}} interpolation. */
  command: string;
  /** Working directory for the command. */
  cwd?: string;
  /** Artifact key to assign result to. Defaults to node id. */
  assigns?: string;
  /** Max execution time in seconds. Default 120. */
  timeoutSeconds?: number;
  /** If true, non-zero exit code throws and fails the pipeline node. Default true. */
  failOnNonZero?: boolean;
};

export type PipelineNode =
  | LiteralNode
  | InputNode
  | TransformNode
  | AgentNode
  | RunPipelineNode
  | LoopNode
  | SwitchNode
  | CheckpointNode
  | OutputNode
  | EnqueueNode
  | CollectChildrenNode
  | ShellNode;

export type PipelineEdge = {
  id?: string;
  from: { node: string; port?: string };
  to: { node: string; port?: string };
  when?: string;
  default?: boolean;
  on_error?: boolean;
};

export type PipelineContracts = {
  input?: JSONSchema7;
  output?: JSONSchema7;
};

export type PipelineDefinition = {
  id: string;
  version?: string | number;
  name?: string;
  description?: string;
  entry: string[];
  nodes: PipelineNode[];
  edges: PipelineEdge[];
  contracts?: PipelineContracts;
  tags?: string[];
  metadata?: Record<string, unknown>;
  /** Named queue this pipeline belongs to. Defaults to "default". */
  queue?: string;
  /** Pipeline-level retry policy for automatic run resumption on failure. */
  retry?: RetryPolicy;
};

export type PipelineRegistryEntry = {
  definition: PipelineDefinition;
  mtimeMs: number;
  path: string;
};

export type PipelineRunStatus =
  | "pending"
  | "running"
  | "paused"
  | "errored"
  | "completed";

export type PipelineRunStep = {
  nodeId: string;
  status: "pending" | "running" | "completed" | "errored" | "skipped" | "paused";
  startedAt?: number;
  finishedAt?: number;
  data?: unknown;
  error?: string;
  /** Classification of the error for retry decisions. */
  errorCategory?: ErrorCategory;
  iteration?: number;
};

export type QueueMode = "batch" | "per-item";

/** How a run was initiated. */
export type RunSource = "user" | "schedule" | "background";

/** An item queued for background processing. */
export type BackgroundQueueItem = {
  id: string;
  pipeline: string;
  inputs: Record<string, unknown>;
  priority: number;
  severityWeight: number;
  manualBoost: number;
  createdAt: number;
  status: "pending" | "running" | "completed" | "errored" | "failed";
  retries: number;
  maxRetries: number;
  needsReview: boolean;
};

/** Configuration for the background queue. */
export type BackgroundQueueConfig = {
  enabled: boolean;
  maxRetries: number;
};

/** Configuration for Telegram notifications. */
export type TelegramConfig = {
  botToken: string;
  chatId: string;
};

export type PipelineRunRecord = {
  id: string;
  pipelineId: string;
  parentRunId?: string;
  /** How this run was initiated. Defaults to 'user'. */
  source?: RunSource;
  /** When this run was created by an enqueue node. */
  taskId?: string;
  /** When this run was created by an enqueue node. */
  queueMode?: QueueMode;
  /** Named queue this run belongs to (from pipeline definition). Defaults to "default". */
  queueName?: string;
  childRunIds: string[];
  status: PipelineRunStatus;
  startedAt: number;
  updatedAt: number;
  inputs: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  cursor?: {
    nextNodeIndex: number;
    context: Record<string, unknown>;
  };
  waitFor?: {
    nodeId: string;
    reason?: string;
    resumeKey?: string;
  };
  steps: PipelineRunStep[];
  error?: string;
  /** Number of times this run has been retried. */
  retryCount?: number;
  /** Retry policy governing automatic resumption of this run. */
  retryPolicy?: RetryPolicy;
  /** Optional webhook URL to receive push notifications on run completion/error. */
  webhook_url?: string;
};
