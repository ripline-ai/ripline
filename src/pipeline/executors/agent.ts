import fs from "node:fs";
import path from "node:path";
import type { AgentNode, AgentDefinition, ClaudeCodeAgentDefinition, McpServerConfig, SkillsRegistry } from "../../types.js";
import type { Logger } from "../../log.js";
import { interpolateTemplate } from "../../expression.js";
import type { ExecutorContext, NodeResult } from "./types.js";

/** Result of a single agent (sessions_spawn) call. */
export type AgentResult = {
  text: string;
  tokenUsage?: { input?: number; output?: number };
};

/** Injectable runner for agent nodes (e.g. OpenClaw sessions_spawn). */
export type AgentRunner = (params: {
  agentId: string;
  prompt: string;
  /** When true or omitted, use a new session (context isolation). When false, use sessionId for continuity. */
  resetSession?: boolean;
  /** Shared run-level session when resetSession is false. */
  sessionId?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
  timeoutSeconds?: number;
  /** Set when node has runner: claude-code; runners that don't use it ignore. */
  runner?: "claude-code";
  mode?: "plan" | "execute";
  cwd?: string;
  /** When runner is claude-code: allow bypass for this node when global bypass is enabled. Omit/false = dontAsk. */
  dangerouslySkipPermissions?: boolean;
  /** When runner is claude-code: model to use (e.g. claude-sonnet-4-6). Omit to use config or CLI default. */
  model?: string;
  /** MCP servers to attach for this run (claude-code runner only). */
  mcpServers?: Record<string, McpServerConfig>;
  /** Current run ID (set when running a stored run); used for run-scoped logging. */
  runId?: string;
  /** Current node ID; used for run-scoped logging. */
  nodeId?: string;
  /** Run-scoped logger (child with runId/nodeId). When set, logs go here in addition to or instead of stderr. */
  log?: Logger;
}) => Promise<AgentResult>;

function resolveSkillsContent(skillsFile: string | undefined, effectiveCwd: string | undefined): string | null {
  if (skillsFile) {
    const resolved = path.isAbsolute(skillsFile)
      ? skillsFile
      : effectiveCwd
        ? path.join(effectiveCwd, skillsFile)
        : skillsFile;
    try { return fs.readFileSync(resolved, "utf-8"); } catch { return null; }
  }
  if (effectiveCwd) {
    try { return fs.readFileSync(path.join(effectiveCwd, "SKILLS.md"), "utf-8"); } catch { return null; }
  }
  return null;
}

const interpolationContext = (context: ExecutorContext) => ({
  inputs: context.inputs,
  ...context.inputs,
  ...context.artifacts,
  env: context.env,
});

