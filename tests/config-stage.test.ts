import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

describe("resolveConfig", () => {
  it("defaults to production when STAGE is unset", () => {
    const cfg = resolveConfig({});
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
    expect(cfg.riplineUrl).toBe("http://localhost:4001");
  });

  it("resolves production explicitly", () => {
    const cfg = resolveConfig({ STAGE: "production" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
    expect(cfg.riplineUrl).toBe("http://localhost:4001");
  });

  it("resolves staging", () => {
    const cfg = resolveConfig({ STAGE: "staging" });
    expect(cfg.stage).toBe("staging");
    expect(cfg.port).toBe(4002);
    expect(cfg.riplineUrl).toBe("http://localhost:4002");
  });

  it("falls back to production for unrecognised STAGE values", () => {
    const cfg = resolveConfig({ STAGE: "dev" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
  });

  it("falls back to production when STAGE is empty string", () => {
    const cfg = resolveConfig({ STAGE: "" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
  });

  it("RIPLINE_PORT env var overrides stage default port", () => {
    const cfg = resolveConfig({ STAGE: "production", RIPLINE_PORT: "9000" });
    expect(cfg.port).toBe(9000);
    expect(cfg.riplineUrl).toBe("http://localhost:9000");
  });

  it("RIPLINE_URL env var overrides derived riplineUrl", () => {
    const cfg = resolveConfig({ STAGE: "production", RIPLINE_URL: "https://ripline.example.com" });
    expect(cfg.riplineUrl).toBe("https://ripline.example.com");
  });

  it("does not include wintermute references", () => {
    const cfg = resolveConfig({ STAGE: "production" });
    expect(cfg).not.toHaveProperty("wintermuteBaseUrl");
  });
});
