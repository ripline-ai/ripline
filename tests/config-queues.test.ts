import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadUserConfig } from "../src/config.js";

/* ── Tests for queue configuration parsing ────────────────────────────── */

describe("loadUserConfig — queues configuration", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = path.join(os.tmpdir(), `ripline-config-test-${Date.now()}`);
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

  it("parses queues with concurrency and resource limits", () => {
    writeConfig({
      queues: {
        build: { concurrency: 4, resourceLimits: { cpus: "1", memory: "2g" } },
        test: { concurrency: 2, resourceLimits: { cpus: "0.5", memory: "1g" } },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues).toBeDefined();
    expect(config.queues!.build).toEqual({
      concurrency: 4,
      resourceLimits: { cpus: "1", memory: "2g" },
    });
    expect(config.queues!.test).toEqual({
      concurrency: 2,
      resourceLimits: { cpus: "0.5", memory: "1g" },
    });
  });

  it("defaults concurrency to 1 when not specified", () => {
    writeConfig({
      queues: {
        build: {},
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues!.build!.concurrency).toBe(1);
  });

  it("enforces minimum concurrency of 1", () => {
    writeConfig({
      queues: {
        build: { concurrency: 0 },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues!.build!.concurrency).toBe(1);
  });

  it("handles negative concurrency by clamping to 1", () => {
    writeConfig({
      queues: {
        build: { concurrency: -5 },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues!.build!.concurrency).toBe(1);
  });

  it("omits resourceLimits when not specified", () => {
    writeConfig({
      queues: {
        build: { concurrency: 2 },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues!.build!.resourceLimits).toBeUndefined();
  });

  it("handles partial resource limits (cpus only)", () => {
    writeConfig({
      queues: {
        build: { concurrency: 1, resourceLimits: { cpus: "2" } },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues!.build!.resourceLimits).toEqual({ cpus: "2" });
  });

  it("handles partial resource limits (memory only)", () => {
    writeConfig({
      queues: {
        build: { concurrency: 1, resourceLimits: { memory: "512m" } },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues!.build!.resourceLimits).toEqual({ memory: "512m" });
  });

  it("ignores invalid queues block (array)", () => {
    writeConfig({
      queues: [1, 2, 3],
    });

    const config = loadUserConfig(tmpHome);

    expect(config.queues).toBeUndefined();
  });

  it("ignores invalid queue entries (non-object)", () => {
    writeConfig({
      queues: {
        build: "invalid",
        test: 42,
      },
    });

    const config = loadUserConfig(tmpHome);

    // No valid queues were parsed
    expect(config.queues).toBeUndefined();
  });

  it("ignores non-string resource limit values", () => {
    writeConfig({
      queues: {
        build: { concurrency: 2, resourceLimits: { cpus: 2, memory: 1024 } },
      },
    });

    const config = loadUserConfig(tmpHome);

    // resourceLimits should not be set because neither cpus nor memory is a string
    expect(config.queues!.build!.resourceLimits).toBeUndefined();
  });

  it("supports multiple queues", () => {
    writeConfig({
      queues: {
        build: { concurrency: 4, resourceLimits: { cpus: "2", memory: "4g" } },
        test: { concurrency: 2, resourceLimits: { cpus: "1", memory: "2g" } },
        deploy: { concurrency: 1 },
      },
    });

    const config = loadUserConfig(tmpHome);

    expect(Object.keys(config.queues!)).toHaveLength(3);
    expect(config.queues!.deploy!.concurrency).toBe(1);
    expect(config.queues!.deploy!.resourceLimits).toBeUndefined();
  });

  it("returns empty config when config file is missing", () => {
    const nonexistent = path.join(os.tmpdir(), "nonexistent-home-" + Date.now());
    const config = loadUserConfig(nonexistent);
    expect(config).toEqual({});
  });
});
