---
layout: home

hero:
  name: "Ripline"
  text: "Run multi-step workflows with agents and scripts"
  tagline: "Define your steps in YAML, run them, and see every step. When something fails or you need to change the flow, pick up from where it stopped or edit and rerun—no starting over."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Pipeline Reference
      link: /pipeline-reference

features:
  - icon: 🔗
    title: Workflows as a graph
    details: Each step is a node—agent prompts, scripts, API calls, approvals. Connect them in YAML or JSON with branches, loops, and conditions.
  - icon: ⚡
    title: Edit and go
    details: Change a pipeline file and the next run uses the new version. No redeploy or restart.
  - icon: 🤖
    title: Any agent you use
    details: OpenClaw, Ollama, OpenAI, Anthropic, Claude Code. Choose the runner per step and mix them in one pipeline.
  - icon: 🔍
    title: See what ran
    details: Every run is logged—which node ran, what went in and out, how long it took. Resume from the exact step that failed.
  - icon: 🔌
    title: CLI, API, or plugin
    details: Run from the terminal, call the HTTP API from a dashboard or cron, or plug into OpenClaw. Same pipelines everywhere.
  - icon: 📋
    title: Schemas per step
    details: Define what each step expects and produces. Ripline checks it at runtime so steps don’t get the wrong data.
---
