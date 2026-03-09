# Migrating pipelines from OpenClaw

OpenClaw pipelines often hardcode absolute paths in prompts and node config. Ripline’s **profiles** and **pipeline inputs** let you keep the same pipeline YAML and switch contexts (paths, projects) via profiles and `--input` without editing the pipeline file.

## Why paths are hardcoded in OpenClaw

In OpenClaw, pipelines typically assume a fixed workspace layout and use absolute paths in prompt strings, for example:

```yaml
prompt: |
  Read project states: ls /home/openclaw/.openclaw/workspace/kanban/projects/
  Write ideas to: /home/openclaw/.openclaw/workspace/kanban/ideas/
```

Those paths are **inside prompt text**, not pipeline inputs. Ripline cannot automatically replace them; you migrate by turning them into **inputs** and then supplying values via **profiles** or `--input`.

## Step 1 — Extract paths into pipeline inputs

Replace hardcoded paths in prompts (and in node fields like `cwd`) with template variables that reference run inputs:

```yaml
# Before
prompt: "Read project states from /home/openclaw/.openclaw/workspace/kanban/projects/"

# After
prompt: "Read project states from {{ run.inputs.projectsPath }}"
```

Do the same for any other path-like values (e.g. `ideasPath`, `memoryPath`). If a node uses `cwd`, you can set:

```yaml
cwd: "{{ run.inputs.projectRoot }}"
```

The pipeline YAML format (nodes, edges, contracts) is unchanged; you are only parameterising values that used to be literal strings.

## Step 2 — Create a profile with those inputs

Define a profile that provides the same paths you had in OpenClaw (or your desired equivalents):

```yaml
# ~/.ripline/profiles/openclaw-workspace.yaml
name: openclaw-workspace
description: "OpenClaw workspace paths"
inputs:
  projectsPath: /home/openclaw/.openclaw/workspace/kanban/projects
  ideasPath: /home/openclaw/.openclaw/workspace/kanban/ideas
  memoryPath: /home/openclaw/.openclaw/workspace/memory
  projectRoot: /home/openclaw/.openclaw/workspace/kanban
```

Use whatever input keys your pipeline now expects.

## Step 3 — Invoke with the profile

Run the pipeline by ID (or path) and pass the profile:

```bash
ripline run idea-generation --profile openclaw-workspace
```

Override a single value if needed:

```bash
ripline run idea-generation --profile openclaw-workspace --input '{"ideasPath": "/tmp/ideas-test/"}'
```

## agentId behavior outside OpenClaw

OpenClaw pipelines may set **`agentId`** (e.g. `vector`, `nova`, `writer`, `main`) to choose an OpenClaw agent configuration. When running **without** OpenClaw (standalone Ripline CLI or HTTP server):

- `agentId` is passed to the runner but **does not change** which model or persona is used. The LLM and Claude Code runners use a single configured model; they do not map `agentId` to different agents.
- To get different “personas” or instructions, express that in the **node’s prompt** (and optionally different nodes) rather than relying on `agentId`.

So: keep `agentId` in the YAML for compatibility; outside OpenClaw it effectively acts as a label. Put any persona- or model-specific behavior in the pipeline definition (e.g. prompt text, node structure).

## What stays compatible

- **Pipeline YAML format** — same node types, edges, contracts, and structure.
- **Node types and contracts** — input/output schemas and node definitions are unchanged.
- **Existing pipelines** with hardcoded paths continue to parse and run; migration is **opt-in**. They will keep using those literal paths until you replace them with inputs and use profiles or `--input` to supply values.
