# Mission Control Demo Pipelines

Two pipelines show how Ripline can coordinate Nova, Quill, Vector, and Forge around Mission Control work.

## 1. `mission_control_insights`
- **Purpose:** Daily/on-demand intake. Nova proposes UI ideas, Quill flags bugs, Craig selects what to pursue, and selected items get enqueued for delivery.
- **Key nodes:**
  - `nova-ideas` (agent:nova)
  - `quill-watch` (agent:qa)
  - `needs-exec-selection` (checkpoint; resume with `--resume <runId>` after Craig picks winners)
  - `enqueue-delivery` (uses `tasks` artifact to spawn `mission_control_delivery` runs)
- **Sample input:**
  - Create `samples/optional/mission-control-insights-inputs.json` with optional `focus` array or leave empty (or copy from the optional sample in this repo).
- **Run (dry-run with placeholders):**
  ```bash
  node dist/cli/run.js \
    --pipeline pipelines/examples/optional/mission-control-insights.yaml \
    --inputs samples/optional/mission-control-insights-inputs.json \
    --verbose
  # Pipeline pauses at the checkpoint until resume data provides `selection` artifacts.
  ```
  Resume once Craig chooses winners:
  ```bash
  node dist/cli/run.js --resume <runId> --pipeline pipelines/examples/optional/mission-control-insights.yaml
  ```

## 2. `mission_control_delivery`
- **Purpose:** Executes one idea/story at a time (or batches) by walking Nova → Vector → Forge handoffs.
- **Invocation:** triggered automatically by the enqueue node, or manually via:
  ```bash
  node dist/cli/run.js \
    --pipeline pipelines/examples/optional/mission-control-delivery.yaml \
    --inputs '{"task":{"id":"story-123","title":"Context rail quick actions"}}'
  ```
- **Loop body:** For each `task`, Nova breaks it down, Vector adds the implementation plan, Forge produces the checklist, and the outputs accumulate under `delivery.items`.

## Output surfaces
- Run records saved in `.ripline/runs/<runId>/run.json`.
- Outputs (when `--out` is provided) include:
  - `insights.report` (Nova + Quill findings)
  - `delivery.items` (per-story Forge checklists)
  - `delivery.summary` (the list of tasks processed)

These definitions live under `pipelines/examples/optional/` (with sample inputs in `samples/optional/`) and can serve as starting points for Mission Control-style automation.
