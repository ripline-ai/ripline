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

/** User-level container build configuration (from ~/.ripline/config.json). */
export type ContainerBuildUserConfig = {
  /** Enable container-based builds. Default false. */
  enabled?: boolean;
  /** Absolute path to the host git repository (auto-detected from cwd if omitted). */
  repoPath?: string;
  /** Target branch to merge into (e.g. "main"). Default "main". */
  targetBranch?: string;
  /** Docker image to use for builds. Default "ripline-builder:latest". */
  buildImage?: string;
  /** Shell command to run the project test suite during promote. Default "npm test". */
  testCommand?: string;
  /** Path on host to mount as secrets inside the container. */
  secretsMountPath?: string;
  /** Timeout in ms for the container. Default 600_000 (10 min). */
  containerTimeoutMs?: number;
};

export type RiplineUserConfig = {
  pipelineDir?: string;
  profileDir?: string;
  skillsDir?: string;
  defaultProfile?: string;
  /** Only from ~/.ripline/config.json; never from pipeline/profile/input. */
  claudeCode?: { allowDangerouslySkipPermissions?: boolean };
  /** Only from ~/.ripline/config.json; never from pipeline/profile/input. */
  codex?: { allowDangerouslySkipPermissions?: boolean };
  /** Background queue configuration. */
  backgroundQueue?: BackgroundQueueConfig;
  /** Telegram notification configuration. */
  telegram?: TelegramConfig;
  /** Per-queue configuration (concurrency + resource limits). e.g. { build: { concurrency: 3 } } */
  queues?: Record<string, QueueConfig>;
  /** Container build configuration. When enabled, scheduler attempts container-based execution. */
  containerBuild?: ContainerBuildUserConfig;
};

export type PipelinePluginConfig = {
  pipelinesDir: string;
  maxConcurrency?: number;
  httpPath?: string;
  httpPort?: number;
  authToken?: string;
  /** Directory for run state (default .ripline/runs). Used by HTTP server. */
  runsDir?: string;
  /** File path for the background queue YAML store. */
  queueFilePath?: string;
  /** Per-queue configuration (concurrency + resource limits). e.g. { build: { concurrency: 3, resourceLimits: { cpus: "1", memory: "2g" } } } */
  queues?: Record<string, QueueConfig>;
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

export type BuiltinAgentRunner = "claude-code" | "codex";

export type BuiltinAgentDefinition = {
  runner: BuiltinAgentRunner;
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

/** An agent with no special Ripline config (e.g. an external agent whose definition lives outside Ripline). */
export type ExternalAgentDefinition = {
  /** Arbitrary runner type string for custom / third-party runners. */
  runner?: string;
};

export type AgentDefinition = BuiltinAgentDefinition | ExternalAgentDefinition;

/**
 * Container configuration for node-level or run-level container execution.
 *
 * `"isolated"` is shorthand for a fresh container per-node using the default build image.
 * An object form allows full control over image, env, volumes, and resource limits.
 *
 * Run-level: set `container` on `PipelineDefinition` — a single container is started at
 * run begin and shared across all nodes that opt in, allowing file/artifact hand-off.
 *
 * Node-level: set `container: "isolated"` on an individual node — that node gets its own
 * fresh container, independent of any run-level container.
 */
export type NodeContainerConfig =
  | "isolated"
  | {
      /** Docker image to use. Defaults to the build image configured in containerBuild. */
      image?: string;
      /** Extra environment variables to inject (merged with run env). */
      env?: Record<string, string>;
      /** Volume mounts as host:container pairs. */
      volumes?: Record<string, string>;
      /** Working directory inside the container. Default "/workspace". */
      workdir?: string;
      /** Timeout in milliseconds. Default 600_000 (10 min). */
      timeoutMs?: number;
      /** Resource limits (CPU, memory). */
      resourceLimits?: ContainerResourceLimits;
    };

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
  /** Runner type for this node (e.g. "claude-code"). When set, the matching runner must be provided in runner options. */
  runner?: string;
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
  /**
   * Container execution mode for this node.
   * "isolated" = fresh container per node using the configured build image.
   * Object form = custom image/env/volumes.
   * When unset, inherits from run-level container config (if any).
   */
  container?: NodeContainerConfig;
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
  /**
   * Container execution mode for this node.
   * "isolated" = fresh container per node using the configured build image.
   * Object form = custom image/env/volumes.
   * false = force host execution even when the run has a container.
   * When unset, inherits from run-level container config (if any).
   */
  container?: NodeContainerConfig | false;
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
  /**
   * Run-level container configuration.
   *
   * When set, a single container is started at the beginning of the run and shared across
   * all nodes that participate in container execution (agent and shell nodes).  This allows
   * steps to hand off files and artifacts through the shared container filesystem.
   *
   * Individual nodes can still override with `container: "isolated"` to get a fresh
   * container for that specific node.
   *
   * Can also be supplied via run inputs as `_container` (object form only) to allow
   * per-run container overrides without modifying the pipeline YAML.
   */
  container?: NodeContainerConfig;
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
  | "completed"
  | "needs-conflict-resolution";

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
  runId?: string;
  retries: number;
  maxRetries: number;
  needsReview: boolean;
};

/** Configuration for the background queue. */
export type BackgroundQueueConfig = {
  enabled: boolean;
  maxRetries: number;
};

/** Resource limits applied to each build container. */
export type ContainerResourceLimits = {
  /** CPU limit (e.g. "1.5" for 1.5 cores, "0.5" for half a core). Maps to Docker --cpus. */
  cpus?: string;
  /** Memory limit (e.g. "512m", "2g"). Maps to Docker --memory. */
  memory?: string;
};

/** Per-queue configuration with concurrency and optional resource limits. */
export type QueueConfig = {
  /** Maximum number of concurrent jobs for this queue. Default 1. */
  concurrency: number;
  /** Resource limits applied to containers spawned by this queue. */
  resourceLimits?: ContainerResourceLimits;
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
  /** Absolute path to the container log file (set when container-based execution is used). */
  containerLogFile?: string;
  /** Feature branch created for container-based builds (e.g. "build/{runId}"). */
  featureBranch?: string;
  /** Host process currently responsible for advancing this run while it is in `running`. */
  ownerPid?: number;
};
