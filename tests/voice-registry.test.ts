import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { AgentRunner } from "../src/pipeline/executors/agent.js";

// ---------------------------------------------------------------------------
// Mock child_process before importing the module under test
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

// Import after mock registration so the module picks up the mock
import { execSync } from "node:child_process";
import { createVoiceRegistry } from "../src/voice-registry.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunner(): AgentRunner {
  return {
    async *run() {
      yield { type: "message_done" as const, text: "ok" };
    },
  };
}

type ExecSyncMock = ReturnType<typeof vi.fn>;

/** Set up execSync to return a path for the given binary names and throw for others. */
function mockBinaries(present: Record<string, string>): void {
  (execSync as unknown as ExecSyncMock).mockImplementation((cmd: string) => {
    for (const [binary, resolvedPath] of Object.entries(present)) {
      if (cmd.includes(binary)) {
        return Buffer.from(resolvedPath);
      }
    }
    throw new Error("not found");
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createVoiceRegistry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- resolve: concrete lineages ----------------------------------------

  it("resolves anthropic lineage when claudeCodeRunner is injected and binary present", () => {
    mockBinaries({ claude: "/usr/local/bin/claude" });
    const runner = makeRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: runner });
    expect(registry.resolve("anthropic")).toBe(runner);
  });

  it("resolves openai lineage when codexRunner is injected", () => {
    mockBinaries({ codex: "/usr/local/bin/codex" });
    const runner = makeRunner();
    const registry = createVoiceRegistry({ codexRunner: runner });
    expect(registry.resolve("openai")).toBe(runner);
  });

  it("resolves google lineage when geminiRunner is injected", () => {
    mockBinaries({ gemini: "/usr/local/bin/gemini" });
    const runner = makeRunner();
    const registry = createVoiceRegistry({ geminiRunner: runner });
    expect(registry.resolve("google")).toBe(runner);
  });

  it("resolves moonshot lineage when kimiRunner is injected", () => {
    mockBinaries({ kimi: "/usr/local/bin/kimi" });
    const runner = makeRunner();
    const registry = createVoiceRegistry({ kimiRunner: runner });
    expect(registry.resolve("moonshot")).toBe(runner);
  });

  it("resolves opencode lineage when opencodeRunner is injected", () => {
    mockBinaries({ opencode: "/usr/local/bin/opencode" });
    const runner = makeRunner();
    const registry = createVoiceRegistry({ opencodeRunner: runner });
    expect(registry.resolve("opencode")).toBe(runner);
  });

  // ---- resolve: binary absent, runner injected ---------------------------

  it("resolves lineage even when binary is absent if runner is injected", () => {
    mockBinaries({}); // nothing found
    const runner = makeRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: runner });
    expect(registry.resolve("anthropic")).toBe(runner);
  });

  // ---- resolve: binary present, no runner --------------------------------

  it("returns null when binary is detected but no runner was injected", () => {
    mockBinaries({ claude: "/usr/local/bin/claude" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const registry = createVoiceRegistry({}); // no claudeCodeRunner
    expect(registry.resolve("anthropic")).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Binary "claude" detected')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("no runner was injected")
    );
  });

  // ---- resolve: nothing available ----------------------------------------

  it("returns null when binary absent and no runner injected", () => {
    mockBinaries({});
    const registry = createVoiceRegistry();
    expect(registry.resolve("anthropic")).toBeNull();
    expect(registry.resolve("openai")).toBeNull();
    expect(registry.resolve("google")).toBeNull();
    expect(registry.resolve("moonshot")).toBeNull();
    expect(registry.resolve("opencode")).toBeNull();
  });

  // ---- resolve: any -------------------------------------------------------

  it("resolve('any') returns anthropic runner when anthropic is available", () => {
    mockBinaries({});
    const anthropicRunner = makeRunner();
    const codexRunner = makeRunner();
    const registry = createVoiceRegistry({
      claudeCodeRunner: anthropicRunner,
      codexRunner,
    });
    expect(registry.resolve("any")).toBe(anthropicRunner);
  });

  it("resolve('any') falls back to first available when anthropic is absent", () => {
    mockBinaries({});
    const codexRunner = makeRunner();
    const registry = createVoiceRegistry({ codexRunner });
    expect(registry.resolve("any")).toBe(codexRunner);
  });

  it("resolve('any') returns null when no runners are available", () => {
    mockBinaries({});
    const registry = createVoiceRegistry();
    expect(registry.resolve("any")).toBeNull();
  });

  // ---- list ---------------------------------------------------------------

  it("list returns only entries that have runners", () => {
    mockBinaries({ claude: "/usr/local/bin/claude", codex: "/usr/local/bin/codex" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const anthropicRunner = makeRunner();
    // codex binary present but no codexRunner injected
    const registry = createVoiceRegistry({ claudeCodeRunner: anthropicRunner });
    const entries = registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].lineage).toBe("anthropic");
    expect(entries[0].binaryName).toBe("claude");
    expect(entries[0].detectedPath).toBe("/usr/local/bin/claude");
    expect(entries[0].runner).toBe(anthropicRunner);
    // Codex was detected but no runner → warning emitted
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("codex"));
  });

  it("list returns empty array when no runners are available", () => {
    mockBinaries({});
    const registry = createVoiceRegistry();
    expect(registry.list()).toEqual([]);
  });

  it("list includes detectedPath null when binary is absent but runner is injected", () => {
    mockBinaries({}); // no binaries found
    const runner = makeRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: runner });
    const entries = registry.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].detectedPath).toBeNull();
  });

  it("list returns a copy — mutating it does not affect registry", () => {
    mockBinaries({});
    const runner = makeRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: runner });
    const first = registry.list();
    first.pop();
    expect(registry.list()).toHaveLength(1);
  });

  // ---- multiple runners ---------------------------------------------------

  it("resolves multiple lineages independently", () => {
    mockBinaries({});
    const claudeRunner = makeRunner();
    const codexRunner = makeRunner();
    const geminiRunner = makeRunner();
    const registry = createVoiceRegistry({
      claudeCodeRunner: claudeRunner,
      codexRunner,
      geminiRunner,
    });
    expect(registry.resolve("anthropic")).toBe(claudeRunner);
    expect(registry.resolve("openai")).toBe(codexRunner);
    expect(registry.resolve("google")).toBe(geminiRunner);
    expect(registry.resolve("moonshot")).toBeNull();
    expect(registry.resolve("opencode")).toBeNull();
    expect(registry.list()).toHaveLength(3);
  });

  // ---- Windows path (process.platform branching) -------------------------

  it("uses 'where' command on win32 platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    (execSync as unknown as ExecSyncMock).mockReturnValue(Buffer.from("C:\\tools\\claude.exe"));

    const runner = makeRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: runner });
    const calls = (execSync as unknown as ExecSyncMock).mock.calls as string[][];
    expect(calls.some((args) => args[0].startsWith("where "))).toBe(true);
    expect(registry.resolve("anthropic")).toBe(runner);

    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });

  it("uses 'which' command on non-win32 platform", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    (execSync as unknown as ExecSyncMock).mockReturnValue(Buffer.from("/usr/bin/claude"));

    const runner = makeRunner();
    const registry = createVoiceRegistry({ claudeCodeRunner: runner });
    const calls = (execSync as unknown as ExecSyncMock).mock.calls as string[][];
    expect(calls.some((args) => args[0].startsWith("which "))).toBe(true);
    expect(registry.resolve("anthropic")).toBe(runner);

    Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  });
});
