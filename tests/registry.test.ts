import { describe, expect, it } from "vitest";
import path from "node:path";
import { PipelineRegistry } from "../src/registry.js";

const fixturesDir = path.join(process.cwd(), "pipelines", "examples");

describe("PipelineRegistry", () => {
  it("loads pipeline definitions from disk", async () => {
    const registry = new PipelineRegistry(fixturesDir);
    const pipelines = await registry.list();
    expect(pipelines.length).toBeGreaterThan(0);
    const runbook = await registry.get("daily_brief");
    expect(runbook?.definition.name).toBe("Daily Brief Workflow");
  });
});
