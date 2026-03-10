---
layout: home

hero:
  name: "Ripline"
  text: "Graph-native pipeline engine"
  tagline: "Describe multi-agent workflows as typed DAGs. Run them, trace every step, and reroute in real time."
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: Pipeline Reference
      link: /pipeline-reference

features:
  - icon: 🔗
    title: Graph DSL
    details: Declare multi-agent workflows as typed DAGs in YAML or JSON. Loops, sub-pipelines, fan-out, and conditional edges built in.
  - icon: ⚡
    title: Hot Reload
    details: Edit a pipeline YAML file and the next run picks up the change automatically — no restarts, no redeploys.
  - icon: 🤖
    title: Agent-First
    details: OpenClaw, Ollama, OpenAI, Anthropic, and Claude Code are all first-class runners. Mix and match per node.
  - icon: 🔍
    title: Fully Traceable
    details: Every run stores a complete log — nodes, payloads, durations, retries. Resume any failed run from the exact node that errored.
  - icon: 🔌
    title: Open Surface
    details: CLI for local testing, HTTP API for automation and dashboards, and a plugin hook for OpenClaw. Use what fits.
  - icon: 📋
    title: Type-Checked Contracts
    details: Per-node JSON Schema contracts are validated at runtime. No silent data mismatches between nodes.
---
