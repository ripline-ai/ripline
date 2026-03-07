#!/usr/bin/env node
/**
 * Quick-run the Ripline area-owner template with sample inputs and a stub agent.
 * From project root:
 *   npx tsx scripts/run-area-owner-demo.ts
 * Or after build, run the CLI with template + sample inputs:
 *   node dist/cli/run.js -p pipelines/templates/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json -o dist/demo-artifact.json
 */
import path from "node:path";
import { loadPipelineDefinition } from "../src/lib/pipeline/loader.js";
import { DeterministicRunner, type RunnerOptions } from "../src/pipeline/runner.js";
import type { AgentRunner } from "../src/pipeline/executors/agent.js";
import { loadInputs } from "../src/cli/helpers.js";

const demoAgentRunner: AgentRunner = async ({ agentId, prompt }) => {
  return {
    text: `[demo] ${agentId}: ${prompt.slice(0, 60)}…`,
    tokenUsage: { input: 0, output: 0 },
  };
};

async function main(): Promise<void> {
  const cwd = process.cwd();
  const templatePath = path.resolve(cwd, "pipelines", "templates", "ripline-area-owner.yaml");
  const samplePath = path.resolve(cwd, "samples", "ripline-area-owner-inputs.json");
  const outPath = path.resolve(cwd, "dist", "demo-artifact.json");

  const definition = loadPipelineDefinition(templatePath);
  const inputs = await loadInputs(samplePath);

  const runnerOptions: RunnerOptions = {
    runsDir: path.join(cwd, ".ripline", "runs"),
    verbose: true,
    quiet: false,
    outPath,
    agentRunner: demoAgentRunner,
  };
  const runner = new DeterministicRunner(definition, runnerOptions);

  const record = await runner.run({ inputs });
  console.log(`Run ${record.id} complete. Outputs → ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
