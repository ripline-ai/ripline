# Example Pipelines (Implement Story, Spec→Build→Queue, Write Tech Script)

The `pipelines/examples/` directory includes **three pipeline patterns**, each in two variants:

| Pattern | OpenClaw variant | Claude Code variant |
|--------|-------------------|----------------------|
| **Implement Story** | `implement_story_openclaw` | `implement_story_claude` |
| **Spec → Build → Queue** | `spec_then_build_queue_openclaw` | `spec_then_build_queue_claude` |
| **Write Tech Script** | `write_tech_script_openclaw` | `write_tech_script_claude` |

## OpenClaw vs Claude Code variants

- **OpenClaw** variants are intended to run **inside an OpenClaw host**. They use the default agent runner (no `runner: claude-code`) and may use hardcoded paths (e.g. `/home/openclaw/wintermute`, `/home/openclaw/obsidian/Scripts`). Use these when Ripline is loaded as a plugin in OpenClaw.
- **Claude Code** variants run **standalone** (e.g. `ripline run` or `ripline serve`). They set `runner: claude-code` on agent nodes and use **parameterized paths** via `run.inputs` (e.g. `cwd: "{{ run.inputs.projectRoot }}"`). Supply those inputs with a [profile](../pipelines-and-profiles) or `--input`.

See [Migrating pipelines from OpenClaw](../migrating-from-openclaw.md) for how to move from hardcoded paths to profile-driven inputs.

---

## 1. Implement Story

**Purpose:** Run a single development story: implement the described work in a codebase and commit.

- **Input:** One task with `id`, `title`, and `detail` (typically provided by an enqueue when this pipeline is spawned).
- **OpenClaw:** Uses default runner; `cwd` is `/home/openclaw/wintermute`.
- **Claude:** Uses `runner: claude-code` and `cwd: "{{ run.inputs.projectRoot }}"`. Set `projectRoot` in a profile or when invoking.

**Usually invoked by** the Spec → Build → Queue pipeline (spawn/enqueue), not run directly. To run alone for testing:

```bash
ripline run implement_story_claude --input '{"projectRoot":"/path/to/repo","task":{"id":"1","title":"Add login","detail":"Implement user login with email/password."}}'
```

---

## 2. Spec → Build → Queue

**Purpose:** Turn a high-level feature idea into a spec, decompose it into implementation stories, then **enqueue** each story as a separate run of the Implement Story pipeline.

- **Input:** `task` (string) — e.g. "Add a settings page with theme toggle and notification preferences."
- **Flow:** intake → spec (agent) → decompose (agent) → queue (agent, outputs JSON) → parse (transform) → spawn (enqueue) → result.
- **Spawn:** The enqueue node creates one run of `implement_story_openclaw` or `implement_story_claude` per parsed task. Ensure that pipeline is available in your pipeline dir.

**OpenClaw:** All agent nodes use the default runner; spawn targets `implement_story_openclaw`.  
**Claude:** All agent nodes use `runner: claude-code`; spawn targets `implement_story_claude`. Use a profile to set `projectRoot` so spawned runs have the correct working directory.

**Run:**

```bash
# Standalone (Claude) — use a profile that sets projectRoot for spawned runs
ripline run spec_then_build_queue_claude --profile my-project --input '{"task":"Add a settings page with theme toggle"}'
```

---

## 3. Write Tech Script

**Purpose:** Produce a full YouTube tech-script package from a video idea: technical brief → script draft → fact-check → save to disk.

- **Input:** `idea` (string, video concept/title), `duration_minutes` (number).
- **Flow:** intake → tech_brief (agent) → write (agent) → fact_check (agent) → save (agent, writes file) → result.
- **OpenClaw:** Save node uses `cwd: /home/openclaw/obsidian/Scripts`.
- **Claude:** Save node uses `cwd: "{{ run.inputs.scriptsPath }}"`. Set `scriptsPath` in a profile or `--input`.

**Run:**

```bash
# Standalone (Claude) — profile supplies scriptsPath
ripline run write_tech_script_claude --profile my-scripts --input '{"idea":"How Ripline pipelines work","duration_minutes":12}'
```

---

## Example profile for Claude variants

Use a profile to supply paths so you don’t repeat `--input` every time:

```yaml
# ~/.ripline/profiles/my-project.yaml
name: my-project
description: "Main repo and scripts dir"
inputs:
  projectRoot: /path/to/your/repo
  scriptsPath: /path/to/obsidian/Scripts
```

Then:

```bash
ripline run spec_then_build_queue_claude --profile my-project --input '{"task":"Add dark mode"}'
ripline run write_tech_script_claude --profile my-project --input '{"idea":"Intro to Ripline","duration_minutes":8}'
```

These example pipelines live in `pipelines/examples/` and are intended as clearer, copy-paste-friendly references than the mission-control and area-owner examples.