export async function executeAgent(
  node: AgentNode,
  context: ExecutorContext,
  runners: { agentRunner?: AgentRunner; claudeCodeRunner?: AgentRunner },
  agentDefinitions?: Record<string, AgentDefinition>,
  skillsRegistry?: SkillsRegistry
): Promise<NodeResult> {
  const agentId = node.agentId ?? "default";
  const agentDef = agentDefinitions?.[agentId];
  const claudeCodeDef =
    agentDef && "runner" in agentDef && agentDef.runner === "claude-code"
      ? (agentDef as ClaudeCodeAgentDefinition)
      : undefined;

  // Determine which runner to use: node.runner takes precedence, then agent definition runner
  const useClaudeCode = node.runner === "claude-code" || claudeCodeDef !== undefined;
  const runner = useClaudeCode
    ? (runners.claudeCodeRunner ?? runners.agentRunner)
    : runners.agentRunner;

  if (!runner) {
    const msg = useClaudeCode
      ? "Agent node requires claude-code runner (use standalone Ripline with Claude Code config; not available inside OpenClaw)"
      : "Agent node requires agentRunner in runner options (e.g. OpenClaw sessions_spawn)";
    throw new Error(msg);
  }

  const ctx = interpolationContext(context);
  let prompt = interpolateTemplate(node.prompt, ctx);

  // Merge fields: node wins over agent definition (cwd needed for SKILLS.md discovery)
  const resolvedCwd = (() => {
    if (node.cwd !== undefined && node.cwd.trim() !== "") return interpolateTemplate(node.cwd.trim(), ctx);
    if (claudeCodeDef?.cwd !== undefined && claudeCodeDef.cwd.trim() !== "") return claudeCodeDef.cwd.trim();
    return undefined;
  })();

  // Prepend systemPrompt from agent definition when present
  if (claudeCodeDef?.systemPrompt) {
    prompt = `${claudeCodeDef.systemPrompt}\n\n${prompt}`;
  }

  // Inject SKILLS.md context when present (explicit skillsFile or auto-discovered from cwd)
  if (claudeCodeDef) {
    const skillsContent = resolveSkillsContent(claudeCodeDef.skillsFile, resolvedCwd);
    if (skillsContent) {
      prompt = `<skills>\n${skillsContent.trim()}\n</skills>\n\n${prompt}`;
    }
  }

  if (node.contracts?.output && typeof node.contracts.output === "object") {
    const schemaBlock = `\n\nRespond with a single JSON object only (no markdown, code fences, or explanation). Your response must conform to this schema:\n\`\`\`json\n${JSON.stringify(node.contracts.output, null, 2)}\n\`\`\``;
    prompt = prompt + schemaBlock;
  }

  const effectiveModel =
    (node.model !== undefined && node.model.trim() !== "" ? node.model.trim() : undefined) ??
    claudeCodeDef?.model;
  const effectiveMode = node.mode ?? claudeCodeDef?.mode;
  const effectiveThinking = node.thinking ?? claudeCodeDef?.thinking;
  const effectiveTimeout = node.timeoutSeconds ?? claudeCodeDef?.timeoutSeconds;
  const effectiveDangerously = node.dangerouslySkipPermissions ?? claudeCodeDef?.dangerouslySkipPermissions;

  // Resolve MCP servers: registry-resolved skills < explicit mcpServers (explicit wins)
  const effectiveMcpServers = (() => {
    if (!claudeCodeDef) return undefined;
    const fromSkills: Record<string, McpServerConfig> = {};
    if (claudeCodeDef.skills && skillsRegistry) {
      for (const skillName of claudeCodeDef.skills) {
        const skill = skillsRegistry[skillName];
        if (skill) {
          const { description: _desc, ...mcpConfig } = skill as McpServerConfig & { description?: string };
          fromSkills[skillName] = mcpConfig;
        }
      }
    }
    const merged = { ...fromSkills, ...(claudeCodeDef.mcpServers ?? {}) };
    return Object.keys(merged).length > 0 ? merged : undefined;
  })();

  const resetSession = node.resetSession ?? true;
  const result = await runner({
    agentId,
    prompt,
    resetSession,
    ...(resetSession === false && context.sessionId !== undefined && { sessionId: context.sessionId }),
    ...(effectiveThinking !== undefined && { thinking: effectiveThinking }),
    ...(effectiveTimeout !== undefined && { timeoutSeconds: effectiveTimeout }),
    ...(useClaudeCode && { runner: "claude-code" }),
    ...(effectiveMode !== undefined && { mode: effectiveMode }),
    ...(resolvedCwd !== undefined && { cwd: resolvedCwd }),
    ...(effectiveDangerously !== undefined && { dangerouslySkipPermissions: effectiveDangerously }),
    ...(effectiveModel !== undefined && { model: effectiveModel }),
    ...(effectiveMcpServers !== undefined && { mcpServers: effectiveMcpServers }),
    ...(context.runId !== undefined && { runId: context.runId, nodeId: node.id }),
    ...(context.log !== undefined && { log: context.log }),
  });

  const value = {
    text: result.text,
    tokenUsage: result.tokenUsage,
  };
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
