import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { normalizeConfig } from "../src/index.js";

describe("normalizeConfig", () => {
  const cwd = process.cwd();

  it("defaults runsDir to .ripline/runs relative to cwd when not set", () => {
    const config = normalizeConfig({ pipelinesDir: "./pipelines" });
    expect(config.runsDir).toBe(path.join(cwd, ".ripline", "runs"));
  });

  it("resolves relative runsDir from process.cwd()", () => {
    const config = normalizeConfig({
      pipelinesDir: "./pipelines",
      runsDir: "custom/runs",
    });
    expect(config.runsDir).toBe(path.join(cwd, "custom", "runs"));
  });

  it("keeps absolute runsDir unchanged", () => {
    const absolute = path.join(os.tmpdir(), "ripline-runs");
    const config = normalizeConfig({
      pipelinesDir: "./pipelines",
      runsDir: absolute,
    });
    expect(config.runsDir).toBe(path.resolve(absolute));
  });

  it("uses default runsDir when runsDir is empty string", () => {
    const config = normalizeConfig({
      pipelinesDir: "./pipelines",
      runsDir: "",
    });
    expect(config.runsDir).toBe(path.join(cwd, ".ripline", "runs"));
  });

  it("uses default runsDir when runsDir is whitespace-only", () => {
    const config = normalizeConfig({
      pipelinesDir: "./pipelines",
      runsDir: "  \t  ",
    });
    expect(config.runsDir).toBe(path.join(cwd, ".ripline", "runs"));
  });

  it("passes through other config fields", () => {
    const config = normalizeConfig({
      pipelinesDir: "/foo/pipelines",
      runsDir: "/bar/runs",
      httpPort: 9999,
      httpPath: "/api",
      maxConcurrency: 2,
      authToken: "secret",
    });
    expect(config.pipelinesDir).toBe("/foo/pipelines");
    expect(config.runsDir).toBe("/bar/runs");
    expect(config.httpPort).toBe(9999);
    expect(config.httpPath).toBe("/api");
    expect(config.maxConcurrency).toBe(2);
    expect(config.authToken).toBe("secret");
  });
});
