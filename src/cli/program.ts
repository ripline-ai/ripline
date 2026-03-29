import path from "node:path";
import os from "node:os";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { Command } from "commander";
import chalk from "chalk";
import type { AgentRunner } from "../pipeline/executors/agent.js";
import { loadPipelineDefinition, resolvePipelineFile } from "../lib/pipeline/loader.js";
import { DeterministicRunner, type RunnerOptions } from "../pipeline/runner.js";
import { loadInputs, parseEnvPairs } from "./helpers.js";
import { startServer } from "../server.js";
import { resolveStageConfig } from "../config.js";
import { PipelineRunStore } from "../run-store.js";
import { createRunQueue } from "../run-queue.js";
import { createLogger, createRunScopedFileSink, LOG_FILE_NAME } from "../log.js";
import { createLlmAgentRunner, type LlmAgentRunnerConfig } from "../llm-agent-runner.js";
import { createClaudeCodeRunner } from "../claude-code-runner.js";
import {
  resolveStandaloneLlmAgentConfig,
  resolveClaudeCodeConfig,
  loadAgentDefinitionsFromFile,
  loadSkillsRegistryFromFile,
} from "../agent-runner-config.js";
import { loadUserConfig, resolvePipelineDir, resolveProfileDir, resolveSkillsDir } from "../config.js";
import type { ContainerBuildConfig } from "../container-build-runner.js";
import { loadProfile, listProfiles, mergeInputs, mergeAgents, mergeSkills } from "../profiles.js";

export type RiplineCliOptions = {
  defaults?: {
    runsDir?: string;
    pipelinesDir?: string;
  };
  agentRunner?: AgentRunner;
  claudeCodeRunner?: AgentRunner;
};

function getVersion(): string {
  try {
    const p = path.join(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(p, "utf-8")) as { version?: string };
    return pkg.version ?? "0.1.0";
  } catch {
    return "0.1.0";
  }
}

function collectEnv(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

function collectQueue(value: string, acc: string[]): string[] {
  acc.push(value);
  return acc;
}

function parseQueueConcurrencies(flags: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const flag of flags) {
    const idx = flag.lastIndexOf(":");
    if (idx <= 0) {
      console.error(`Invalid --queue value "${flag}": expected format <name>:<concurrency>`);
      process.exit(1);
    }
    const name = flag.slice(0, idx).trim();
    const concurrency = parseInt(flag.slice(idx + 1), 10);
    if (!name || isNaN(concurrency) || concurrency < 1) {
      console.error(`Invalid --queue value "${flag}": name must be non-empty and concurrency must be a positive integer`);
      process.exit(1);
    }
    result[name] = concurrency;
  }
  return result;
}

