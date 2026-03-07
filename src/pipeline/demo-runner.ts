import type { PipelineDefinition, PipelineNode, PipelineEdge } from "../types";

export class PipelineRunner {
  constructor(private readonly definition: PipelineDefinition) {}

  run(): void {
    const order = this.topologicalOrder();
    console.log(`Running pipeline ${this.definition.id} (${order.length} nodes)`);
    for (const nodeId of order) {
      const node = this.definition.nodes.find((n) => n.id === nodeId);
      if (!node) {
        throw new Error(`Node ${nodeId} not found`);
      }
      this.executeNode(node);
    }
  }

  private executeNode(node: PipelineNode) {
    const base = `[${node.type}] ${node.id}`;
    switch (node.type) {
      case "agent":
        console.log(`${base} → agent=${node.agentId ?? "unknown"}`);
        console.log(`  prompt: ${node.prompt.split("\n")[0]}…`);
        break;
      case "input":
        console.log(`${base} → waiting for upstream signal`);
        break;
      case "output":
        console.log(`${base} → storing result at ${node.path ?? "payload"}`);
        break;
      case "transform":
        console.log(`${base} → expression=${node.expression}`);
        break;
      default:
        console.log(base);
        break;
    }
  }

  private topologicalOrder(): string[] {
    const indegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const node of this.definition.nodes) {
      indegree.set(node.id, 0);
      adjacency.set(node.id, []);
    }

    for (const edge of this.definition.edges ?? []) {
      const from = edge.from.node;
      const to = edge.to.node;
      adjacency.get(from)?.push(to);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }

    const queue: string[] = []; // simple BFS queue
    for (const entry of this.definition.entry) {
      queue.push(entry);
    }

    const order: string[] = [];
    while (queue.length) {
      const current = queue.shift()!;
      order.push(current);
      for (const neighbor of adjacency.get(current) ?? []) {
        const nextDegree = (indegree.get(neighbor) ?? 0) - 1;
        indegree.set(neighbor, nextDegree);
        if (nextDegree === 0) {
          queue.push(neighbor);
        }
      }
    }

    return order;
  }
}

export const riplineDefinition: PipelineDefinition = {
  id: "ripline-area-owner",
  name: "Ripline area owner workflow",
  entry: ["area-owner-intake"],
  nodes: [
    {
      id: "area-owner-intake",
      type: "input",
      description: "Signals from the area owner (opportunities, issues, backlog)"
    },
    {
      id: "break-down",
      type: "agent",
      agentId: "vector",
      prompt: "Break the signals into discrete features with acceptance criteria."
    },
    {
      id: "design-spec",
      type: "agent",
      agentId: "nova",
      prompt: "Describe UX/data requirements for each feature."
    },
    {
      id: "engineering-plan",
      type: "agent",
      agentId: "vector",
      prompt: "Produce implementation plan + owners for each feature."
    },
    {
      id: "implementation-queue",
      type: "output",
      path: "ripline/backlog",
      source: "engineering-plan"
    }
  ],
  edges: [
    edge("area-owner-intake", "break-down"),
    edge("break-down", "design-spec"),
    edge("design-spec", "engineering-plan"),
    edge("engineering-plan", "implementation-queue")
  ]
};

function edge(from: string, to: string): PipelineEdge {
  return { from: { node: from }, to: { node: to } };
}

export function runRiplineAreaOwnerExample() {
  const runner = new PipelineRunner(riplineDefinition);
  runner.run();
}
