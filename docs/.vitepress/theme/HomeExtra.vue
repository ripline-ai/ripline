<script setup lang="ts">
import { useData } from "vitepress";

const repo = "https://github.com/craigjmidwinter/ripline";
const { site } = useData();
const base = site.value?.base ?? "/ripline/";
</script>

<template>
  <div class="home-extra">
    <!-- Problems we solve -->
    <section class="home-section problems-section">
      <h2 class="section-title">Problems Ripline solves</h2>
      <p class="section-lead">
        Multi-step agent workflows break down without structure. Ripline gives you that structure so you can run the same flow again, control cost and context, and see exactly what happened.
      </p>
      <div class="problems-grid">
        <div class="problem-card">
          <h3>Repeatability</h3>
          <p>Same pipeline, same inputs → same path. Pipelines are versioned YAML/JSON, so you can rerun a flow exactly, share it with the team, or hand it to automation. No “it worked in my thread” drift.</p>
        </div>
        <div class="problem-card">
          <h3>Context isolation</h3>
          <p>Each step gets only the payload it needs. No giant chat history or mixed context. Downstream steps see typed outputs from upstream, so prompts stay focused and tokens stay under control.</p>
        </div>
        <div class="problem-card">
          <h3>Token & model control</h3>
          <p>Use a big model where you need reasoning and a smaller one for fast, mechanical steps. Set per-node model (e.g. Sonnet for spec, Haiku for implementation) and timeouts so cost and latency are predictable.</p>
        </div>
        <div class="problem-card">
          <h3>Contracts between steps</h3>
          <p>Define JSON Schema for inputs and outputs on nodes. Ripline validates at runtime so a step never receives the wrong shape. Catch mismatches before they hit the model or your scripts.</p>
        </div>
        <div class="problem-card">
          <h3>Traceability</h3>
          <p>Every run is logged: which node ran, what went in and out, duration, retries. When something fails, you see the exact step and payload. Resume from that node instead of starting over.</p>
        </div>
      </div>
    </section>

    <!-- Use case: Spec → Build → Queue -->
    <section class="home-section usecase-section">
      <h2 class="section-title">Example: Spec → Build → Queue</h2>
      <p class="section-lead">
        One concrete flow: turn a feature idea into a spec, break it into implementation stories, run each story in a focused step, then verify with build and tests. Same pipeline runs with <strong>OpenClaw</strong> (inside the host) or <strong>Claude Code</strong> (standalone).
      </p>
      <div class="usecase-flow">
        <h3>Flow</h3>
        <ol>
          <li><strong>Intake</strong> — One input: the feature or idea (e.g. “Add a weekly digest email”).</li>
          <li><strong>Spec</strong> — Agent writes a clear user-flow and design spec (Sonnet).</li>
          <li><strong>Decompose</strong> — Agent breaks the spec into small, atomic implementation stories (Sonnet).</li>
          <li><strong>Queue</strong> — Output a JSON array of tasks (id, title, detail).</li>
          <li><strong>Implement</strong> — Fan-out: one child run per story, each in a dedicated pipeline (e.g. Haiku, execute mode, fixed <code>cwd</code>).</li>
          <li><strong>Collect & verify</strong> — After all stories finish, one agent step runs build and tests and summarizes results (Sonnet).</li>
        </ol>
      </div>
      <div class="usecase-impl">
        <h3>Implementation</h3>
        <ul>
          <li><strong>With OpenClaw:</strong> Load Ripline as a plugin. Agent nodes use the host’s runner (no <code>runner</code> field). Set <code>projectRoot</code> and other inputs via a profile. Run from the OpenClaw UI or CLI; pipelines live in the workspace.</li>
          <li><strong>With Claude Code (standalone):</strong> Use <code>runner: claude-code</code> and per-node <code>model</code> (e.g. <code>claude-sonnet-4-6</code> for spec/decompose/verify, <code>claude-haiku-4-5</code> for implement). Configure <code>cwd</code> via profile or run inputs. Run with <code>ripline run</code> or the HTTP API.</li>
        </ul>
        <p class="usecase-links">
          <a :href="`${base}/pipelines/example-pipelines#spec--build--queue`">Spec → Build → Queue pipeline</a>,
          <a :href="`${base}/pipelines/example-pipelines`">example pipelines</a>,
          <a :href="`${base}/agent-integration`">Agent integration (OpenClaw & Claude Code)</a>.
        </p>
      </div>
    </section>

    <!-- Open source & collaborators -->
    <section class="home-section oss-section">
      <h2 class="section-title">Open source & free</h2>
      <p class="section-lead">
        Ripline is open source and free to use. The codebase is on GitHub — we welcome issues, pull requests, and ideas for runners, node types, and integrations.
      </p>
      <div class="oss-actions">
        <a :href="repo" class="oss-link oss-link-primary" target="_blank" rel="noopener noreferrer">View on GitHub</a>
        <a :href="`${repo}/issues`" class="oss-link oss-link-alt" target="_blank" rel="noopener noreferrer">Ideas & issues</a>
      </div>
      <p class="oss-cta">
        If you’re building multi-step agent workflows and care about repeatability, contracts, and traceability, we’d love to hear from you. Open an issue or discussion to collaborate.
      </p>
    </section>
  </div>