export function createRiplineCliProgram(options: RiplineCliOptions = {}): Command {
  const program = new Command("ripline");
  const defaultRunsDir = options.defaults?.runsDir ?? path.join(process.cwd(), ".ripline", "runs");
  const defaultPipelinesDir = options.defaults?.pipelinesDir ?? path.join(process.cwd(), "pipelines");
  const defaultPipelinePath = path.join(defaultPipelinesDir, "examples", "hello-world.yaml");

  program
    .description("Pipeline runner: run pipelines by ID or path, list pipelines and profiles")
    .version(getVersion());

  program
    .command("run", { isDefault: false })
    .description("Run a pipeline by ID (from pipeline dir) or by path (--pipeline)")
    .argument("[pipelineId]", "Pipeline ID (filename without extension in pipeline dir)")
    .option("-p, --pipeline <path>", "Path to pipeline YAML/JSON (overrides pipelineId)")
    .option("--profile <name>", "Profile name (loads default inputs from ~/.ripline/profiles)")
    .option("-i, --input <json-or-path>", "Inputs as inline JSON or path to JSON file (overrides profile)")
    .option("--inputs <json-or-path>", "Alias for --input")
    .option("--pipeline-dir <path>", "Override pipeline directory (default: ~/.ripline/pipelines or config)")
    .option("--profile-dir <path>", "Override profile directory (default: ~/.ripline/profiles or config)")
    .option("--no-profile", "Disable default profile for this run")
    .option("-e, --env <key=value>", "Env key=value pairs merged into context (repeatable)", collectEnv, [])
    .option("--resume <runId>", "Resume a paused or failed run by ID")
    .option("-o, --out <path>", "Write final outputs to this JSON file")
    .option("--runs-dir <path>", "Directory for run state (default: .ripline/runs or RIPLINE_RUNS_DIR)")
    .option("-v, --verbose", "Pretty logging with node id/type/duration")
    .option("--demo", "Run with sample inputs and deterministic stub agent; writes to dist/demo-artifact.json")
    .option("--enqueue", "Add run to queue (pending) instead of executing inline; prints runId and exits")
    .option("--tail <mode>", "Tail mode: 'queue' = list (and optionally watch) queued work")
    .option("--follow", "With --tail queue: keep polling and printing queue state")
    .option("--agent-provider <provider>", "Standalone agent: ollama | openai | anthropic (or set RIPLINE_AGENT_PROVIDER)")
    .option("--agent-model <model>", "Standalone agent model (or set RIPLINE_AGENT_MODEL)")
    .option("--agent-base-url <url>", "Standalone agent base URL (or set RIPLINE_AGENT_BASE_URL)")
    .action(async (pipelineIdArg: string | undefined, opts) => {
      const homedir = os.homedir();
      const cwd = process.cwd();
      const userConfig = loadUserConfig(homedir);
      const pipelineDir = resolvePipelineDir({
        flag: opts.pipelineDir,
        cwd,
        homedir,
      });
      const profileDir = resolveProfileDir({ flag: opts.profileDir, homedir });
      const skillsDir = resolveSkillsDir({ homedir });

      const runsDirRaw = opts.runsDir ?? process.env.RIPLINE_RUNS_DIR ?? defaultRunsDir;
      const runsDir = path.isAbsolute(runsDirRaw) ? path.resolve(runsDirRaw) : path.join(cwd, runsDirRaw);
      const verbose = opts.verbose ?? false;
      const isDemo = opts.demo === true;
      const enqueue = opts.enqueue === true;
      const tailQueue = opts.tail === "queue";
      const follow = opts.follow === true;

      let definition;
      let explicitInput: Record<string, unknown> = {};
      const inputOpt = opts.input ?? opts.inputs;
      if (inputOpt) {
        try {
          explicitInput = await loadInputs(inputOpt);
        } catch (e) {
          console.error(chalk.red("Invalid --input/--inputs: " + (e instanceof Error ? e.message : String(e))));
          process.exit(1);
        }
      }

      let profile = null;
      if (!opts.noProfile) {
        const profileName = opts.profile ?? userConfig.defaultProfile;
        if (profileName) {
          try {
            profile = loadProfile(profileName, profileDir);
          } catch (e) {
            console.error(chalk.red("Profile: " + (e instanceof Error ? e.message : String(e))));
            process.exit(1);
          }
        }
      }
      const inputs = mergeInputs(profile, explicitInput);

      let outPath: string | undefined;
      let agentRunner: AgentRunner | undefined = options.agentRunner;
      let claudeCodeRunner: AgentRunner | undefined = options.claudeCodeRunner;

      if (tailQueue) {
        const store = new PipelineRunStore(runsDir);
        await store.init();
        const listAndPrint = async () => {
          const pending = await store.list({ status: "pending" });
          const running = await store.list({ status: "running" });
          const ts = new Date().toISOString();
          if (pending.length === 0 && running.length === 0) {
            console.log(chalk.gray(`[${ts}] queue: 0 pending, 0 running`));
          } else {
            console.log(chalk.cyan(`[${ts}] queue: ${pending.length} pending, ${running.length} running`));
            for (const r of pending) {
              console.log(chalk.gray(`  pending ${r.id} pipeline=${r.pipelineId} parentRunId=${r.parentRunId ?? "-"}`));
            }
            for (const r of running) {
              console.log(chalk.gray(`  running ${r.id} pipeline=${r.pipelineId}`));
            }
          }
        };
        await listAndPrint();
        if (follow) {
          const interval = setInterval(listAndPrint, 2000);
          process.on("SIGINT", () => {
            clearInterval(interval);
            process.exit(0);
          });
        }
        return;
      }

      const pipelinePath = opts.pipeline;
      const pipelineId = pipelineIdArg?.trim();
      if (pipelinePath) {
        definition = loadPipelineDefinition(path.resolve(pipelinePath));
      } else if (pipelineId) {
        try {
          const resolved = resolvePipelineFile(pipelineId, pipelineDir);
          definition = loadPipelineDefinition(resolved);
        } catch (e) {
          console.error(chalk.red(e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
      } else {
        if (enqueue || isDemo) {
          definition = loadPipelineDefinition(path.resolve(defaultPipelinePath));
        } else {
          console.error(chalk.red("Pipeline ID or --pipeline <path> required. Example: ripline run <pipelineId> or ripline run --pipeline path/to/pipeline.yaml"));
          process.exit(1);
        }
      }

      if (enqueue) {
        const store = new PipelineRunStore(runsDir);
        await store.init();
        const queue = createRunQueue(store);
        const runId = await queue.enqueue(definition.id, inputs);
        console.log(runId);
        return;
      }

      if (isDemo) {
        const samplePath = path.resolve(cwd, "samples", "hello-world-inputs.json");
        try {
          const sampleInputs = await loadInputs(samplePath);
          for (const k of Object.keys(inputs)) delete inputs[k];
          Object.assign(inputs, sampleInputs);
        } catch (e) {
          console.error(chalk.red("Demo failed: could not load samples/hello-world-inputs.json"));
          process.exit(1);
        }
        outPath = path.resolve(cwd, "dist", "demo-artifact.json");
        if (!agentRunner) {
          agentRunner = async ({ agentId, prompt }) => ({
            text: `[demo] ${agentId}: ${prompt.slice(0, 60)}…`,
            tokenUsage: { input: 0, output: 0 },
          });
        }
      } else {
        outPath = opts.out ? path.resolve(opts.out) : undefined;
        if (!agentRunner) {
          const overrides: Partial<LlmAgentRunnerConfig> = {};
          if (opts.agentProvider) overrides.provider = opts.agentProvider as LlmAgentRunnerConfig["provider"];
          if (opts.agentModel) overrides.model = opts.agentModel;
          if (opts.agentBaseUrl) overrides.baseURL = opts.agentBaseUrl;
          const hasOverrides = Object.keys(overrides).length > 0;
          const llmConfig = resolveStandaloneLlmAgentConfig(
            hasOverrides ? { cwd, overrides } : { cwd }
          );
          if (llmConfig) agentRunner = createLlmAgentRunner(llmConfig);
        }
        if (!claudeCodeRunner) {
          const claudeCodeConfig = resolveClaudeCodeConfig({ cwd, homedir });
          if (claudeCodeConfig) claudeCodeRunner = createClaudeCodeRunner(claudeCodeConfig);
        }
      }

      const env = parseEnvPairs(opts.env ?? []);

      const agentDefinitions = isDemo
        ? undefined
        : mergeAgents(
            { ...(loadAgentDefinitionsFromFile(pipelineDir) ?? {}), ...(loadAgentDefinitionsFromFile(cwd) ?? {}) },
            profile
          );

      const skillsRegistry = isDemo
        ? undefined
        : mergeSkills(
            { ...(loadSkillsRegistryFromFile(pipelineDir) ?? {}), ...(loadSkillsRegistryFromFile(cwd) ?? {}) },
            profile
          );

      const runnerOptions: RunnerOptions = {
        runsDir,
        verbose,
        quiet: true,
        log: createLogger({ sink: createRunScopedFileSink(runsDir) }),
        ...(outPath !== undefined && { outPath }),
        ...(agentRunner !== undefined && { agentRunner }),
        ...(claudeCodeRunner !== undefined && { claudeCodeRunner }),
        ...(agentDefinitions !== undefined && { agentDefinitions }),
        ...(skillsRegistry !== undefined && { skillsRegistry }),
        skillsDir,
      };
      const runner = new DeterministicRunner(definition, runnerOptions);

      const nodeStartedAt = new Map<string, number>();
      if (verbose) {
        runner.on("node.started", (e: { nodeId: string; nodeType: string; at: number }) => {
          nodeStartedAt.set(e.nodeId, e.at);
          console.log(chalk.cyan(`  → ${e.nodeId}`) + chalk.gray(` (${e.nodeType})`));
        });
        runner.on("node.completed", (e: { nodeId: string; nodeType: string; at: number }) => {
          const start = nodeStartedAt.get(e.nodeId);
          const duration = start != null ? `${e.at - start}ms` : "?";
          console.log(chalk.green(`  ✓ ${e.nodeId}`) + chalk.gray(` (${e.nodeType}, ${duration})`));
        });
        runner.on("node.errored", (e: { nodeId: string; nodeType: string; error: string }) => {
          console.error(chalk.red(`  ✗ ${e.nodeId}`) + chalk.gray(` (${e.nodeType})`) + chalk.red(` ${e.error}`));
        });
      }

      try {
        const runOpts: { inputs: Record<string, unknown>; resumeRunId?: string; env?: Record<string, string> } = {
          inputs,
        };
        if (opts.resume !== undefined) runOpts.resumeRunId = opts.resume;
        if (Object.keys(env).length > 0) runOpts.env = env;
        const record = await runner.run(runOpts);

        if (!verbose) {
          console.log(`Run ${record.id} → ${path.join(runsDir, record.id, "run.json")}`);
        }
        if (record.status === "paused") {
          console.log(chalk.yellow(`Paused at checkpoint; resume with: --resume ${record.id}`));
        }
        if (outPath) {
          console.log(chalk.gray(`Outputs → ${outPath}`));
        }
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });

  const pipelinesCmd = program
    .command("pipelines")
    .description("List or inspect pipelines");
  pipelinesCmd
    .command("list")
    .description("List pipeline IDs, names, and entry nodes from the pipeline directory")
    .option("--pipeline-dir <path>", "Override pipeline directory")
    .action(async (opts) => {
      const homedir = os.homedir();
      const pipelineDir = resolvePipelineDir({
        flag: opts.pipelineDir,
        cwd: process.cwd(),
        homedir,
      });
      const fs = await import("node:fs");
      const entries = fs.readdirSync(pipelineDir, { withFileTypes: true }).filter(
        (e) => e.isFile() && /\.(ya?ml|json)$/i.test(e.name)
      );
      const rows: { id: string; name: string; entry: string }[] = [];
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const stem = e.name.replace(/\.(yaml|yml|json)$/i, "");
        const filePath = path.join(pipelineDir, e.name);
        try {
          const def = loadPipelineDefinition(filePath);
          const entryStr = def.entry?.length ? `[${def.entry.join(", ")}]` : "—";
          rows.push({ id: stem, name: def.name ?? stem, entry: entryStr });
        } catch {
          rows.push({ id: stem, name: "(invalid)", entry: "—" });
        }
      }
      const idLen = Math.max(3, ...rows.map((r) => r.id.length));
      const nameLen = Math.max(4, ...rows.map((r) => r.name.length));
      console.log(
        chalk.cyan(
          "ID".padEnd(idLen) + "  " + "NAME".padEnd(nameLen) + "  " + "ENTRY"
        )
      );
      for (const r of rows) {
        console.log(r.id.padEnd(idLen) + "  " + r.name.padEnd(nameLen) + "  " + r.entry);
      }
    });

  const profilesCmd = program
    .command("profiles")
    .description("List or manage input profiles");
  profilesCmd
    .command("list")
    .description("List all profiles (name, description, input keys)")
    .option("--profile-dir <path>", "Override profile directory")
    .action(async (opts) => {
      const profileDir = resolveProfileDir({ flag: opts.profileDir, homedir: os.homedir() });
      const profiles = listProfiles(profileDir);
      const nameLen = Math.max(4, ...profiles.map((p) => p.name.length));
      const descLen = Math.max(11, ...profiles.map((p) => (p.description ?? "").length));
      console.log(
        chalk.cyan(
          "NAME".padEnd(nameLen) + "  " + "DESCRIPTION".padEnd(descLen) + "  " + "INPUTS"
        )
      );
      for (const p of profiles) {
        const inputKeys = Object.keys(p.inputs).join(", ") || "—";
        console.log(
          (p.name ?? "").padEnd(nameLen) + "  " +
          (p.description ?? "").padEnd(descLen) + "  " +
          inputKeys
        );
      }
    });
  profilesCmd
    .command("show <name>")
    .description("Show a profile's inputs")
    .option("--profile-dir <path>", "Override profile directory")
    .action(async (name: string, opts) => {
      const profileDir = resolveProfileDir({ flag: opts.profileDir, homedir: os.homedir() });
      try {
        const p = loadProfile(name, profileDir);
        console.log(chalk.cyan("name: ") + p.name);
        if (p.description) console.log(chalk.cyan("description: ") + p.description);
        console.log(chalk.cyan("inputs:"));
        for (const [k, v] of Object.entries(p.inputs)) {
          console.log("  " + k + ": " + JSON.stringify(v));
        }
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });
  profilesCmd
    .command("create <name>")
    .description("Create a new profile (template YAML); opens $EDITOR unless --no-edit")
    .option("--profile-dir <path>", "Override profile directory")
    .option("--no-edit", "Only write template and print path; do not open editor")
    .action(async (name: string, opts) => {
      const profileDir = resolveProfileDir({ flag: opts.profileDir, homedir: os.homedir() });
      const fs = await import("node:fs");
      const base = name.replace(/[/\\]/g, "");
      if (base !== name || !base) {
        console.error(chalk.red("Invalid profile name: " + name));
        process.exit(1);
      }
      fs.mkdirSync(profileDir, { recursive: true });
      const filePath = path.join(profileDir, base + ".yaml");
      const template = `name: ${base}\ndescription: ""\ninputs: {}\n`;
      fs.writeFileSync(filePath, template, "utf-8");
      // Commander exposes --no-edit as opts.edit === false
      if (opts.edit === false) {
        console.log(filePath);
        return;
      }
      const editor = process.env.EDITOR ?? process.env.VISUAL;
      if (editor) {
        // Use shell so EDITOR values with args (e.g. "code --wait", "vim -p") work
        const cmd = `${editor} ${JSON.stringify(filePath)}`;
        spawn(cmd, { stdio: "inherit", shell: true });
      } else {
        console.log(chalk.gray("No $EDITOR set. Profile created at: " + filePath));
      }
    });
  profilesCmd
    .command("validate <name>")
    .description("Validate a profile (exit 0 if valid)")
    .option("--profile-dir <path>", "Override profile directory")
    .action(async (name: string, opts) => {
      const profileDir = resolveProfileDir({ flag: opts.profileDir, homedir: os.homedir() });
      try {
        loadProfile(name, profileDir);
        console.log("Valid");
      } catch (e) {
        console.error(chalk.red(e instanceof Error ? e.message : String(e)));
        process.exit(1);
      }
    });

  program
    .command("logs <runId>")
    .description("Print logs for a run (from local runs dir or --api-url). Use --follow to stream new lines until run completes.")
    .option("--runs-dir <path>", "Run state directory (or set RIPLINE_RUNS_DIR)", defaultRunsDir)
    .option("--follow", "Poll and print new log lines until run is completed or errored (or Ctrl+C)")
    .option("--api-url <url>", "If set, fetch logs from HTTP API (e.g. http://localhost:4001) instead of local runs dir")
    .action(async (runId: string, opts) => {
      const runsDirRaw = opts.runsDir ?? process.env.RIPLINE_RUNS_DIR ?? defaultRunsDir;
      const runsDir = path.isAbsolute(runsDirRaw) ? path.resolve(runsDirRaw) : path.join(process.cwd(), runsDirRaw);
      const apiUrl = opts.apiUrl?.trim();
      const follow = opts.follow === true;

      const logPath = path.join(runsDir, runId, LOG_FILE_NAME);
      const runJsonPath = path.join(runsDir, runId, "run.json");
      const fs = await import("node:fs/promises");

      async function readLocalLogs(): Promise<string> {
        try {
          return await fs.readFile(logPath, "utf8");
        } catch (e) {
          if ((e as NodeJS.ErrnoException)?.code === "ENOENT") {
            return "";
          }
          throw e;
        }
      }

      async function isRunTerminal(): Promise<boolean> {
        try {
          const data = await fs.readFile(runJsonPath, "utf8");
          const record = JSON.parse(data) as { status?: string };
          return record.status === "completed" || record.status === "errored";
        } catch {
          return false;
        }
      }

      if (apiUrl) {
        const base = apiUrl.replace(/\/$/, "");
        const authHeader = process.env.RIPLINE_AUTH_TOKEN
          ? { Authorization: `Bearer ${process.env.RIPLINE_AUTH_TOKEN}` }
          : {};
        if (!follow) {
          const res = await fetch(`${base}/runs/${runId}/logs`, { headers: authHeader });
          if (res.status === 404) {
            console.error(chalk.red(`Run or logs not found: ${runId}`));
            process.exit(1);
          }
          if (!res.ok) {
            console.error(chalk.red(`API error: ${res.status} ${await res.text()}`));
            process.exit(1);
          }
          const text = await res.text();
          process.stdout.write(text);
          return;
        }
        const res = await fetch(`${base}/runs/${runId}/logs/stream`, { headers: authHeader });
        if (res.status === 404 || !res.ok) {
          console.error(chalk.red(`Run or logs not found: ${runId}`));
          process.exit(1);
        }
        const reader = res.body?.getReader();
        if (!reader) {
          console.error(chalk.red("No response body"));
          process.exit(1);
        }
        const decoder = new TextDecoder();
        let buf = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n\n");
            buf = lines.pop() ?? "";
            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const json = JSON.parse(line.slice(6)) as { lines?: string };
                if (typeof json.lines === "string") process.stdout.write(json.lines);
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
        return;
      }

      if (!follow) {
        const content = await readLocalLogs();
        process.stdout.write(content);
        return;
      }

      let lastSize = 0;
      process.on("SIGINT", () => process.exit(0));
      for (;;) {
        try {
          const content = await readLocalLogs();
          if (content.length > lastSize) {
            process.stdout.write(content.slice(lastSize));
            lastSize = content.length;
          }
        } catch (e) {
          console.error(chalk.red(e instanceof Error ? e.message : String(e)));
          process.exit(1);
        }
        if (await isRunTerminal()) break;
        await new Promise((r) => setTimeout(r, 500));
      }
    });

  program
    .command("retry <runId>")
    .description("Retry a failed or paused run via the HTTP API")
    .option("--from-start", "Restart the entire pipeline from scratch instead of resuming from the failed step")
    .option("--api-url <url>", "HTTP API base URL (default: http://localhost:4001 or RIPLINE_API_URL)")
    .action(async (runId: string, opts) => {
      const apiUrl = (opts.apiUrl?.trim() ?? process.env.RIPLINE_API_URL ?? "http://localhost:4001").replace(/\/$/, "");
      const strategy = opts.fromStart ? "from-start" : "from-failure";
      const authHeader: Record<string, string> = process.env.RIPLINE_AUTH_TOKEN
        ? { Authorization: `Bearer ${process.env.RIPLINE_AUTH_TOKEN}` }
        : {};

      let res: Response;
      try {
        res = await fetch(`${apiUrl}/runs/${runId}/retry`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeader },
          body: JSON.stringify({ strategy }),
        });
      } catch (e) {
        console.error(chalk.red(`Failed to connect to ${apiUrl}: ${e instanceof Error ? e.message : String(e)}`));
        process.exit(1);
      }

      const body = await res.json() as Record<string, unknown>;

      if (res.status === 404) {
        console.error(chalk.red(`Run not found: ${runId}`));
        process.exit(1);
      }
      if (res.status === 409) {
        console.error(chalk.red(String(body.message ?? `Run ${runId} is not in a retryable state`)));
        process.exit(1);
      }
      if (!res.ok) {
        console.error(chalk.red(String(body.message ?? `HTTP ${res.status}`)));
        process.exit(1);
      }

      console.log(chalk.green(`Retry accepted for run ${body.runId}`));
      console.log(chalk.gray(`  strategy: ${body.strategy}`));
      console.log(chalk.gray(`  from node: ${body.fromNode}`));
    });

  program
    .command("serve")
    .description("Start the HTTP API server (GET /pipelines, POST /pipelines/:id/run, GET /runs, GET /runs/:runId, GET /runs/:runId/stream, GET /runs/:runId/logs, GET /metrics)")
    .option("--port <number>", `Port (default: ${resolveStageConfig().port})`, String(resolveStageConfig().port))
    .option("--pipelines-dir <path>", "Pipelines directory", defaultPipelinesDir)
    .option("--runs-dir <path>", "Run state directory (or set RIPLINE_RUNS_DIR)", defaultRunsDir)
    .option("--max-concurrency <n>", "Max concurrent pipeline runs for the default queue (0 = inline; default 1)", "1")
    .option("--queue <name:concurrency>", "Per-queue concurrency (repeatable). E.g. --queue spec:3 --queue build:1", collectQueue, [])
    .option("--auth-token <token>", "Optional bearer token for API auth")
    .option("--agent-provider <provider>", "Standalone agent: ollama | openai | anthropic")
    .option("--agent-model <model>", "Standalone agent model")
    .option("--agent-base-url <url>", "Standalone agent base URL")
    .action(async (opts) => {
      const port = parseInt(opts.port, 10);
      const maxConcurrency = Math.max(0, parseInt(opts.maxConcurrency, 10) || 0);
      const queueFlags: string[] = opts.queue ?? [];
      const queueConcurrencies = queueFlags.length > 0 ? parseQueueConcurrencies(queueFlags) : undefined;
      const pipelinesDir = path.resolve(process.cwd(), opts.pipelinesDir ?? defaultPipelinesDir);
      const runsDirRaw = opts.runsDir ?? process.env.RIPLINE_RUNS_DIR ?? defaultRunsDir;
      const runsDir = path.isAbsolute(runsDirRaw) ? path.resolve(runsDirRaw) : path.join(process.cwd(), runsDirRaw);
      const agentOverrides: Partial<LlmAgentRunnerConfig> = {};
      if (opts.agentProvider) agentOverrides.provider = opts.agentProvider as LlmAgentRunnerConfig["provider"];
      if (opts.agentModel) agentOverrides.model = opts.agentModel;
      if (opts.agentBaseUrl) agentOverrides.baseURL = opts.agentBaseUrl;
      const hasAgentOverrides = Object.keys(agentOverrides).length > 0;
      const llmConfig = resolveStandaloneLlmAgentConfig(
        hasAgentOverrides ? { cwd: process.cwd(), overrides: agentOverrides } : { cwd: process.cwd() }
      );
      const agentRunner = llmConfig ? createLlmAgentRunner(llmConfig) : undefined;
      const claudeCodeConfig = resolveClaudeCodeConfig({ cwd: process.cwd(), homedir: os.homedir() });
      const claudeCodeRunner = claudeCodeConfig ? createClaudeCodeRunner(claudeCodeConfig) : undefined;
      // Load user config early so queue logging and container build config are both available
      const serveUserConfig = loadUserConfig(os.homedir());
      console.log(chalk.cyan(`Starting HTTP server on port ${port}`));
      console.log(chalk.gray(`  pipelines: ${pipelinesDir}`));
      console.log(chalk.gray(`  runs: ${runsDir}`));
      console.log(chalk.gray(`  maxConcurrency (default queue): ${maxConcurrency}`));
      if (queueConcurrencies) {
        for (const [name, n] of Object.entries(queueConcurrencies)) {
          console.log(chalk.gray(`  queue "${name}": ${n} worker(s) (CLI override)`));
        }
      }
      // Log per-queue config from user config (concurrency + resource limits)
      if (serveUserConfig.queues) {
        for (const [name, qc] of Object.entries(serveUserConfig.queues)) {
          const limitsStr = qc.resourceLimits
            ? ` [cpus=${qc.resourceLimits.cpus ?? "unlimited"}, mem=${qc.resourceLimits.memory ?? "unlimited"}]`
            : "";
          console.log(chalk.gray(`  queue "${name}": concurrency=${qc.concurrency}${limitsStr} (config)`));
        }
      }
      if (opts.authToken) console.log(chalk.gray("  auth: Bearer token required"));
      if (agentRunner) console.log(chalk.gray("  agent: LLM runner (standalone)"));
      if (claudeCodeRunner) console.log(chalk.gray("  agent: Claude Code runner (standalone)"));

      // Resolve container build config from user config
      let containerBuild: ContainerBuildConfig | undefined;
      if (serveUserConfig.containerBuild?.enabled) {
        const cbUser = serveUserConfig.containerBuild;
        const repoPath = cbUser.repoPath ?? process.cwd();
        containerBuild = {
          repoPath,
          ...(cbUser.targetBranch !== undefined && { targetBranch: cbUser.targetBranch }),
          ...(cbUser.buildImage !== undefined && { buildImage: cbUser.buildImage }),
          ...(cbUser.testCommand !== undefined && { testCommand: cbUser.testCommand }),
          ...(cbUser.secretsMountPath !== undefined && { secretsMountPath: cbUser.secretsMountPath }),
          ...(cbUser.containerTimeoutMs !== undefined && { containerTimeoutMs: cbUser.containerTimeoutMs }),
        };
        console.log(chalk.gray(`  containerBuild: enabled (repo=${repoPath}, target=${cbUser.targetBranch ?? "main"})`));
      }

      const { close } = await startServer({
        pipelinesDir,
        runsDir,
        httpPort: port,
        maxConcurrency,
        ...(queueConcurrencies !== undefined && { queueConcurrencies }),
        ...(opts.authToken && { authToken: opts.authToken }),
        ...(agentRunner && { agentRunner }),
        ...(claudeCodeRunner && { claudeCodeRunner }),
        ...(containerBuild !== undefined && { containerBuild }),
      });
      process.on("SIGINT", () => close().then(() => process.exit(0)));
      process.on("SIGTERM", () => close().then(() => process.exit(0)));
    });

  return program;
}
