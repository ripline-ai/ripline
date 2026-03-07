import { describe, expect, it } from "vitest";
import type { TransformNode } from "../../src/types.js";
import { executeTransform } from "../../src/pipeline/executors/transform.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";

describe("Transform executor", () => {
  it("evaluates expression with inputs, artifacts, env and stores result under node id", async () => {
    const node: TransformNode = {
      id: "t1",
      type: "transform",
      expression: "artifacts['area-owner-intake'].signals.length",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: { "area-owner-intake": { signals: [{ id: 1 }, { id: 2 }] } },
      env: {},
      outputs: {},
    };

    const result = await executeTransform(node, context);

    expect(result.artifactKey).toBe("t1");
    expect(result.value).toBe(2);
    expect(context.artifacts["t1"]).toBe(2);
  });

  it("returns value from expression and assigns to optional key when assigns is set", async () => {
    const node: TransformNode = {
      id: "t2",
      type: "transform",
      expression: "inputs.count + 1",
      assigns: "nextCount",
    };
    const context: ExecutorContext = {
      inputs: { count: 10 },
      artifacts: {},
      env: {},
      outputs: {},
    };

    const result = await executeTransform(node, context);

    expect(result.artifactKey).toBe("nextCount");
    expect(result.value).toBe(11);
    expect(context.artifacts["t2"]).toBeUndefined();
    expect(context.artifacts["nextCount"]).toBe(11);
  });

  it("times out long-running code", async () => {
    const node: TransformNode = {
      id: "t3",
      type: "transform",
      expression: "(() => { while (true) {} })()",
    };
    const context: ExecutorContext = {
      inputs: {},
      artifacts: {},
      env: {},
      outputs: {},
    };

    await expect(executeTransform(node, context)).rejects.toThrow(/timed\s*out|timeout|exceeded/i);
  }, 10000);
});
