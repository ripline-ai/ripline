/**
 * voice-registry.ts
 *
 * Detects installed AI CLIs and maps AgentLineage values to available
 * AgentRunner instances. Runners are injected by the caller — the registry
 * itself never constructs them.
 */

import { execSync } from "node:child_process";
import type { AgentLineage } from "./review-phase-types.js";
import type { AgentRunner } from "./pipeline/executors/agent.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type VoiceRegistryEntry = {
  lineage: AgentLineage;
  binaryName: string;
  detectedPath: string | null;
  runner: AgentRunner;
};

export type VoiceRegistry = {
  resolve(lineage: AgentLineage): AgentRunner | null;
  list(): VoiceRegistryEntry[];
};

export type VoiceRegistryOptions = {
  claudeCodeRunner?: AgentRunner;
  codexRunner?: AgentRunner;
  geminiRunner?: AgentRunner;
  kimiRunner?: AgentRunner;
  opencodeRunner?: AgentRunner;
};

// ---------------------------------------------------------------------------
// Binary mapping
// ---------------------------------------------------------------------------

type LineageMapping = {
  lineage: Exclude<AgentLineage, "any">;
  binaryName: string;
  runnerKey: keyof VoiceRegistryOptions;
};

const LINEAGE_MAPPINGS: LineageMapping[] = [
  { lineage: "anthropic", binaryName: "claude", runnerKey: "claudeCodeRunner" },
  { lineage: "openai", binaryName: "codex", runnerKey: "codexRunner" },
  { lineage: "google", binaryName: "gemini", runnerKey: "geminiRunner" },
  { lineage: "moonshot", binaryName: "kimi", runnerKey: "kimiRunner" },
  { lineage: "opencode", binaryName: "opencode", runnerKey: "opencodeRunner" },
];

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function detectBinary(binaryName: string): string | null {
  const cmd =
    process.platform === "win32"
      ? `where ${binaryName}`
      : `which ${binaryName}`;
  try {
    const result = execSync(cmd, { stdio: "pipe" });
    return result.toString().trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createVoiceRegistry(options?: VoiceRegistryOptions): VoiceRegistry {
  const opts = options ?? {};

  // Build entries for concrete lineages (i.e. everything except "any")
  const entries: VoiceRegistryEntry[] = [];

  for (const mapping of LINEAGE_MAPPINGS) {
    const injectedRunner = opts[mapping.runnerKey];
    const detectedPath = detectBinary(mapping.binaryName);

    if (injectedRunner) {
      entries.push({
        lineage: mapping.lineage,
        binaryName: mapping.binaryName,
        detectedPath,
        runner: injectedRunner,
      });
    } else if (detectedPath !== null) {
      // Binary found on PATH but no runner was provided for it
      console.warn(
        `[voice-registry] Binary "${mapping.binaryName}" detected at ${detectedPath} ` +
          `for lineage "${mapping.lineage}" but no runner was injected. ` +
          `Provide a ${mapping.runnerKey} option to make this lineage available.`
      );
      // Intentionally NOT added to entries — runner is null so lineage is unavailable
    }
    // If neither injected nor detected: silently unavailable
  }

  function resolve(lineage: AgentLineage): AgentRunner | null {
    if (lineage === "any") {
      // Prefer anthropic, then iterate in declaration order
      const anthropicEntry = entries.find((e) => e.lineage === "anthropic");
      if (anthropicEntry) return anthropicEntry.runner;
      const first = entries[0];
      return first ? first.runner : null;
    }

    const entry = entries.find((e) => e.lineage === lineage);
    return entry ? entry.runner : null;
  }

  function list(): VoiceRegistryEntry[] {
    return [...entries];
  }

  return { resolve, list };
}
