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
  defaultProfile?: string;
  /** Only from ~/.ripline/config.json; never from pipeline/profile/input. */
  claudeCode?: { allowDangerouslySkipPermissions?: boolean };
};

export type PipelinePluginConfig = {
  pipelinesDir: string;
  maxConcurrency?: number;
  httpPath?: string;
  httpPort?: number;
  authToken?: string;
  /** Directory for run state (default .ripline/runs). Used by HTTP server. */
  runsDir?: string;
};

export type NodeContract = {
  input?: JSONSchema7;
  output?: JSONSchema7;
};

export type NodeRetryConfig = {
  maxAttempts: number;
  delayMs?: number;
};

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
};

export type LoopBody = {
  pipelineId?: string;
  entry?: string[];
  nodes?: PipelineNode[];
  edges?: PipelineEdge[];
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

export type PipelineNode =
  | LiteralNode
  | InputNode
  | TransformNode
  | AgentNode
  | RunPipelineNode
  | LoopNode
  | CheckpointNode
  | OutputNode
  | EnqueueNode
  | CollectChildrenNode;

export type PipelineEdge = {
  id?: string;
  from: { node: string; port?: string };
  to: { node: string; port?: string };
  when?: string;
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
  iteration?: number;
};

export type QueueMode = "batch" | "per-item";

export type PipelineRunRecord = {
  id: string;
  pipelineId: string;
  parentRunId?: string;
  /** When this run was created by an enqueue node. */
  taskId?: string;
  /** When this run was created by an enqueue node. */
  queueMode?: QueueMode;
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
};
