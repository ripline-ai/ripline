import { z } from "zod";
import type {
  LoopBody,
  PipelineDefinition,
  PipelineNode,
  SwitchNode,
} from "./types.js";

const jsonSchema = z.record(z.string(), z.any());

const baseNode = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  contracts: z
    .object({
      input: jsonSchema.optional(),
      output: jsonSchema.optional(),
    })
    .optional(),
  retry: z
    .object({
      maxAttempts: z.number().int().min(1),
      delayMs: z.number().int().min(0).optional(),
    })
    .optional(),
});

const literalNode = baseNode.extend({
  type: z.literal("data"),
  value: z.any(),
});

const inputNode = baseNode.extend({
  type: z.literal("input"),
  path: z.string().optional(),
});

const transformNode = baseNode.extend({
  type: z.literal("transform"),
  expression: z.string().min(1),
  assigns: z.string().optional(),
});

const mcpStdioServerSchema = z.object({
  type: z.literal("stdio").optional(),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});

const mcpSseServerSchema = z.object({
  type: z.literal("sse"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpHttpServerSchema = z.object({
  type: z.literal("http"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
});

const mcpServerConfigSchema = z.union([mcpStdioServerSchema, mcpSseServerSchema, mcpHttpServerSchema]);

const skillDefinitionSchema = z.intersection(
  mcpServerConfigSchema,
  z.object({ description: z.string().optional() })
);

export const skillsRegistrySchema = z.record(z.string(), skillDefinitionSchema);

const agentNode = baseNode.extend({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  /** When true or omitted, use a new session per run (context isolation). When false, use run-level sessionId for continuity. */
  resetSession: z.boolean().optional(),
  channel: z.string().optional(),
  deliver: z.boolean().optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  runner: z.literal("claude-code").optional(),
  mode: z.enum(["plan", "execute"]).optional(),
  cwd: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  /** When runner is claude-code: model to use (e.g. claude-sonnet-4-6). Omit to use config or CLI default. */
  model: z.string().min(1).optional(),
  /** Node-level skill names (merged with agent-definition skills; node wins). */
  skills: z.array(z.string()).optional(),
  /** Node-level explicit MCP server configs (merged on top of agent-definition mcpServers; node wins). */
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
});

const runPipelineNode = baseNode.extend({
  type: z.literal("run_pipeline"),
  pipelineId: z.string().min(1),
  inputMapping: z.record(z.string(), z.string()).optional(),
  mode: z.enum(["child", "inline"]).optional(),
});

const loopBodySchema = z
  .object({
    pipelineId: z.string().optional(),
    entry: z.array(z.string()).optional(),
    nodes: z.lazy(() => z.array(nodeSchema)).optional(),
    edges: z
      .array(
        z.object({
          from: z.object({ node: z.string(), port: z.string().optional() }),
          to: z.object({ node: z.string(), port: z.string().optional() }),
          id: z.string().optional(),
          when: z.string().optional(),
        }),
      )
      .optional(),
  })
  .partial()
  .superRefine((value, ctx) => {
    if (!value.pipelineId && !value.nodes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "loop body requires either pipelineId or inline nodes",
      });
    }
  }) as z.ZodType<LoopBody>;

const loopNode = baseNode.extend({
  type: z.literal("loop"),
  collection: z.string().min(1),
  itemVar: z.string().optional(),
  indexVar: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  exitCondition: z.string().optional(),
  body: loopBodySchema,
  /** Execution mode: 'sequential' (default) or 'parallel' (dependency-wave). */
  mode: z.enum(["sequential", "parallel"]).optional(),
  /** Max concurrent items in parallel mode. */
  maxConcurrency: z.number().int().positive().optional(),
  /** Field on each collection item holding dependency IDs. Default 'dependsOn'. */
  dependsOnField: z.string().optional(),
});

const switchNode = baseNode.extend({
  type: z.literal("switch"),
  expression: z.string().min(1),
  cases: z.record(z.string().min(1), z.object({}).passthrough()),
  default: z.string().optional(),
});

const checkpointNode = baseNode.extend({
  type: z.literal("checkpoint"),
  reason: z.string().optional(),
  resumeKey: z.string().optional(),
});

const outputNode = baseNode.extend({
  type: z.literal("output"),
  path: z.string().optional(),
  source: z.string().optional(),
  merge: z.boolean().optional(),
});

const enqueueNode = baseNode.extend({
  type: z.literal("enqueue"),
  pipelineId: z.string().min(1),
  tasksSource: z.string().optional(),
  mode: z.enum(["batch", "per-item"]).optional(),
});

const collectChildrenNode = baseNode.extend({
  type: z.literal("collect_children"),
});

const shellNode = baseNode.extend({
  type: z.literal("shell"),
  command: z.string(),
  cwd: z.string().optional(),
  assigns: z.string().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  failOnNonZero: z.boolean().optional(),
});

const nodeSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    literalNode,
    inputNode,
    transformNode,
    agentNode,
    runPipelineNode,
    loopNode,
    switchNode,
    checkpointNode,
    outputNode,
    enqueueNode,
    collectChildrenNode,
    shellNode,
  ])
) as z.ZodType<PipelineNode>;

