import { describe, expect, it } from "vitest";
import {
  normalizeClaudeCodeConfigFromPlugin,
  resolveClaudeCodeConfigFromEnv,
} from "../src/agent-runner-config.js";

describe("Claude Code config – model", () => {
  describe("normalizeClaudeCodeConfigFromPlugin", () => {
    it("sets model when claudeCode.model is a non-empty string", () => {
      const config = normalizeClaudeCodeConfigFromPlugin({
        claudeCode: { mode: "execute", model: "claude-sonnet-4-6" },
      });
      expect(config).not.toBeNull();
      expect(config?.model).toBe("claude-sonnet-4-6");
    });

    it("trims model", () => {
      const config = normalizeClaudeCodeConfigFromPlugin({
        claudeCode: { mode: "plan", model: "  claude-opus-4-6  " },
      });
      expect(config).not.toBeNull();
      expect(config?.model).toBe("claude-opus-4-6");
    });

    it("omits model when claudeCode.model is empty string", () => {
      const config = normalizeClaudeCodeConfigFromPlugin({
        claudeCode: { mode: "execute", model: "" },
      });
      expect(config).not.toBeNull();
      expect(config?.model).toBeUndefined();
    });

    it("omits model when claudeCode.model is not a string", () => {
      const config = normalizeClaudeCodeConfigFromPlugin({
        claudeCode: { mode: "execute", model: 123 },
      } as unknown as { claudeCode: { mode: string; model: number } });
      expect(config).not.toBeNull();
      expect(config?.model).toBeUndefined();
    });
  });

  describe("resolveClaudeCodeConfigFromEnv", () => {
    it("sets model when RIPLINE_CLAUDE_CODE_MODEL is set", () => {
      const config = resolveClaudeCodeConfigFromEnv({
        RIPLINE_CLAUDE_CODE_MODE: "execute",
        RIPLINE_CLAUDE_CODE_MODEL: "claude-sonnet-4-6",
      });
      expect(config).not.toBeNull();
      expect(config?.model).toBe("claude-sonnet-4-6");
    });

    it("omits model when RIPLINE_CLAUDE_CODE_MODEL is not set", () => {
      const config = resolveClaudeCodeConfigFromEnv({
        RIPLINE_CLAUDE_CODE_MODE: "execute",
      });
      expect(config).not.toBeNull();
      expect(config?.model).toBeUndefined();
    });
  });
});
