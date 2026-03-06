import { z } from "zod";
import type { PipelineDefinition } from "./types.js";

const jsonSchema = z.record(z.any());

const baseNode = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  metadata: z.record(z.any()).optional(),
  contracts: z
    .object({
      input: jsonSchema.optional(),
      output: jsonSchema.optional(),
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

const agentNode = baseNode.extend({
  type: z.literal("agent"),
  prompt: z.string().min(1),
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  channel: z.string().optional(),
  deliver: z.boolean().optional(),
  thinking: z.enum(["off", "minimal", "low", "medium", "high"]).optional(),
  timeoutSeconds: z.number().int().positive().optional(),
});

const runPipelineNode = baseNode.extend({
  type: z.literal("run_pipeline"),
  pipelineId: z.string().min(1),
  inputMapping: z.record(z.string()).optional(),
  mode: z.enum(["child", "inline"]).optional(),
});

const loopBody = z
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
  });

const loopNode = baseNode.extend({
  type: z.literal("loop"),
  collection: z.string().min(1),
  itemVar: z.string().optional(),
  indexVar: z.string().optional(),
  maxIterations: z.number().int().positive().optional(),
  exitCondition: z.string().optional(),
  body: loopBody,
});

const checkpointNode = baseNode.extend({
  type: z.literal("checkpoint"),
  reason: z.string().optional(),
  resumeKey: z.string().optional(),
});

const outputNode = baseNode.extend({
  type: z.literal("output"),
  path: z.string().optional(),
  merge: z.boolean().optional(),
});

const nodeSchema = z.discriminatedUnion("type", [
  literalNode,
  inputNode,
  transformNode,
  agentNode,
  runPipelineNode,
  loopNode,
  checkpointNode,
  outputNode,
]);

const edgeSchema = z.object({
  id: z.string().optional(),
  from: z.object({ node: z.string().min(1), port: z.string().optional() }),
  to: z.object({ node: z.string().min(1), port: z.string().optional() }),
  when: z.string().optional(),
});

export const pipelineDefinitionSchema: z.ZodType<PipelineDefinition> = z
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
    metadata: z.record(z.any()).optional(),
  })
  .superRefine((value, ctx) => {
    const nodeIds = new Set(value.nodes.map((node) => node.id));
    for (const entryNode of value.entry) {
      if (!nodeIds.has(entryNode)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `entry node not found: ${entryNode}`,
          path: ["entry"],
        });
      }
    }
    for (const edge of value.edges) {
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
    }
  });
