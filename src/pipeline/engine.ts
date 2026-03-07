export type PipelineNodeType =
  | "intake"
  | "design_run"
  | "builder_run"
  | "kanban_update"
  | "notify"
  | "custom";

export type PipelineNode = {
  id: string;
  type: PipelineNodeType;
  config: Record<string, unknown>;
  next?: string[];
};

export type PipelineGraph = {
  id: string;
  name: string;
  nodes: PipelineNode[];
  entry: string;
};

export type PipelineContext = {
  runId: string;
  data: Record<string, unknown>;
};

export class PipelineEngine {
  constructor(private readonly graph: PipelineGraph) {}

  async run(context: PipelineContext) {
    let currentNode = this.graph.entry;
    const visited = new Set<string>();

    while (currentNode) {
      if (visited.has(currentNode)) {
        throw new Error(`Detected loop at node ${currentNode}`);
      }
      visited.add(currentNode);

      const node = this.graph.nodes.find((n) => n.id === currentNode);
      if (!node) {
        throw new Error(`Node ${currentNode} not found`);
      }

      await this.executeNode(node, context);
      currentNode = node.next?.[0] ?? "";
    }
  }

  private async executeNode(node: PipelineNode, context: PipelineContext) {
    // TODO: wire up concrete node executors (intake, sessions_spawn wrappers, etc.)
    console.log(`[pipeline:${context.runId}] executing ${node.type} (${node.id})`);
  }
}
