import { describe, expect, it } from "vitest";
import type { InputNode } from "../../src/types.js";
import { executeInput } from "../../src/pipeline/executors/input.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";

describe("Input executor", () => {
  it("deep-clones inputs and stores under node id when path is absent", async () => {
    const node: InputNode = { id: "area-owner-intake", type: "input" };
    const inputs = { signals: [{ id: 1, text: "Feature X" }] };
    const context: ExecutorContext = {
      inputs: { ...inputs },
      artifacts: {},
      env: {},
      outputs: {},
    };

    const result = await executeInput(node, context);

    expect(result.artifactKey).toBe("area-owner-intake");
    expect(result.value).toEqual(inputs);
    expect(context.artifacts["area-owner-intake"]).toEqual(inputs);
    expect(context.artifacts["area-owner-intake"]).not.toBe(inputs);
    expect((context.artifacts["area-owner-intake"] as { signals: unknown[] }).signals).not.toBe(inputs.signals);
  });

  it("selects sub-path when node.path is set (dot notation)", async () => {
    const node: InputNode = { id: "intake", type: "input", path: "signals" };
    const inputs = { signals: [{ id: 1 }], other: "ignored" };
    const context: ExecutorContext = {
      inputs: { ...inputs },
      artifacts: {},
      env: {},
      outputs: {},
    };

    const result = await executeInput(node, context);

    expect(result.artifactKey).toBe("intake");
    expect(result.value).toEqual([{ id: 1 }]);
    expect(context.artifacts["intake"]).toEqual([{ id: 1 }]);
  });

  it("stores undefined when path does not exist", async () => {
    const node: InputNode = { id: "intake", type: "input", path: "missing" };
    const context: ExecutorContext = {
      inputs: { foo: 1 },
      artifacts: {},
      env: {},
      outputs: {},
    };

    const result = await executeInput(node, context);

    expect(result.artifactKey).toBe("intake");
    expect(result.value).toBeUndefined();
    expect(context.artifacts["intake"]).toBeUndefined();
  });
});
