#!/usr/bin/env node

function parseArgs(argv) {
  const result = {
    riplineUrl: process.env.RIPLINE_URL || "http://localhost:4001",
    dedupeInputKey: undefined,
    inputsJson: undefined,
    pipelineId: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--ripline-url") {
      result.riplineUrl = argv[++i];
    } else if (arg === "--dedupe-input-key") {
      result.dedupeInputKey = argv[++i];
    } else if (arg === "--inputs-json") {
      result.inputsJson = argv[++i];
    } else if (!result.pipelineId) {
      result.pipelineId = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!result.pipelineId) {
    throw new Error("Usage: enqueue-pipeline-run.mjs [--ripline-url URL] [--dedupe-input-key KEY] --inputs-json '{...}' <pipelineId>");
  }
  if (!result.inputsJson) {
    throw new Error("--inputs-json is required");
  }
  return result;
}

async function readJson(response) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON response: ${text}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const inputs = JSON.parse(args.inputsJson);

  if (args.dedupeInputKey) {
    const dedupeValue = inputs[args.dedupeInputKey];
    const runsResponse = await fetch(`${args.riplineUrl}/runs`);
    const runsPayload = await readJson(runsResponse);
    const runs = Array.isArray(runsPayload.runs) ? runsPayload.runs : [];
    const existing = runs.find((run) =>
      run &&
      run.pipelineId === args.pipelineId &&
      (run.status === "pending" || run.status === "running") &&
      run.inputs &&
      run.inputs[args.dedupeInputKey] === dedupeValue
    );
    if (existing) {
      console.log(`already queued as ${existing.id}`);
      return;
    }
  }

  const enqueueResponse = await fetch(`${args.riplineUrl}/pipelines/${encodeURIComponent(args.pipelineId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputs }),
  });
  const payload = await readJson(enqueueResponse);
  console.log(`queued ${args.pipelineId} as ${payload.runId ?? payload.id ?? "unknown"}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
