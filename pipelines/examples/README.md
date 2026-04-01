# Example pipelines

- **Simple:** [hello-world.yaml](hello-world.yaml), [daily-brief.yaml](daily-brief.yaml) — minimal input → transform/agent → output.
- **Parallel:** [parallel_agents.yaml](parallel_agents.yaml) — explicit branching and agent fan-out.

## Claude Code and Codex examples

Several real-world patterns are provided as standalone examples:

| Pipeline | Claude Code | Codex |
|----------|-------------|-------|
| Implement Story | [implement_story_claude.yaml](implement_story_claude.yaml) | [implement_story_codex.yaml](implement_story_codex.yaml) |
| Spec → Build → Queue | [spec_then_build_queue_claude.yaml](spec_then_build_queue_claude.yaml) | [spec_then_build_queue_codex.yaml](spec_then_build_queue_codex.yaml) |
| Write Tech Script | [write_tech_script_claude.yaml](write_tech_script_claude.yaml) | — |

These examples use parameterized paths through `run.inputs` so they are easier to adapt to your own repos and profiles. See [Example pipelines (docs)](../../docs/pipelines/example-pipelines.md) for inputs, profiles, and how to run them.
