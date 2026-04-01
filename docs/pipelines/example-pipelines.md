# Example Pipelines

The `pipelines/examples/` directory includes several reusable patterns for standalone Ripline usage.

## Included examples

- `hello_world` — minimal input → transform → output
- `parallel_agents` — multiple agent steps with explicit edges
- `daily-brief` — recurring summary-style workflow
- `implement_story_claude` / `implement_story_codex` — single coding task in a target repo
- `spec_then_build_queue_claude` / `spec_then_build_queue_codex` — spec first, then fan out implementation work
- `write_tech_script_claude` — longer-form content generation with file output

## Claude Code vs Codex variants

- **Claude Code** variants use `runner: claude-code` and typically expect `cwd` or path inputs from the run input or a profile.
- **Codex** variants follow the same workflow shape with `runner: codex`.
- Both are intended to be copyable starting points, not framework-mandated patterns.

---

## 1. Implement Story

**Purpose:** Run a single development story: implement the described work in a codebase and commit.

- **Input:** One task with `id`, `title`, and `detail`.
- **Claude/Codex:** Use `runner: claude-code` or `runner: codex` with `cwd: "{{ run.inputs.projectRoot }}"`. Set `projectRoot` in a profile or when invoking.

**Usually invoked by** the Spec → Build → Queue pipeline (spawn/enqueue), not run directly. To run alone for testing:

```bash
ripline run implement_story_claude --input '{"projectRoot":"/path/to/repo","task":{"id":"1","title":"Add login","detail":"Implement user login with email/password."}}'
```

Or use the dedicated Codex variant:

```bash
ripline run implement_story_codex --input '{"projectRoot":"/path/to/repo","task":{"id":"1","title":"Add login","detail":"Implement user login with email/password."}}'
```

---

## 2. Spec → Build → Queue

**Purpose:** Turn a high-level feature idea into a spec, decompose it into implementation stories, **enqueue** each story as a separate run of the Implement Story pipeline, then **collect** results and **verify** (build, tests, sense-check) once all are done.

- **Input:** `task` (string) — e.g. "Add a settings page with theme toggle and notification preferences."
- **Flow:** intake → spec (agent) → decompose (agent) → queue (agent, outputs JSON) → parse (transform) → spawn (enqueue) → **collect** (collect_children) → **verify** (agent) → result.
- **Model split (optional):** Use Sonnet for spec, decompose, queue, and verify (reasoning); use Haiku for the per-story implement step (speed). The doc examples in `docs/pipelines/examples/` illustrate this.
- **Spawn:** The enqueue node creates one run of `implement_story_claude` or `implement_story_codex` per parsed task. The parent run pauses until all children are terminal (completed or errored). The **collect_children** node then aggregates child run results so the **verify** step can run build/tests and reason over outcomes.

All agent nodes use a built-in code runner. The example files ship with either `runner: claude-code` or `runner: codex`. Use a profile to set `projectRoot` so spawned runs and the verify step have the correct working directory.

**Run:**

```bash
# Standalone (Claude) — use a profile that sets projectRoot for spawned runs
ripline run spec_then_build_queue_claude --profile my-project --input '{"task":"Add a settings page with theme toggle"}'
```

Or use the dedicated Codex variant:

```bash
ripline run spec_then_build_queue_codex --profile my-project --input '{"task":"Add a settings page with theme toggle"}'
```

---

## 3. Write Tech Script

**Purpose:** Produce a full YouTube tech-script package from a video idea: technical brief → script draft → fact-check → save to disk.

- **Input:** `idea` (string, video concept/title), `duration_minutes` (number).
- **Flow:** intake → tech_brief (agent) → write (agent) → fact_check (agent) → save (agent, writes file) → result.
- **Claude/Codex:** Save node uses `cwd: "{{ run.inputs.scriptsPath }}"`. Set `scriptsPath` in a profile or `--input`.

**Run:**

```bash
# Standalone (Claude) — profile supplies scriptsPath
ripline run write_tech_script_claude --profile my-scripts --input '{"idea":"How Ripline pipelines work","duration_minutes":12}'
```

---

## Example profile for standalone code-runner variants

Use a profile to supply paths so you don’t repeat `--input` every time:

```yaml
# ~/.ripline/profiles/my-project.yaml
name: my-project
description: "Main repo and scripts dir"
inputs:
  projectRoot: /path/to/your/repo
  scriptsPath: /path/to/your/scripts
```

Then:

```bash
ripline run spec_then_build_queue_claude --profile my-project --input '{"task":"Add dark mode"}'
ripline run write_tech_script_claude --profile my-project --input '{"idea":"Intro to Ripline","duration_minutes":8}'
```

These example pipelines live in `pipelines/examples/` and are intended to be copy-paste-friendly starting points for standalone Ripline workflows.
