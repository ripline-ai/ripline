import { describe, it, expect } from "vitest";
import { buildShipPipeline } from "../../src/pipeline/ship-pipeline.js";
import type { ShipConfig } from "../../src/review-phase-types.js";
import type { ExecNode } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function defaultConfig(): ShipConfig {
  return {
    enabled: true,
    branchPattern: "ripline/{chatId}",
    titleTemplate: "ripline: chat #{chatId}",
  };
}

function getExecNodes(pipeline: ReturnType<typeof buildShipPipeline>): ExecNode[] {
  return pipeline.nodes as ExecNode[];
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

describe("buildShipPipeline — structure", () => {
  it("returns a PipelineDefinition with 5 exec nodes", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/repo");
    expect(pipeline.nodes).toHaveLength(5);
    for (const node of pipeline.nodes) {
      expect(node.type).toBe("exec");
    }
  });

  it("has the correct node ids in order", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/repo");
    const ids = pipeline.nodes.map((n) => n.id);
    expect(ids).toEqual([
      "detect-base-branch",
      "create-branch",
      "stage-and-commit",
      "push",
      "open-pr",
    ]);
  });

  it("entry points to detect-base-branch", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/repo");
    expect(pipeline.entry).toEqual(["detect-base-branch"]);
  });

  it("has 4 linear edges connecting all 5 nodes", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/repo");
    expect(pipeline.edges).toHaveLength(4);
    expect(pipeline.edges[0]).toMatchObject({
      from: { node: "detect-base-branch" },
      to: { node: "create-branch" },
    });
    expect(pipeline.edges[1]).toMatchObject({
      from: { node: "create-branch" },
      to: { node: "stage-and-commit" },
    });
    expect(pipeline.edges[2]).toMatchObject({
      from: { node: "stage-and-commit" },
      to: { node: "push" },
    });
    expect(pipeline.edges[3]).toMatchObject({
      from: { node: "push" },
      to: { node: "open-pr" },
    });
  });

  it("open-pr node has captureOutput: true (PR URL artifact)", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/repo");
    const openPr = pipeline.nodes.find((n) => n.id === "open-pr") as ExecNode;
    expect(openPr).toBeDefined();
    expect(openPr.captureOutput).toBe(true);
  });

  it("detect-base-branch node has captureOutput: true", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/repo");
    const detect = pipeline.nodes.find((n) => n.id === "detect-base-branch") as ExecNode;
    expect(detect).toBeDefined();
    expect(detect.captureOutput).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// chatId interpolation
// ---------------------------------------------------------------------------

describe("buildShipPipeline — chatId interpolation", () => {
  it("resolves {chatId} into branch name in create-branch command", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-99", "/repo");
    const createBranch = pipeline.nodes.find((n) => n.id === "create-branch") as ExecNode;
    expect(createBranch.command).toContain("ripline/chat-99");
  });

  it("resolves {chatId} into branch name in push command", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-99", "/repo");
    const push = pipeline.nodes.find((n) => n.id === "push") as ExecNode;
    expect(push.command).toContain("ripline/chat-99");
  });

  it("resolves {chatId} into PR title in open-pr command", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-99", "/repo");
    const openPr = pipeline.nodes.find((n) => n.id === "open-pr") as ExecNode;
    expect(openPr.command).toContain("chat #chat-99");
  });

  it("uses custom branchPattern when provided", () => {
    const config: ShipConfig = {
      enabled: true,
      branchPattern: "feature/{chatId}-release",
      titleTemplate: "Release for {chatId}",
    };
    const pipeline = buildShipPipeline(config, "abc-123", "/repo");
    const createBranch = pipeline.nodes.find((n) => n.id === "create-branch") as ExecNode;
    const push = pipeline.nodes.find((n) => n.id === "push") as ExecNode;
    expect(createBranch.command).toContain("feature/abc-123-release");
    expect(push.command).toContain("feature/abc-123-release");
  });

  it("uses custom titleTemplate when provided", () => {
    const config: ShipConfig = {
      enabled: true,
      branchPattern: "ship/{chatId}",
      titleTemplate: "PR for chat {chatId}",
    };
    const pipeline = buildShipPipeline(config, "xyz-7", "/repo");
    const openPr = pipeline.nodes.find((n) => n.id === "open-pr") as ExecNode;
    expect(openPr.command).toContain("PR for chat xyz-7");
  });

  it("defaults branchPattern to ripline/{chatId} when not specified", () => {
    const config: ShipConfig = { enabled: true };
    const pipeline = buildShipPipeline(config, "default-chat", "/repo");
    const createBranch = pipeline.nodes.find((n) => n.id === "create-branch") as ExecNode;
    expect(createBranch.command).toContain("ripline/default-chat");
  });

  it("defaults titleTemplate to 'ripline: chat #{chatId}' when not specified", () => {
    const config: ShipConfig = { enabled: true };
    const pipeline = buildShipPipeline(config, "default-chat", "/repo");
    const openPr = pipeline.nodes.find((n) => n.id === "open-pr") as ExecNode;
    expect(openPr.command).toContain("ripline: chat #default-chat");
  });
});

// ---------------------------------------------------------------------------
// repoPath as cwd
// ---------------------------------------------------------------------------

describe("buildShipPipeline — repoPath as cwd", () => {
  it("sets cwd to repoPath for all exec nodes", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "chat-42", "/workspace/myapp");
    for (const node of getExecNodes(pipeline)) {
      expect(node.cwd).toBe("/workspace/myapp");
    }
  });
});

// ---------------------------------------------------------------------------
// Pipeline id
// ---------------------------------------------------------------------------

describe("buildShipPipeline — pipeline id", () => {
  it("includes chatId in the pipeline id", () => {
    const pipeline = buildShipPipeline(defaultConfig(), "unique-chat-77", "/repo");
    expect(pipeline.id).toContain("unique-chat-77");
  });
});
