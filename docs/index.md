---
layout: home

hero:
  name: "Ripline"
  text: "Repeatable agent workflows"
  tagline: "Define workflows as explicit steps with contracts between them. Run them, inspect them, and rerun them without hidden context."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Pipeline Reference
      link: /pipeline-reference

features:
  - icon: 🔗
    title: Explicit Step Boundaries
    details: Each workflow step is declared in YAML or JSON with clear edges, inputs, and outputs.
  - icon: ⚡
    title: Repeatable Runs
    details: Pipelines live as files, runs are persisted, and failed workflows can be retried without rebuilding the whole process by hand.
  - icon: 🤖
    title: Context Isolation
    details: Agent nodes start with fresh context by default, so one step does not silently contaminate the next.
  - icon: 🔍
    title: Runtime Contracts
    details: Validate pipeline and node boundaries with JSON Schema so bad payloads fail at the edge instead of leaking downstream.
  - icon: 🔌
    title: CLI, API, or OpenClaw
    details: Run Ripline from the terminal, trigger it over HTTP, or host it inside OpenClaw when that integration fits your setup.
  - icon: 📋
    title: Flexible Runners
    details: Use LLM providers, Claude Code, Codex, or a custom runner per workflow step.
---
