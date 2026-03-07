# Mission Control Feature Pipeline (draft)

## Goal
Route a feature request (e.g., "Mission Control nav overhaul") through the exact flow we just followed manually:

1. **Intake** – capture the brief from Craig (feature summary, constraints, urgency).
2. **Design stage (Nova)** – spawn a design run with the intake context, wait for spec + assets.
3. **Story break-out** – once the spec lands, generate the engineering cards (Forge, Vector, ops) and drop them on the Kanban with owners/due dates.
4. **Implementation stage** – assign runs to Forge (UI build) and/or Vector (backend/pipeline) with links to the spec and target files.
5. **QA/Review** – prompt Craig (or another reviewer) once the implementation cards are in “Shipped”.

## How mission-control pipelines call agents

When the pipeline plugin runs inside OpenClaw, every **agent** node delegates to the platform via `openclaw agent --json` (see [Agent integration](agent-integration.md)). So design runs, builder runs, and any agent step use the configured models, tools, and sandbox. For local dev without OpenClaw, the HTTP server and CLI use a stub runner unless overridden.

## Automation Hooks
- **Pipeline DSL node types** we will need:
  - `intake_form` (structured prompt + persistence).
  - `design_run` (sessions_spawn → designer).
  - `kanban_update` (write to `initialBoard` / future JSON store).
  - `builder_run` (sessions_spawn → builder with spec link).
  - `notify` (Message/Ping back to Craig).

## Next Steps
- Finish the pipeline runtime (tracked via `task-pipeline-engine`, `task-pipeline-tools`).
- Define the schema for persisted tasks (so the board can read from JSON instead of hard-coded data).
- Encode this flow as the first pipeline template once the runtime is in place.
