import { describe, expect, it } from "vitest";
import type { OutputNode } from "../../src/types.js";
import { executeOutput } from "../../src/pipeline/executors/output.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";

describe("Output executor", () => {
  it("writes artifact to context.outputs using node.path when set", async () => {
    const node: OutputNode = {
      id: "implementation-queue",
      type: "output",
      path: "ripline/backlog",
    };
    const backlog = { features: ["A", "B"], plan: "design first" };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { "engineering-plan": { plan: "design first" }, "implementation-queue": backlog },
      env: {},
      outputs: {},
    };

    const result = await executeOutput(node, context);

    expect(result.artifactKey).toBe("ripline/backlog");
    expect(result.value).toEqual(backlog);
    expect(context.outputs["ripline/backlog"]).toEqual(backlog);
  });

  it("writes to node.id when path is absent", async () => {
    const node: OutputNode = { id: "out1", type: "output" };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { out1: { x: 1 } },
      env: {},
      outputs: {},
    };

    const result = await executeOutput(node, context);

    expect(result.artifactKey).toBe("out1");
    expect(context.outputs["out1"]).toEqual({ x: 1 });
  });

  it("writes from source artifact when source is set", async () => {
    const node: OutputNode = { id: "out2", type: "output", source: "upstream" };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { upstream: { data: "from upstream" } },
      env: {},
      outputs: {},
    };

    const result = await executeOutput(node, context);

    expect(result.artifactKey).toBe("out2");
    expect(context.outputs["out2"]).toEqual({ data: "from upstream" });
  });
});