</template>

<style scoped>
.home-extra {
  --abyss: #031326;
  --rip: #0B5AA3;
  --seafoam: #2DD2C8;
  --mist: #B8CAD6;
  position: relative;
  z-index: 1;
  padding: 0 24px 5rem;
  background: var(--abyss);
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.4);
}

.home-section {
  max-width: 720px;
  margin: 0 auto;
  padding: 3rem 0;
  border-bottom: 1px solid rgba(184, 202, 214, 0.15);
}

.home-section:last-child {
  border-bottom: none;
  padding-bottom: 0;
}

.section-title {
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: 0.02em;
  margin: 0 0 0.5rem;
  color: var(--seafoam);
}

.section-lead {
  font-size: 1rem;
  line-height: 1.65;
  color: var(--mist);
  margin: 0 0 2rem;
  max-width: 58ch;
  opacity: 0.95;
}

/* Problems: list with accent bar, no card grid */
.problems-grid {
  display: flex;
  flex-direction: column;
  gap: 0;
}

.problem-card {
  padding: 1rem 0 1rem 1.25rem;
  border-left: 3px solid var(--rip);
  margin-left: 0;
  background: transparent;
  border-radius: 0;
  transition: border-color 0.15s ease, background 0.15s ease;
}

.problem-card:hover {
  border-left-color: var(--seafoam);
  background: rgba(11, 90, 163, 0.08);
}

.problem-card h3 {
  font-size: 1rem;
  font-weight: 600;
  margin: 0 0 0.35rem;
  color: #fff;
  letter-spacing: 0.01em;
}

.problem-card p {
  font-size: 0.9375rem;
  line-height: 1.55;
  margin: 0;
  color: var(--mist);
  opacity: 0.9;
}

/* Use case: flow + impl with clear subsections */
.usecase-flow,
.usecase-impl {
  margin-bottom: 2rem;
}

.usecase-flow:last-child,
.usecase-impl:last-of-type {
  margin-bottom: 0;
}

.usecase-flow h3,
.usecase-impl h3 {
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0 0 0.75rem;
  color: var(--seafoam);
  opacity: 0.9;
}

.usecase-flow ol,
.usecase-impl ul {
  margin: 0;
  padding-left: 1.5rem;
  color: var(--mist);
  line-height: 1.7;
}

.usecase-flow li,
.usecase-impl li {
  margin-bottom: 0.6rem;
}

.usecase-flow code,
.usecase-impl code {
  font-size: 0.875em;
  padding: 0.2em 0.45em;
  border-radius: 4px;
  background: rgba(45, 210, 200, 0.12);
  color: var(--seafoam);
  font-family: var(--vp-font-family-mono);
}

.usecase-links {
  margin: 1.25rem 0 0;
  font-size: 0.9375rem;
}

.usecase-links a {
  color: var(--seafoam);
  text-decoration: none;
}

.usecase-links a:hover {
  text-decoration: underline;
}

/* OSS: one clear CTA row */
.oss-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-bottom: 1.25rem;
}

.oss-link {
  display: inline-block;
  padding: 0.6rem 1.35rem;
  border-radius: 6px;
  font-weight: 500;
  font-size: 0.9375rem;
  text-decoration: none;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}

.oss-link:hover {
  transform: translateY(-2px);
}

.oss-link-primary {
  background: var(--rip);
  color: #fff;
  box-shadow: 0 2px 12px rgba(11, 90, 163, 0.35);
}

.oss-link-primary:hover {
  background: #0d6ab8;
  box-shadow: 0 4px 20px rgba(11, 90, 163, 0.45);
}

.oss-link-alt {
  border: 1px solid rgba(184, 202, 214, 0.4);
  color: var(--mist);
  background: transparent;
}

.oss-link-alt:hover {
  border-color: var(--seafoam);
  color: var(--seafoam);
}

.oss-cta {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--mist);
  opacity: 0.9;
  margin: 0;
}
</style>
