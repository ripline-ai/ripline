import type { CollectChildrenNode } from "../../types.js";
import type { PipelineRunRecord, PipelineRunStatus } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

export type ChildResult = {
  id: string;
  taskId?: string;
  status: PipelineRunStatus;
  outputs?: Record<string, unknown>;
  error?: string;
};

export type CollectChildrenValue = {
  childResults: ChildResult[];
  summary: { completed: number; errored: number; total: number };
};

export async function executeCollectChildren(
  node: CollectChildrenNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const { runId, store } = context;
  if (!runId || !store) {
    throw new Error("Collect_children node requires runId and store in executor context (run must be a stored run)");
  }

  const record = await store.load(runId);
  if (!record?.childRunIds?.length) {
    const value: CollectChildrenValue = {
      childResults: [],
      summary: { completed: 0, errored: 0, total: 0 },
    };
    context.artifacts[node.id] = value;
    return { artifactKey: node.id, value };
  }

  const childRecords = await Promise.all(
    record.childRunIds.map((id) => store.load(id))
  );

  let completed = 0;
  let errored = 0;
  const childResults: ChildResult[] = childRecords.map((r, i) => {
    const id = record.childRunIds[i]!;
    if (!r) {
      return { id, status: "errored" as const, error: "Run not found" };
    }
    if (r.status === "completed") completed++;
    if (r.status === "errored") errored++;
    const entry: ChildResult = {
      id: r.id,
      status: r.status,
      ...(r.taskId !== undefined && { taskId: r.taskId }),
      ...(r.status === "completed" && r.outputs !== undefined && { outputs: r.outputs }),
      ...(r.status === "errored" && r.error !== undefined && { error: r.error }),
    };
    return entry;
  });

  const value: CollectChildrenValue = {
    childResults,
    summary: { completed, errored, total: childResults.length },
  };
  context.artifacts[node.id] = value;
  return { artifactKey: node.id, value };
}
