# Example pipelines

- **Simple:** [hello-world.yaml](hello-world.yaml), [daily-brief.yaml](daily-brief.yaml) — minimal input → transform/agent → output.
- **Templates:** [ripline-area-owner.yaml](ripline-area-owner.yaml) — multi-agent flow (no runner specified; use with OpenClaw or LLM config).
- **Optional:** [optional/](optional/) — mission-control insights and delivery (checkpoint, enqueue).

## Implement Story, Spec→Build→Queue, Write Tech Script

Three real-world patterns are provided in **OpenClaw** and **Claude Code** variants:

| Pipeline | OpenClaw | Claude Code |
|----------|----------|-------------|
| Implement Story | [implement_story_openclaw.yaml](implement_story_openclaw.yaml) | [implement_story_claude.yaml](implement_story_claude.yaml) |
| Spec → Build → Queue | [spec_then_build_queue_openclaw.yaml](spec_then_build_queue_openclaw.yaml) | [spec_then_build_queue_claude.yaml](spec_then_build_queue_claude.yaml) |
| Write Tech Script | [write_tech_script_openclaw.yaml](write_tech_script_openclaw.yaml) | [write_tech_script_claude.yaml](write_tech_script_claude.yaml) |

OpenClaw variants use the default runner and hardcoded paths; Claude variants use `runner: claude-code` and paths from `run.inputs` (supply via profile or `--input`). A concrete Codex example is also included: [implement_story_codex.yaml](implement_story_codex.yaml). See [Example pipelines (docs)](../../docs/pipelines/example-pipelines.md) for inputs, profiles, and how to run them.

Additional Codex examples:
- [implement_story_codex.yaml](implement_story_codex.yaml)
- [spec_then_build_queue_codex.yaml](spec_then_build_queue_codex.yaml)
