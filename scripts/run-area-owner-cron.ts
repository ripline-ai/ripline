#!/usr/bin/env npx tsx
/**
 * Cron-friendly runner for the Ripline area-owner pipeline.
 * Runs the pipeline, writes the backlog artifact to a file, and prints a short
 * summary to stdout (suitable for email or Telegram).
 *
 * Usage:
 *   npx tsx scripts/run-area-owner-cron.ts
 *   npx tsx scripts/run-area-owner-cron.ts --out /path/to/backlog.json
 *
 * Env (optional):
 *   RIPLINE_INPUTS  Path to JSON inputs (default: samples/ripline-area-owner-inputs.json)
 *   RIPLINE_OUT     Path for backlog JSON (default: dist/backlog-cron.json)
 *
 * Cron example (daily 13:00 CT, email backlog summary):
 *   0 13 * * * cd /path/to/ripline && npx tsx scripts/run-area-owner-cron.ts 2>&1 | mail -s "Ripline backlog" you@example.com
 */
import path from "node:path";
import fs from "node:fs/promises";
import { loadPipelineDefinition } from "../src/lib/pipeline/loader.js";
import { DeterministicRunner, type RunnerOptions } from "../src/pipeline/runner.js";
import type { AgentRunner } from "../src/pipeline/executors/agent.js";
import { loadInputs } from "../src/cli/helpers.js";

const demoAgentRunner: AgentRunner = async ({ agentId, prompt }) => {
  return {
    text: `[cron] ${agentId}: ${prompt.slice(0, 80)}…`,
    tokenUsage: { input: 0, output: 0 },
  };
};

function backlogSummary(outputs: Record<string, unknown>): string {
  const backlog = outputs["ripline/backlog"] as Record<string, unknown> | undefined;
  if (!backlog) return "(no backlog artifact)";
  const text = backlog.text as string | undefined;
  if (typeof text === "string" && text.length > 0) {
    return text.slice(0, 500) + (text.length > 500 ? "…" : "");
  }
  return JSON.stringify(backlog).slice(0, 300) + (JSON.stringify(backlog).length > 300 ? "…" : "");
}

async function main(): Promise<void> {
  const cwd = process.cwd();
  const templatePath = path.resolve(cwd, "pipelines", "templates", "ripline-area-owner.yaml");
  const inputsPath = process.env.RIPLINE_INPUTS
    ? path.resolve(cwd, process.env.RIPLINE_INPUTS)
    : path.resolve(cwd, "samples", "ripline-area-owner-inputs.json");
  const outPath = process.env.RIPLINE_OUT
    ? path.resolve(cwd, process.env.RIPLINE_OUT)
    : path.resolve(cwd, "dist", "backlog-cron.json");

  const definition = loadPipelineDefinition(templatePath);
  const inputs = await loadInputs(inputsPath);

  const runnerOptions: RunnerOptions = {
    runsDir: path.join(cwd, ".ripline", "runs"),
    verbose: false,
    quiet: true,
    outPath,
    agentRunner: demoAgentRunner,
  };
  const runner = new DeterministicRunner(definition, runnerOptions);

  const record = await runner.run({ inputs });

  let outputs = record.outputs ?? {};
  if (Object.keys(outputs).length === 0 && outPath) {
    try {
      const raw = await fs.readFile(outPath, "utf8");
      outputs = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // keep outputs empty
    }
  }
  const summary = backlogSummary(outputs);
  const lines = [
    `Ripline area-owner run ${record.id}`,
    `Status: ${record.status}`,
    `Finished: ${new Date(record.finishedAt ?? Date.now()).toISOString()}`,
    ``,
    `Backlog summary:`,
    summary,
  ];
  console.log(lines.join("\n"));
}

main().catch((err) => {
  console.error("Ripline cron run failed:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
