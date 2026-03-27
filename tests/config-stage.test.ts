import { describe, expect, it } from "vitest";
import { resolveStageConfig } from "../src/config.js";

describe("resolveStageConfig", () => {
  it("defaults to production when STAGE is unset", () => {
    const cfg = resolveStageConfig({});
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3000");
  });

  it("resolves production explicitly", () => {
    const cfg = resolveStageConfig({ STAGE: "production" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3000");
  });

  it("resolves staging", () => {
    const cfg = resolveStageConfig({ STAGE: "staging" });
    expect(cfg.stage).toBe("staging");
    expect(cfg.port).toBe(4002);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3001");
  });

  it("falls back to production for unrecognised STAGE values", () => {
    const cfg = resolveStageConfig({ STAGE: "dev" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
  });

  it("falls back to production when STAGE is empty string", () => {
    const cfg = resolveStageConfig({ STAGE: "" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
  });
});
