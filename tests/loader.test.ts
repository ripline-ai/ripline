import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  loadPipelineDefinition,
  resolvePipelineFile,
} from "../src/lib/pipeline/loader.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");
const riplinePath = path.join(fixturesDir, "ripline-area-owner.yaml");

describe("loadPipelineDefinition", () => {
  it("loads ripline-area-owner.yaml successfully (happy path)", () => {
    const def = loadPipelineDefinition(riplinePath);
    expect(def.id).toBe("ripline-area-owner");
    expect(def.name).toBe("Ripline Area Owner Loop");
    expect(def.entry).toEqual(["area-owner-intake"]);
    expect(def.nodes).toHaveLength(5);
    expect(def.edges).toHaveLength(4);
  });

  it("throws with file path and offending node id when edge references missing node", () => {
    const dir = path.join(process.cwd(), "tests", "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    const invalidPath = path.join(dir, "missing-edge-node.yaml");
    const yaml = `
id: bad-pipeline
name: Bad
entry: [a]
nodes:
  - id: a
    type: input
edges:
  - from: { node: a }
    to: { node: nonexistent }
`;
    fs.writeFileSync(invalidPath, yaml.trim());
    try {
      expect(() => loadPipelineDefinition(invalidPath)).toThrow(
        /missing-edge-node\.yaml|bad-pipeline|nonexistent/i
      );
    } finally {
      fs.unlinkSync(invalidPath);
    }
  });

  it("throws with file path and node id when entry references missing node", () => {
    const dir = path.join(process.cwd(), "tests", "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    const invalidPath = path.join(dir, "invalid-entry.yaml");
    const yaml = `
id: bad-entry
entry: [missing-intake]
nodes:
  - id: only-node
    type: output
edges:
  - from: { node: only-node }
    to: { node: only-node }
`;
    fs.writeFileSync(invalidPath, yaml.trim());
    try {
      expect(() => loadPipelineDefinition(invalidPath)).toThrow(
        /invalid-entry\.yaml|bad-entry|missing-intake|entry/i
      );
    } finally {
      fs.unlinkSync(invalidPath);
    }
  });

  it("throws when duplicate node IDs exist", () => {
    const dir = path.join(process.cwd(), "tests", "fixtures");
    fs.mkdirSync(dir, { recursive: true });
    const invalidPath = path.join(dir, "duplicate-ids.yaml");
    const yaml = `
id: dup-ids
entry: [a]
nodes:
  - id: a
    type: input
  - id: a
    type: output
edges:
  - from: { node: a }
    to: { node: a }
`;
    fs.writeFileSync(invalidPath, yaml.trim());
    try {
      expect(() => loadPipelineDefinition(invalidPath)).toThrow(
        /duplicate-ids\.yaml|dup-ids|duplicate.*id/i
      );
    } finally {
      fs.unlinkSync(invalidPath);
    }
  });

  it("caches parsed definition and does not re-read unchanged file", () => {
    const def1 = loadPipelineDefinition(riplinePath);
    const def2 = loadPipelineDefinition(riplinePath);
    expect(def1).toBe(def2);
  });

  it("loads template ripline-area-owner.yaml with metadata and node contracts", () => {
    const templatePath = path.join(process.cwd(), "pipelines", "templates", "ripline-area-owner.yaml");
    const def = loadPipelineDefinition(templatePath);
    expect(def.id).toBe("ripline-area-owner");
    expect(def.version).toBe("1.0");
    expect(def.tags).toContain("template");
    expect(def.metadata?.template).toBe(true);
    expect(def.metadata?.sampleInputs).toBe("samples/ripline-area-owner-inputs.json");
    const intake = def.nodes.find((n) => n.id === "area-owner-intake");
    expect(intake?.contracts?.input).toBeDefined();
    expect((intake?.contracts?.input as { required?: string[] })?.required).toContain("signals");
    const breakdown = def.nodes.find((n) => n.id === "break-down");
    expect(breakdown?.contracts?.output).toBeDefined();
    expect((breakdown?.contracts?.output as { required?: string[] })?.required).toContain("features");
  });
});

describe("resolvePipelineFile", () => {
  it("resolves pipeline by id from directory", () => {
    const dir = path.join(process.cwd(), "pipelines", "examples");
    const resolved = resolvePipelineFile("ripline-area-owner", dir);
    expect(resolved).toBe(path.join(dir, "ripline-area-owner.yaml"));
    const def = loadPipelineDefinition(resolved);
    expect(def.id).toBe("ripline-area-owner");
  });

  it("throws with directory name in error when pipeline not found", () => {
    const dir = path.join(os.tmpdir(), "ripline-loader-notfound-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      expect(() => resolvePipelineFile("nonexistent-pipeline-id", dir)).toThrow(
        /Pipeline not found.*nonexistent-pipeline-id.*searched in/
      );
      const err = (() => {
        try {
          resolvePipelineFile("nonexistent-pipeline-id", dir);
        } catch (e) {
          return e;
        }
      })() as Error;
      expect(err.message).toContain(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
