# Multi-Agent Coordination Demo

These two example pipelines show how Ripline can coordinate multiple agents across an intake-and-delivery workflow. They're meant as a starting point you can adapt to your own agents and processes.

## 1. `intake_insights`

**Purpose:** Collect ideas and bug reports from specialized agents, pause for human review, then enqueue approved items for delivery.

**Key nodes:**

- `idea-agent` (`agent:ideation`) — proposes new features or improvements
- `qa-agent` (`agent:qa`) — flags bugs or regressions
- `awaiting-selection` — a [checkpoint](./nodes.md#checkpoint) that pauses the run; resume with `--resume <runId>` after a human selects which items to pursue
- `enqueue-delivery` — reads the `tasks` artifact and spawns `intake_delivery` runs for each selected item

**Sample input:**

```json
{ "focus": ["performance", "onboarding"] }
```

The `focus` array is optional. Leave it empty to let agents surface anything relevant.

**Run:**

```bash
node dist/cli/run.js \
  --pipeline pipelines/examples/intake-insights.yaml \
  --inputs inputs/intake-insights.json \
  --verbose
```

The pipeline pauses at the checkpoint. Once you've reviewed the agents' output and chosen what to pursue, resume:

```bash
node dist/cli/run.js \
  --resume <runId> \
  --pipeline pipelines/examples/intake-insights.yaml \
  --inputs '{"selection": ["idea-42", "bug-17"]}'
```

---

## 2. `intake_delivery`

**Purpose:** Execute one item at a time by passing it through a chain of specialist agents: breakdown → planning → implementation checklist.

**Invocation:** Triggered automatically by the `enqueue-delivery` node above, or manually:

```bash
node dist/cli/run.js \
  --pipeline pipelines/examples/intake-delivery.yaml \
  --inputs '{"task": {"id": "idea-42", "title": "Add keyboard shortcuts to sidebar"}}'
```

**Loop body:** For each `task`, the pipeline runs:

1. **Breakdown agent** — decomposes the task into subtasks
2. **Planner agent** — adds implementation detail to each subtask
3. **Checklist agent** — produces a ready-to-act checklist

Results accumulate under `delivery.items`.

---

## Output

Run records are saved to `.ripline/runs/<runId>/run.json`. When `--out` is provided:

| Artifact | Contents |
|---|---|
| `insights.report` | Combined findings from idea and QA agents |
| `delivery.items` | Per-task checklists from the delivery pipeline |
| `delivery.summary` | List of tasks processed |

---

The pipeline definitions live under `pipelines/examples/` and are designed to be copied and customized — swap in your own agent names, adjust the checkpoint logic, or extend the loop body to fit your workflow.
