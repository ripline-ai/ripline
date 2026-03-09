import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  resolveClaudeCodeConfig,
  normalizeClaudeCodeConfigFromPlugin,
} from "../src/agent-runner-config.js";

describe("resolveClaudeCodeConfig", () => {
  it("sets allowDangerouslySkipPermissions from env when RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS=true", () => {
    const config = resolveClaudeCodeConfig({
      env: { RIPLINE_CLAUDE_CODE_DANGEROUSLY_SKIP_PERMISSIONS: "true" },
    });
    expect(config).not.toBeNull();
    expect(config!.allowDangerouslySkipPermissions).toBe(true);
  });

  it("sets allowDangerouslySkipPermissions from user config when ~/.ripline/config.json has claudeCode.allowDangerouslySkipPermissions", () => {
    const homedir = path.join(os.tmpdir(), "ripline-claude-config-" + Date.now());
    const configDir = path.join(homedir, ".ripline");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ claudeCode: { allowDangerouslySkipPermissions: true } }),
      "utf-8"
    );
    try {
      const config = resolveClaudeCodeConfig({ env: {}, homedir });
      expect(config).not.toBeNull();
      expect(config!.allowDangerouslySkipPermissions).toBe(true);
    } finally {
      fs.rmSync(homedir, { recursive: true, force: true });
    }
  });

  it("does not set allowDangerouslySkipPermissions when neither env nor user config set it", () => {
    const homedir = path.join(os.tmpdir(), "ripline-claude-config-" + Date.now());
    fs.mkdirSync(homedir, { recursive: true });
    try {
      const config = resolveClaudeCodeConfig({ env: {}, homedir });
      expect(config).not.toBeNull();
      expect(config!.allowDangerouslySkipPermissions).toBe(false);
    } finally {
      fs.rmSync(homedir, { recursive: true, force: true });
    }
  });
});

describe("normalizeClaudeCodeConfigFromPlugin", () => {
  it("does not set allowDangerouslySkipPermissions from plugin/pipeline config", () => {
    const config = normalizeClaudeCodeConfigFromPlugin({
      claudeCode: {
        mode: "execute",
        cwd: "/tmp",
        allowDangerouslySkipPermissions: true,
      },
    });
    expect(config).not.toBeNull();
    expect(config!.allowDangerouslySkipPermissions).toBeUndefined();
  });
});
