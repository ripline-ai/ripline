import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpToolContext } from "./tools.js";
import {
  handleListPipelines,
  handleRunPipeline,
  handleGetRun,
  handleGetRunLogs,
  handleListRuns,
  handleResumeRun,
} from "./tools.js";

const TOOL_DEFINITIONS = [
  {
    name: "list_pipelines",
    description: "List all available Ripline pipelines",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "run_pipeline",
    description: "Trigger a Ripline pipeline run. Returns immediately with a runId.",
    inputSchema: {
      type: "object",
      required: ["pipeline_id"],
      properties: {
        pipeline_id: { type: "string", description: "Pipeline ID to run" },
        inputs: { type: "object", description: "Input payload for the pipeline entry node" },
      },
    },
  },
  {
    name: "get_run",
    description: "Get the full status and output of a pipeline run by runId",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
      },
    },
  },
  {
    name: "get_run_logs",
    description: "Get the log output for a pipeline run",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
      },
    },
  },
  {
    name: "list_runs",
    description: "List recent pipeline runs, optionally filtered by pipeline_id or status",
    inputSchema: {
      type: "object",
      properties: {
        pipeline_id: { type: "string" },
        status: { type: "string", enum: ["pending", "running", "paused", "errored", "completed"] },
        limit: { type: "number", default: 20 },
      },
    },
  },
  {
    name: "resume_run",
    description: "Re-queue an errored or paused run from where it stopped",
    inputSchema: {
      type: "object",
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
      },
    },
  },
] as const;

export function createMcpServer(ctx: McpToolContext): Server {
  const server = new Server(
    { name: "ripline", version: "1.0.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    let result: unknown;

    try {
      switch (name) {
        case "list_pipelines":
          result = await handleListPipelines(ctx);
          break;
        case "run_pipeline":
          result = await handleRunPipeline(ctx, args);
          break;
        case "get_run":
          result = await handleGetRun(ctx, args);
          break;
        case "get_run_logs":
          result = await handleGetRunLogs(ctx, args);
          break;
        case "list_runs":
          result = await handleListRuns(ctx, args);
          break;
        case "resume_run":
          result = await handleResumeRun(ctx, args);
          break;
        default:
          return {
            content: [{ type: "text", text: JSON.stringify({ error: `unknown tool: ${name}` }) }],
            isError: true,
          };
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }) }],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
}
