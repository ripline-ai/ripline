import type { EnqueueNode, TaskItem } from "../../types.js";
import type { ExecutorContext, NodeResult } from "./types.js";

function isTaskItem(x: unknown): x is TaskItem {
  return (
    typeof x === "object" &&
    x !== null &&
    "id" in x &&
    "title" in x &&
    typeof (x as TaskItem).id === "string" &&
    typeof (x as TaskItem).title === "string"
  );
}

function getTasks(artifacts: Record<string, unknown>, tasksSource: string): TaskItem[] {
  const raw = artifacts[tasksSource];
  if (!Array.isArray(raw)) {
    throw new Error(`Enqueue node requires artifact "${tasksSource}" to be an array of tasks (id, title, detail?, priority?)`);
  }
  for (let i = 0; i < raw.length; i++) {
    if (!isTaskItem(raw[i])) {
      throw new Error(
        `Enqueue node: task at index ${i} must have id and title (got ${JSON.stringify(raw[i])})`
      );
    }
  }
  return raw as TaskItem[];
}

/**
 * Enqueue node: read tasks from an artifact, create pending child run(s), and return
 * childRunIds so the runner can pause the parent until children complete.
 */
export async function executeEnqueue(
  node: EnqueueNode,
  context: ExecutorContext
): Promise<NodeResult> {
  const { runId, queue } = context;
  if (!runId || !queue) {
    throw new Error("Enqueue node requires runId and queue in executor context (run must be a stored run with queue available)");
  }

  const tasksSource = node.tasksSource ?? "tasks";
  const tasks = getTasks(context.artifacts, tasksSource);
  const mode = node.mode ?? "per-item";
  const pipelineId = node.pipelineId;
  const childRunIds: string[] = [];

  if (mode === "batch") {
    const runIdOut = await queue.enqueue(
      pipelineId,
      { tasks },
      { parentRunId: runId, queueMode: "batch" }
    );
    childRunIds.push(runIdOut as string);
  } else {
    for (const task of tasks) {
      const runIdOut = await queue.enqueue(
        pipelineId,
        { task },
        { parentRunId: runId, taskId: task.id, queueMode: "per-item" }
      );
      childRunIds.push(runIdOut as string);
    }
  }

  const value = { enqueued: childRunIds };
  context.artifacts[node.id] = value;
  return {
    artifactKey: node.id,
    value,
    childRunIds,
  };
}
