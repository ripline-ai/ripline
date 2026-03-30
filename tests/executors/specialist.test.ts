import { describe, expect, it, vi, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

// ---------------------------------------------------------------------------
// vi.hoisted ensures the mock fn is initialized before vi.mock hoisting.
// ---------------------------------------------------------------------------

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

// ---------------------------------------------------------------------------
// Import the executor after mock registration.
// ---------------------------------------------------------------------------

import { executeSpecialist } from "../../src/pipeline/executors/specialist.js";
import type { SpecialistNode } from "../../src/types.js";
import type { ExecutorContext } from "../../src/pipeline/executors/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ExecutorContext> = {}): ExecutorContext {
  return {
    inputs: {},
    artifacts: {},
    env: {},
    outputs: {},
    ...overrides,
  };
}

type ProcMockOptions = {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  errorEvent?: Error;
};

/** Build a fake child process that emits its events on the next tick. */
function makeProcMock(opts: ProcMockOptions = {}) {
  const proc = new EventEmitter() as NodeJS.EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: (sig?: string) => void;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();

  setImmediate(() => {
    if (opts.errorEvent) {
      proc.emit("error", opts.errorEvent);
      return;
    }
    if (opts.stdout) proc.stdout.emit("data", Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit("data", Buffer.from(opts.stderr));
    proc.emit("close", opts.exitCode ?? 0);
  });

  return proc;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("executeSpecialist", () => {
  const vectorDir = path.join(os.homedir(), "agents", "vector");
  const meridianDir = path.join(os.homedir(), "agents", "meridian");

  beforeEach(() => {
    vi.clearAllMocks();
    fs.mkdirSync(vectorDir, { recursive: true });
    fs.mkdirSync(meridianDir, { recursive: true });
  });

  it("throws when agent directory does not exist", async () => {
    const node: SpecialistNode = {
      id: "ask-phantom",
      type: "specialist",
      agent: "phantom",
      prompt: "Hello",
    };

    await expect(executeSpecialist(node, makeContext())).rejects.toThrow(
      /agent directory not found/,
    );
  });

  it("stores agent text output under node id by default", async () => {
    spawnMock.mockReturnValueOnce(makeProcMock({ stdout: "  Agent answer here  " }));

    const node: SpecialistNode = {
      id: "ask-vector",
      type: "specialist",
      agent: "vector",
      prompt: "What is X?",
    };
    const context = makeContext();

    const result = await executeSpecialist(node, context);

    expect(result.artifactKey).toBe("ask-vector");
    expect((result.value as { text: string }).text).toBe("Agent answer here");
    expect((context.artifacts["ask-vector"] as { text: string }).text).toBe("Agent answer here");
  });

  it("respects custom assigns key", async () => {
    spawnMock.mockReturnValueOnce(makeProcMock({ stdout: "custom result" }));

    const node: SpecialistNode = {
      id: "ask-vector",
      type: "specialist",
      agent: "vector",
      prompt: "Task",
      assigns: "vector_result",
    };
    const context = makeContext();

    const result = await executeSpecialist(node, context);

    expect(result.artifactKey).toBe("vector_result");
    expect(context.artifacts["vector_result"]).toBeDefined();
    expect(context.artifacts["ask-vector"]).toBeUndefined();
  });

  it("prepends context text to the prompt", async () => {
    const capturedArgs: string[][] = [];
    spawnMock.mockImplementationOnce((_cmd: string, args: string[]) => {
      capturedArgs.push(args);
      return makeProcMock({ stdout: "ok" });
    });

    const node: SpecialistNode = {
      id: "ask-vector",
      type: "specialist",
      agent: "vector",
      prompt: "What should we do?",
      context: "Project is in TypeScript.",
    };

    await executeSpecialist(node, makeContext());

    const fullPrompt = capturedArgs[0]?.[1] ?? "";
    expect(fullPrompt).toContain("Project is in TypeScript.");
    expect(fullPrompt).toContain("What should we do?");
    expect(fullPrompt.indexOf("Project is in TypeScript.")).toBeLessThan(
      fullPrompt.indexOf("What should we do?"),
    );
  });

  it("invokes claude with --output-format text and passes cwd", async () => {
    const spawnCalls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    spawnMock.mockImplementationOnce((cmd: string, args: string[], opts: { cwd: string }) => {
      spawnCalls.push({ cmd, args, opts });
      return makeProcMock({ stdout: "response" });
    });

    const node: SpecialistNode = {
      id: "ask-vector",
      type: "specialist",
      agent: "vector",
      prompt: "Summarize.",
    };

    await executeSpecialist(node, makeContext());

    expect(spawnCalls[0]?.cmd).toBe("claude");
    expect(spawnCalls[0]?.args).toContain("-p");
    expect(spawnCalls[0]?.args).toContain("--output-format");
    expect(spawnCalls[0]?.args).toContain("text");
    expect(spawnCalls[0]?.opts.cwd).toBe(vectorDir);
  });

  it("interpolates agent name and prompt from artifacts", async () => {
    const spawnCalls: { cmd: string; args: string[]; opts: { cwd: string } }[] = [];
    spawnMock.mockImplementationOnce((cmd: string, args: string[], opts: { cwd: string }) => {
      spawnCalls.push({ cmd, args, opts });
      return makeProcMock({ stdout: "interpolated response" });
    });

    const node: SpecialistNode = {
      id: "ask",
      type: "specialist",
      agent: "{{target_agent}}",
      prompt: "Analyze {{topic}}",
    };
    const context = makeContext({
      artifacts: { target_agent: "meridian", topic: "database performance" },
    });

    const result = await executeSpecialist(node, context);

    expect(spawnCalls[0]?.opts.cwd).toBe(meridianDir);
    expect(spawnCalls[0]?.args[1]).toContain("database performance");
    expect((result.value as { text: string }).text).toBe("interpolated response");
  });

  it("throws on non-zero exit code", async () => {
    spawnMock.mockReturnValueOnce(makeProcMock({ exitCode: 1, stderr: "API error" }));

    const node: SpecialistNode = {
      id: "ask-vector",
      type: "specialist",
      agent: "vector",
      prompt: "Fail please",
    };

    await expect(executeSpecialist(node, makeContext())).rejects.toThrow(
      /claude exited with code 1/,
    );
  });

  it("throws on spawn error (e.g. claude not installed)", async () => {
    spawnMock.mockReturnValueOnce(makeProcMock({ errorEvent: new Error("ENOENT") }));

    const node: SpecialistNode = {
      id: "ask-vector",
      type: "specialist",
      agent: "vector",
      prompt: "Hello",
    };

    await expect(executeSpecialist(node, makeContext())).rejects.toThrow(
      /failed to spawn claude/,
    );
  });

  it("throws when agent name resolves to empty string", async () => {
    // {{missing_var}} → undefined → interpolated as "" → empty name
    const node: SpecialistNode = {
      id: "ask",
      type: "specialist",
      agent: "{{missing_var}}",
      prompt: "Hello",
    };

    await expect(executeSpecialist(node, makeContext())).rejects.toThrow(
      /agent name must not be empty/,
    );
  });
});
