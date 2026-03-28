import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { normalizeConfig } from "../src/index.js";
import {
  loadUserConfig,
  resolvePipelineDir,
  resolveProfileDir,
  resolveStageConfig,
} from "../src/config.js";

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

describe("loadUserConfig", () => {
  it("returns empty object when ~/.ripline/config.json is missing", () => {
    const tmp = path.join(os.tmpdir(), "ripline-config-test-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const config = loadUserConfig(tmp);
      expect(config).toEqual({});
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads and parses valid config file", () => {
    const tmp = path.join(os.tmpdir(), "ripline-config-test-" + Date.now());
    const configDir = path.join(tmp, ".ripline");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        pipelineDir: "~/custom/pipelines",
        profileDir: "/absolute/profiles",
        defaultProfile: "myapp",
      }),
      "utf-8"
    );
    try {
      const config = loadUserConfig(tmp);
      expect(config.pipelineDir).toBe(path.join(tmp, "custom", "pipelines"));
      expect(config.profileDir).toBe("/absolute/profiles");
      expect(config.defaultProfile).toBe("myapp");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reads claudeCode.allowDangerouslySkipPermissions when true", () => {
    const tmp = path.join(os.tmpdir(), "ripline-config-test-" + Date.now());
    const configDir = path.join(tmp, ".ripline");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ claudeCode: { allowDangerouslySkipPermissions: true } }),
      "utf-8"
    );
    try {
      const config = loadUserConfig(tmp);
      expect(config.claudeCode?.allowDangerouslySkipPermissions).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolvePipelineDir", () => {
  it("uses flag when provided", () => {
    const tmp = path.join(os.tmpdir(), "ripline-pipeline-dir-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const result = resolvePipelineDir({
        flag: tmp,
        cwd: process.cwd(),
        homedir: os.tmpdir(),
      });
      expect(result).toBe(path.resolve(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses user config pipelineDir when no flag", () => {
    const home = path.join(os.tmpdir(), "ripline-pipeline-home-" + Date.now());
    const configDir = path.join(home, ".ripline");
    fs.mkdirSync(configDir, { recursive: true });
    const customDir = path.join(home, "pipelines");
    fs.mkdirSync(customDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ pipelineDir: customDir }),
      "utf-8"
    );
    const emptyCwd = path.join(os.tmpdir(), "ripline-empty-cwd-" + Date.now());
    fs.mkdirSync(emptyCwd, { recursive: true });
    try {
      const result = resolvePipelineDir({
        cwd: emptyCwd,
        homedir: home,
      });
      expect(result).toBe(path.resolve(customDir));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(emptyCwd, { recursive: true, force: true });
    }
  });

  it("uses cwd ripline.config.json when present and no flag / no user config pipelineDir", () => {
    const cwd = path.join(os.tmpdir(), "ripline-cwd-config-" + Date.now());
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "ripline.config.json"),
      JSON.stringify({ pipelineDir: "./local-pipelines" }),
      "utf-8"
    );
    const home = path.join(os.tmpdir(), "ripline-cwd-home-" + Date.now());
    fs.mkdirSync(path.join(home, ".ripline"), { recursive: true });
    try {
      const result = resolvePipelineDir({
        cwd,
        homedir: home,
      });
      expect(result).toBe(path.resolve(cwd, "local-pipelines"));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to default ~/.ripline/pipelines when no flag, no user config, no cwd config", () => {
    const home = path.join(os.tmpdir(), "ripline-default-dir-" + Date.now());
    fs.mkdirSync(home, { recursive: true });
    try {
      const result = resolvePipelineDir({ cwd: process.cwd(), homedir: home });
      expect(result).toBe(path.join(home, ".ripline", "pipelines"));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveProfileDir", () => {
  it("uses flag when provided", () => {
    const tmp = path.join(os.tmpdir(), "ripline-profile-flag-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const result = resolveProfileDir({ flag: tmp, homedir: os.tmpdir() });
      expect(result).toBe(path.resolve(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses user config profileDir when no flag", () => {
    const home = path.join(os.tmpdir(), "ripline-profile-home-" + Date.now());
    const configDir = path.join(home, ".ripline");
    fs.mkdirSync(configDir, { recursive: true });
    const customDir = path.join(home, "profiles");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ profileDir: customDir }),
      "utf-8"
    );
    try {
      const result = resolveProfileDir({ homedir: home });
      expect(result).toBe(path.resolve(customDir));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("falls back to default ~/.ripline/profiles when no flag and no user config", () => {
    const home = path.join(os.tmpdir(), "ripline-profile-default-" + Date.now());
    fs.mkdirSync(home, { recursive: true });
    try {
      const result = resolveProfileDir({ homedir: home });
      expect(result).toBe(path.join(home, ".ripline", "profiles"));
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveStageConfig", () => {
  it("returns production config when STAGE is unset", () => {
    const cfg = resolveStageConfig({});
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3000");
  });

  it("returns production config when STAGE is 'production'", () => {
    const cfg = resolveStageConfig({ STAGE: "production" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3000");
  });

  it("returns staging config when STAGE is 'staging'", () => {
    const cfg = resolveStageConfig({ STAGE: "staging" });
    expect(cfg.stage).toBe("staging");
    expect(cfg.port).toBe(4002);
    expect(cfg.wintermuteBaseUrl).toBe("http://localhost:3001");
  });

  it("defaults to production for unrecognised STAGE values", () => {
    const cfg = resolveStageConfig({ STAGE: "dev" });
    expect(cfg.stage).toBe("production");
    expect(cfg.port).toBe(4001);
  });
});
