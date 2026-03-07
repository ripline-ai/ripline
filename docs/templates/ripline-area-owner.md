# Ripline Area-Owner Template

Context-isolated template for the Ripline-on-Ripline workflow: area owner signals → breakdown → design → engineering plan → backlog artifact. Use it to dogfood without touching core code.

## Quick start

1. Copy the template into your local pipelines folder:
   ```bash
   cp pipelines/templates/ripline-area-owner.yaml pipelines/local/
   ```
2. Run with sample inputs (no code changes):
   ```bash
   npx run -p pipelines/local/ripline-area-owner.yaml -i samples/ripline-area-owner-inputs.json -o dist/backlog.json
   ```
   Or use the automation script:
   ```bash
   npm run build && node scripts/run-area-owner-demo.js
   ```
   (Or `npx tsx scripts/run-area-owner-demo.ts` if you prefer running the TypeScript directly.)

3. The run produces a backlog artifact (e.g. at `ripline/backlog` in the run output or in the file given by `--out`).

## Pipeline cycle

The template implements this flow:

| Stage | Node | Role |
|-------|------|------|
| **Area owner** | `area-owner-intake` | Input: signals (opportunities, issues, backlog items). |
| **Exec** | `break-down` → `design-spec` → `engineering-plan` | Agents turn signals into features, then design specs, then implementation plan + owners. |
| **Delivery** | `implementation-queue` | Output node writes the plan to the run output (e.g. `ripline/backlog`). |
| **Satisfaction gate** | (future) | Optional checkpoint or condition to pause for review before continuing. |

Data flows in order: **signals → features → designSpecs → plan → backlog artifact**.

## Customization

### Swapping agent IDs

Edit the template YAML and set `agentId` on each agent node:

- `break-down`: default `vector`
- `design-spec`: default `nova`
- `engineering-plan`: default `vector`

Use whatever agent IDs your runtime (e.g. OpenClaw) exposes.

### Changing prompts

Update the `prompt` field on each agent node. Prompts receive the previous node’s output as context (e.g. `break-down` sees `signals`, `design-spec` sees `features`). Keep outputs aligned with the **contracts** (see below) if you rely on validation or downstream tools.

### Acceptance criteria

Acceptance criteria are produced by the `break-down` node. To tighten or relax them:

1. Adjust the `break-down` prompt (e.g. “Include at least 3 acceptance criteria per feature”).
2. Optionally add a later node (e.g. transform or agent) that filters or reformats the `features` array before `design-spec`.

### Contracts (inputs/outputs)

Each node in the template has optional `contracts.input` and `contracts.output` JSON Schemas. They describe:

- **area-owner-intake**: pipeline input must include a `signals` array; each item has `type` (opportunity | issue | backlog), `title`, and optional `description`.
- **break-down**: consumes `signals`, produces `features` (id, title, acceptanceCriteria).
- **design-spec**: consumes `features`, produces `designSpecs` (featureId, ux, data).
- **engineering-plan**: consumes `designSpecs`, produces `plan` (e.g. items with featureId, steps, owner).
- **implementation-queue**: consumes the plan and writes the backlog artifact to the output path.

If you add nodes or change payload shapes, update the corresponding `contracts` in the YAML so they stay accurate for validation or tooling.

## Adapting to other feature areas

- **Different input shape**: Change the root input (e.g. rename or extend `signals`) and update `area-owner-intake` and `break-down` contracts and prompts.
- **More/fewer stages**: Add or remove agent nodes and edges; keep `entry` and `edges` consistent and point the last agent into `implementation-queue` (or another output node).
- **Different output path**: Set `path` on the output node (e.g. `path: my-team/backlog`) and optionally add a satisfaction gate (checkpoint or conditional edge) before it.

Copy the template to `pipelines/local/`, rename the `id` and `name` if you want, and adjust agents, prompts, and contracts for your area.
