import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadUserConfig } from "../src/config.js";

/**
 * Tests for containerBuild configuration parsing from ~/.ripline/config.json.
 *
 * Story 4 (Integrate container execution into Ripline build queue) added
 * ContainerBuildUserConfig to the user config schema. These tests verify
 * that the config loader correctly parses, validates, and expands tilde
 * in all containerBuild fields.
 */

describe("loadUserConfig — containerBuild configuration", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-cb-config-${Date.now()}`);
    fs.mkdirSync(path.join(tmpHome, ".ripline"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  function writeConfig(config: Record<string, unknown>) {
    fs.writeFileSync(
      path.join(tmpHome, ".ripline", "config.json"),
      JSON.stringify(config),
    );
  }

  it("parses a complete containerBuild configuration", () => {
    writeConfig({
      containerBuild: {
        enabled: true,
        repoPath: "/home/user/project",
        targetBranch: "main",
        buildImage: "my-org/builder:v2",
        testCommand: "npm run test:ci",
        secretsMountPath: "/home/user/.secrets",
        containerTimeoutMs: 900_000,
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeDefined();
    expect(config.containerBuild!.enabled).toBe(true);
    expect(config.containerBuild!.repoPath).toBe("/home/user/project");
    expect(config.containerBuild!.targetBranch).toBe("main");
    expect(config.containerBuild!.buildImage).toBe("my-org/builder:v2");
    expect(config.containerBuild!.testCommand).toBe("npm run test:ci");
    expect(config.containerBuild!.secretsMountPath).toBe("/home/user/.secrets");
    expect(config.containerBuild!.containerTimeoutMs).toBe(900_000);
  });

  it("expands tilde in repoPath", () => {
    writeConfig({
      containerBuild: {
        repoPath: "~/my-project",
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.repoPath).toBe(path.join(tmpHome, "my-project"));
  });

  it("expands tilde in secretsMountPath", () => {
    writeConfig({
      containerBuild: {
        secretsMountPath: "~/.secrets",
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.secretsMountPath).toBe(path.join(tmpHome, ".secrets"));
  });

  it("omits enabled when not set to true", () => {
    writeConfig({
      containerBuild: {
        repoPath: "/repo",
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeDefined();
    expect(config.containerBuild!.enabled).toBeUndefined();
  });

  it("handles partial configuration (only some fields set)", () => {
    writeConfig({
      containerBuild: {
        enabled: true,
        targetBranch: "develop",
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.enabled).toBe(true);
    expect(config.containerBuild!.targetBranch).toBe("develop");
    expect(config.containerBuild!.repoPath).toBeUndefined();
    expect(config.containerBuild!.buildImage).toBeUndefined();
    expect(config.containerBuild!.testCommand).toBeUndefined();
    expect(config.containerBuild!.secretsMountPath).toBeUndefined();
    expect(config.containerBuild!.containerTimeoutMs).toBeUndefined();
  });

  it("ignores containerBuild when it is not an object", () => {
    writeConfig({
      containerBuild: "invalid",
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeUndefined();
  });

  it("ignores containerBuild when it is an array", () => {
    writeConfig({
      containerBuild: [1, 2, 3],
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeUndefined();
  });

  it("ignores non-string repoPath", () => {
    writeConfig({
      containerBuild: {
        repoPath: 123,
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeDefined();
    expect(config.containerBuild!.repoPath).toBeUndefined();
  });

  it("ignores non-number containerTimeoutMs", () => {
    writeConfig({
      containerBuild: {
        containerTimeoutMs: "5000",
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeDefined();
    expect(config.containerBuild!.containerTimeoutMs).toBeUndefined();
  });

  it("trims whitespace from string fields", () => {
    writeConfig({
      containerBuild: {
        targetBranch: "  main  ",
        buildImage: "  node:20  ",
        testCommand: "  npm test  ",
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.targetBranch).toBe("main");
    expect(config.containerBuild!.buildImage).toBe("node:20");
    expect(config.containerBuild!.testCommand).toBe("npm test");
  });

  it("coexists with queues configuration", () => {
    writeConfig({
      containerBuild: {
        enabled: true,
        buildImage: "builder:latest",
      },
      queues: {
        build: { concurrency: 4, resourceLimits: { cpus: "2", memory: "4g" } },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild!.enabled).toBe(true);
    expect(config.containerBuild!.buildImage).toBe("builder:latest");
    expect(config.queues!.build!.concurrency).toBe(4);
    expect(config.queues!.build!.resourceLimits).toEqual({ cpus: "2", memory: "4g" });
  });

  it("returns empty containerBuild object when block is empty", () => {
    writeConfig({
      containerBuild: {},
    });

    const config = loadUserConfig(tmpHome);

    expect(config.containerBuild).toBeDefined();
    expect(config.containerBuild!.enabled).toBeUndefined();
    expect(config.containerBuild!.repoPath).toBeUndefined();
  });
});
