import { describe, expect, it } from "vitest";
import os from "node:os";

// We test resolveMcpConfig by passing argv arrays directly
import { resolveMcpConfig } from "../../src/mcp/config.js";

describe("resolveMcpConfig", () => {
  it("returns defaults when no args and no user config", () => {
    const cfg = resolveMcpConfig([], os.homedir());
    expect(cfg.runsDir).toBe(os.homedir() + "/.ripline/runs");
    expect(cfg.maxConcurrency).toBe(4);
    expect(typeof cfg.pipelinesDir).toBe("string");
  });

  it("CLI --pipelines-dir overrides default", () => {
    const cfg = resolveMcpConfig(["--pipelines-dir", "/tmp/mypipes"], os.homedir());
    expect(cfg.pipelinesDir).toBe("/tmp/mypipes");
  });

  it("CLI --runs-dir sets runsDir (not from user config)", () => {
    const cfg = resolveMcpConfig(["--runs-dir", "/tmp/runs"], os.homedir());
    expect(cfg.runsDir).toBe("/tmp/runs");
  });

  it("CLI --max-concurrency parses integer", () => {
    const cfg = resolveMcpConfig(["--max-concurrency", "8"], os.homedir());
    expect(cfg.maxConcurrency).toBe(8);
  });

  it("ignores unknown flags", () => {
    expect(() => resolveMcpConfig(["--unknown", "val"], os.homedir())).not.toThrow();
  });
});
