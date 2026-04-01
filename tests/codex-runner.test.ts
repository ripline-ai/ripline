import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCodexRunner } from "../src/codex-runner.js";

let capturedSpawnArgs: { command: string; args: string[]; cwd?: string } | null = null;
let childExitCode = 0;
let childStdout = "";
let childStderr = "";

class MockChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock("node:child_process", () => ({
  spawn: (command: string, args: string[], options: { cwd?: string }) => {
    capturedSpawnArgs = { command, args, cwd: options.cwd };
    const child = new MockChildProcess();
    queueMicrotask(() => {
      if (childStdout) child.stdout.emit("data", Buffer.from(childStdout));
      if (childStderr) child.stderr.emit("data", Buffer.from(childStderr));
      child.emit("close", childExitCode);
    });
    return child;
  },
}));

describe("Codex runner", () => {
  let cwd: string;

  beforeEach(() => {
    capturedSpawnArgs = null;
    childExitCode = 0;
    childStdout = "";
    childStderr = "";
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ripline-codex-test-"));
  });

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  it("passes params.model to codex exec when node sets model", async () => {
    const runner = createCodexRunner({ mode: "execute" });
    const run = runner({
      agentId: "default",
      prompt: "Hello",
      cwd,
      model: "gpt-5.4",
    });

    await vi.waitFor(() => expect(capturedSpawnArgs).not.toBeNull());
    const outIdx = capturedSpawnArgs!.args.indexOf("--output-last-message");
    fs.writeFileSync(capturedSpawnArgs!.args[outIdx + 1]!, "done", "utf8");
    await run;

    expect(capturedSpawnArgs?.command).toBe("codex");
    expect(capturedSpawnArgs?.args).toContain("--model");
    expect(capturedSpawnArgs?.args).toContain("gpt-5.4");
  });

  it("uses read-only sandbox in plan mode", async () => {
    const runner = createCodexRunner({ mode: "plan" });
    const run = runner({
      agentId: "default",
      prompt: "Plan this",
      cwd,
    });

    await vi.waitFor(() => expect(capturedSpawnArgs).not.toBeNull());
    const outIdx = capturedSpawnArgs!.args.indexOf("--output-last-message");
    fs.writeFileSync(capturedSpawnArgs!.args[outIdx + 1]!, "done", "utf8");
    await run;

    expect(capturedSpawnArgs?.args).toContain("--sandbox");
    expect(capturedSpawnArgs?.args).toContain("read-only");
  });

  it("uses bypass flag only when both config and params allow it", async () => {
    const runner = createCodexRunner({ mode: "execute", allowDangerouslySkipPermissions: true });
    const run = runner({
      agentId: "default",
      prompt: "Do it",
      cwd,
      dangerouslySkipPermissions: true,
    });

    await vi.waitFor(() => expect(capturedSpawnArgs).not.toBeNull());
    const outIdx = capturedSpawnArgs!.args.indexOf("--output-last-message");
    fs.writeFileSync(capturedSpawnArgs!.args[outIdx + 1]!, "done", "utf8");
    await run;

    expect(capturedSpawnArgs?.args).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(capturedSpawnArgs?.args).not.toContain("-a");
  });

  it("throws on non-zero exit with stderr detail", async () => {
    childExitCode = 2;
    childStderr = "boom";
    const runner = createCodexRunner({ mode: "execute" });
    await expect(
      runner({ agentId: "default", prompt: "Hi", cwd })
    ).rejects.toThrow(/Codex runner exited with code 2: boom/);
  });

  it("reports the tail of container exec failures instead of the banner head", async () => {
    const runner = createCodexRunner({ mode: "execute" });
    await expect(
      runner({
        agentId: "default",
        prompt: "Hi",
        cwd,
        dangerouslySkipPermissions: true,
        containerContext: {
          runId: "run-1",
          pool: {
            exec: vi.fn().mockResolvedValue({
              exitCode: 1,
              stdout: "Reading additional input from stdin...\nOpenAI Codex v0.118.0\nactual failure line\nmore detail",
              stderr: "",
            }),
          } as any,
        },
      })
    ).rejects.toThrow(/actual failure line/);
  });

  it("reports container exec timeouts using the node timeout", async () => {
    const runner = createCodexRunner({ mode: "execute" });
    await expect(
      runner({
        agentId: "default",
        prompt: "Hi",
        cwd,
        timeoutSeconds: 42,
        containerContext: {
          runId: "run-1",
          pool: {
            exec: vi.fn().mockResolvedValue({
              exitCode: 124,
              stdout: "",
              stderr: "[timed out after 42s]",
              timedOut: true,
            }),
          } as any,
        },
      })
    ).rejects.toThrow(/request timed out after 42s/);
  });
});
