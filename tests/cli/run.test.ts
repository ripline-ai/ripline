import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const cliPath = path.join(process.cwd(), "dist", "cli", "run.js");

describe("CLI run", () => {
  it("root --help shows run, pipelines, profiles, serve commands when dist is built", () => {
    if (!fs.existsSync(cliPath)) return;
    const out = execSync(`node "${cliPath}" --help`, { encoding: "utf-8" });
    expect(out).toContain("run ");
    expect(out).toContain("pipelines");
    expect(out).toContain("profiles");
    expect(out).toContain("serve");
  });

  it("run --help lists run options when dist is built", () => {
    if (!fs.existsSync(cliPath)) return;
    const out = execSync(`node "${cliPath}" run --help`, { encoding: "utf-8" });
    expect(out).toContain("--pipeline");
    expect(out).toContain("--input");
    expect(out).toContain("--profile");
    expect(out).toContain("--pipeline-dir");
    expect(out).toContain("--no-profile");
    expect(out).toContain("--env");
    expect(out).toContain("--resume");
    expect(out).toContain("--out");
    expect(out).toContain("--verbose");
    expect(out).toContain("--demo");
    expect(out).toContain("--enqueue");
    expect(out).toContain("-p");
    expect(out).toContain("-i");
    expect(out).toContain("-o");
    expect(out).toContain("-v");
  }, 30000);

  it("--pipeline-dir overrides default pipeline directory", () => {
    if (!fs.existsSync(cliPath)) return;
    const tmp = path.join(os.tmpdir(), "ripline-cli-pipeline-dir-" + Date.now());
    fs.mkdirSync(tmp, { recursive: true });
    const pipelineYaml = path.join(tmp, "hello.yaml");
    fs.writeFileSync(
      pipelineYaml,
      `id: hello
name: Hello
entry: [intake]
nodes:
  - id: intake
    type: input
  - id: out
    type: output
    source: intake
edges:
  - from: { node: intake }
    to: { node: out }
`,
      "utf-8"
    );
    try {
      const out = execSync(
        `node "${cliPath}" run hello --pipeline-dir "${tmp}" --demo`,
        { encoding: "utf-8", cwd: process.cwd() }
      );
      expect(out).toMatch(/Run .+ →/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30000);

  it("--profile loads profile and merges inputs (profile dir with profile)", () => {
    if (!fs.existsSync(cliPath)) return;
    const profileDir = path.join(os.tmpdir(), "ripline-cli-profile-" + Date.now());
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "testprof.yaml"),
      `name: testprof
inputs:
  fromProfile: true
`,
      "utf-8"
    );
    const pipelineDir = path.join(os.tmpdir(), "ripline-cli-profile-pipe-" + Date.now());
    fs.mkdirSync(pipelineDir, { recursive: true });
    fs.writeFileSync(
      path.join(pipelineDir, "minimal.yaml"),
      `id: minimal
name: Minimal
entry: [a]
nodes:
  - id: a
    type: input
  - id: b
    type: output
    source: a
edges:
  - from: { node: a }
    to: { node: b }
`,
      "utf-8"
    );
    try {
      const out = execSync(
        `node "${cliPath}" run minimal --pipeline-dir "${pipelineDir}" --profile-dir "${profileDir}" --profile testprof --input '{"fromProfile": "overridden"}' --demo`,
        { encoding: "utf-8", cwd: process.cwd() }
      );
      expect(out).toMatch(/Run .+ →/);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
      fs.rmSync(pipelineDir, { recursive: true, force: true });
    }
  }, 15000);

  it("profiles create --no-edit writes template and prints path", () => {
    if (!fs.existsSync(cliPath)) return;
    const profileDir = path.join(os.tmpdir(), "ripline-cli-create-" + Date.now());
    fs.mkdirSync(profileDir, { recursive: true });
    try {
      const out = execSync(
        `node "${cliPath}" profiles create testcreate --profile-dir "${profileDir}" --no-edit`,
        { encoding: "utf-8" }
      );
      expect(out.trim()).toBe(path.join(profileDir, "testcreate.yaml"));
      const content = fs.readFileSync(path.join(profileDir, "testcreate.yaml"), "utf-8");
      expect(content).toContain("name: testcreate");
      expect(content).toContain("inputs:");
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  }, 10000);
});