const claudeCodeAgentDefinitionSchema = z.object({
  runner: z.literal("claude-code"),
  systemPrompt: z.string().optional(),
  model: z.string().min(1).optional(),
  mode: z.enum(["plan", "execute"]).optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  cwd: z.string().optional(),
  dangerouslySkipPermissions: z.boolean().optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), mcpServerConfigSchema).optional(),
  skillsFile: z.string().optional(),
});

const externalAgentDefinitionSchema = z.object({
  runner: z.literal("openclaw").optional(),
});

export const agentDefinitionSchema = z.union([
  claudeCodeAgentDefinitionSchema,
  externalAgentDefinitionSchema,
]);

const edgeSchema = z.object({
  id: z.string().optional(),
  from: z.object({ node: z.string().min(1), port: z.string().optional() }),
  to: z.object({ node: z.string().min(1), port: z.string().optional() }),
  when: z.string().optional(),
  default: z.boolean().optional(),
  on_error: z.boolean().optional(),
});

const retryPolicySchema = z.object({
  maxAttempts: z.number().int().min(1),
  backoffMs: z.number().int().min(0),
  backoffMultiplier: z.number().min(1).optional(),
  retryableCategories: z.array(z.enum(["transient", "permanent", "unknown"])).optional(),
});

export const pipelineDefinitionSchema = z
  .object({
    id: z.string().min(1),
    version: z.union([z.string(), z.number()]).optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    entry: z.array(z.string().min(1)).min(1),
    nodes: z.array(nodeSchema).min(1),
    edges: z.array(edgeSchema).min(1),
    contracts: z
      .object({
        input: jsonSchema.optional(),
        output: jsonSchema.optional(),
      })
      .optional(),
    tags: z.array(z.string()).optional(),
    queue: z.string().optional(),
    metadata: z.record(z.string(), z.any()).optional(),
    retry: retryPolicySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const nodeIds = new Set<string>();
    const duplicates = new Set<string>();
    for (const node of value.nodes) {
      if (nodeIds.has(node.id)) {
        duplicates.add(node.id);
      }
      nodeIds.add(node.id);
    }
    for (const id of duplicates) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate node id: ${id}`,
        path: ["nodes"],
      });
    }
    for (const entryNode of value.entry) {
      if (!nodeIds.has(entryNode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entry node not found: ${entryNode}`,
          path: ["entry"],
        });
      }
    }
    // Build a map of node id → node for lookups.
    const nodeMap = new Map(value.nodes.map((n) => [n.id, n]));

    const defaultEdgeSources = new Set<string>();
    const onErrorEdgeSources = new Set<string>();

    for (const [i, edge] of value.edges.entries()) {
      if (!nodeIds.has(edge.from.node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge.from missing node ${edge.from.node}`,
        });
      }
      if (!nodeIds.has(edge.to.node)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge.to missing node ${edge.to.node}`,
        });
      }

      // Validate that from.port on edges from switch nodes matches a declared case key.
      const sourceNode = nodeMap.get(edge.from.node);
      if (sourceNode && sourceNode.type === "switch" && edge.from.port) {
        const caseKeys = Object.keys((sourceNode as SwitchNode).cases);
        if (!caseKeys.includes(edge.from.port)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `edge from switch node "${edge.from.node}" has port "${edge.from.port}" which does not match any case key (${caseKeys.join(", ")})`,
            path: ["edges", i, "from", "port"],
          });
        }
      }

      // Validate at most one default edge per source node.
      if (edge.default) {
        if (defaultEdgeSources.has(edge.from.node)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `multiple default edges from node "${edge.from.node}"`,
            path: ["edges", i],
          });
        }
        defaultEdgeSources.add(edge.from.node);
      }

      // Validate at most one on_error edge per source node.
      if (edge.on_error) {
        if (onErrorEdgeSources.has(edge.from.node)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `multiple on_error edges from node "${edge.from.node}"`,
            path: ["edges", i],
          });
        }
        onErrorEdgeSources.add(edge.from.node);
      }
    }
  }) as z.ZodType<PipelineDefinition>;
