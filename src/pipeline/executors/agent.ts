import fs from "node:fs";
import path from "node:path";
import type { AgentNode, AgentDefinition, ClaudeCodeAgentDefinition, McpServerConfig, SkillsRegistry } from "../../types.js";
import type { Logger } from "../../log.js";
import { interpolateTemplate } from "../../expression.js";
import type { ExecutorContext, NodeResult } from "./types.js";
import { detectHttpError, HttpResponseError } from "../../lib/http-response-guard.js";
import { normalizeContainerConfig, DEFAULT_BUILD_IMAGE } from "../../run-container-pool.js";

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

function resolveSkillTextContent(skillNames: string[], skillsDir: string | undefined): string | null {
  if (!skillsDir || skillNames.length === 0) return null;
  const parts: string[] = [];
  for (const name of skillNames) {
    const filePath = path.join(skillsDir, `${name}.md`);
    try {
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) parts.push(content);
    } catch { /* skill has no .md file — that's fine */ }
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

const interpolationContext = (context: ExecutorContext) => ({
  inputs: context.inputs,
  ...context.inputs,
  ...context.artifacts,
  env: context.env,
  run: { inputs: context.inputs },
});

export async function executeAgent(
  node: AgentNode,
  context: ExecutorContext,
  runners: { agentRunner?: AgentRunner; claudeCodeRunner?: AgentRunner },
  agentDefinitions?: Record<string, AgentDefinition>,
  skillsRegistry?: SkillsRegistry,
  skillsDir?: string
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

  // Inject skills context: per-skill .md files from skillsDir + SKILLS.md/skillsFile from cwd
  if (claudeCodeDef) {
    const allSkillNames = [...(claudeCodeDef.skills ?? []), ...(node.skills ?? [])];
    const skillTextContent = resolveSkillTextContent(allSkillNames, skillsDir);
    const cwdSkillsContent = resolveSkillsContent(claudeCodeDef.skillsFile, resolvedCwd);
    const combined = [skillTextContent, cwdSkillsContent].filter(Boolean).join("\n\n");
    if (combined) {
      prompt = `<skills>\n${combined.trim()}\n</skills>\n\n${prompt}`;
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

  // Resolve MCP servers (lowest → highest precedence):
  // registry-resolved agent skills < agent mcpServers < registry-resolved node skills < node mcpServers
  const effectiveMcpServers = (() => {
    if (!useClaudeCode) return undefined;
    const resolveSkillNames = (names: string[] | undefined): Record<string, McpServerConfig> => {
      if (!names || !skillsRegistry) return {};
      const out: Record<string, McpServerConfig> = {};
      for (const name of names) {
        const skill = skillsRegistry[name];
        if (skill) {
          const { description: _desc, ...mcpConfig } = skill as McpServerConfig & { description?: string };
          out[name] = mcpConfig;
        }
      }
      return out;
    };
    const merged = {
      ...resolveSkillNames(claudeCodeDef?.skills),
      ...(claudeCodeDef?.mcpServers ?? {}),
      ...resolveSkillNames(node.skills),
      ...(node.mcpServers ?? {}),
    };
    return Object.keys(merged).length > 0 ? merged : undefined;
  })();

  const resetSession = node.resetSession ?? true;

  // --- Container routing ---
  // When a containerPool is present AND the node has a container config (or the pool
  // already holds a run-level container), exec the claude CLI inside the container
  // rather than calling the in-process runner.
  const useContainer =
    context.containerPool !== undefined &&
    context.runId !== undefined &&
    (node.container !== undefined || context.containerPool.hasContainer(context.runId));

  let result: AgentResult;
  if (useContainer && context.containerPool && context.runId) {
    result = await runAgentInContainer(
      prompt,
      context.containerPool,
      context.runId,
      node.container,
      resolvedCwd,
      effectiveModel,
      effectiveDangerously,
      effectiveMode,
      effectiveTimeout,
      context.defaultContainerImage,
    );
  } else {
    result = await runner({
      agentId,
      prompt,
      resetSession,
      // Pass sessionId when available in context (resume scenarios always carry session from cursor,
      // and resetSession:false nodes use it for shared-conversation continuity).
      ...(context.sessionId !== undefined && { sessionId: context.sessionId }),
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
  }

  // AC1: Check agent output for HTTP error responses (e.g. rate-limit 429).
  // curl exits 0 even on 4xx/5xx, so the agent "succeeds" but the output is an
  // error payload rather than valid data. Detect and throw so the runner's
  // node-level retry (AC2) can re-attempt with backoff.
  const httpError = detectHttpError(result.text);
  if (httpError) {
    const logCtx = [
      `step=${node.id}`,
      `http_status=${httpError.statusCode}`,
      ...(context.runId ? [`run_id=${context.runId}`] : []),
      ...(httpError.retryAfterSeconds !== undefined ? [`retry_after=${httpError.retryAfterSeconds}s`] : []),
    ].join(" ");
    console.error(`[agent] HTTP error detected in output: ${logCtx} — ${httpError.message.slice(0, 200)}`);
    throw new HttpResponseError(httpError);
  }

  const value = {
    text: result.text,
    tokenUsage: result.tokenUsage,
  };
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}

/**
 * Run a Claude Code agent invocation inside the run-level persistent container.
 * Builds a `claude -p <prompt>` CLI command and execs it via the container pool.
 */
async function runAgentInContainer(
  prompt: string,
  pool: import("../../run-container-pool.js").RunContainerPool,
  runId: string,
  nodeContainer: import("../../types.js").NodeContainerConfig | undefined,
  workdir: string | undefined,
  model: string | undefined,
  dangerouslySkipPermissions: boolean | undefined,
  mode: "plan" | "execute" | undefined,
  timeoutSeconds: number | undefined,
  defaultImage?: string,
): Promise<AgentResult> {
  // Resolve node-level container config for extra env / workdir override
  const resolved = nodeContainer !== undefined
    ? normalizeContainerConfig(nodeContainer, {
        image: defaultImage ?? DEFAULT_BUILD_IMAGE,
        ...(workdir !== undefined && { workdir }),
      })
    : undefined;

  const effectiveWorkdir = resolved?.workdir ?? workdir;
  const env = resolved?.env;

  // Build the claude CLI invocation
  const args: string[] = ["claude", "-p", prompt, "--output-format", "text"];

  if (dangerouslySkipPermissions) {
    args.push("--dangerously-skip-permissions");
  }

  if (model) {
    args.push("--model", model);
  }

  if (mode === "plan") {
    // Read-only: no write/edit tools
    args.push("--disallowed-tools", "Write,Edit,MultiEdit");
  }

  if (timeoutSeconds !== undefined) {
    args.push("--timeout", String(timeoutSeconds));
  }

  const result = await pool.exec(runId, args, env, effectiveWorkdir);

  if (result.exitCode !== 0) {
    throw new Error(
      `agent container exec failed with exit code ${result.exitCode}: ${(result.stderr || result.stdout).slice(0, 500)}`,
    );
  }

  return { text: result.stdout.trim() };
}
