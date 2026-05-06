/**
 * ship-pipeline.ts
 *
 * Builds a PipelineDefinition for the ship workflow using generic ExecNode
 * nodes. Replaces the bespoke executeShipPhase generator.
 *
 * The pipeline has five sequential exec nodes:
 *   1. detect-base-branch — resolve origin/HEAD
 *   2. create-branch      — git checkout -b
 *   3. stage-and-commit   — git add -A && git commit
 *   4. push               — git push origin
 *   5. open-pr            — gh pr create (stdout = PR URL)
 */

import type { PipelineDefinition, ExecNode, PipelineEdge } from "../types.js";
import type { ShipConfig } from "../review-phase-types.js";

/**
 * Resolve {chatId} template tokens in a pattern string at build time.
 */
function resolve(template: string, chatId: string): string {
  return template.replace(/\{chatId\}/g, chatId);
}

/**
 * Build a linear sequence of edges connecting each node to the next.
 */
function linearEdges(ids: string[]): PipelineEdge[] {
  const edges: PipelineEdge[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    edges.push({
      from: { node: ids[i]! },
      to: { node: ids[i + 1]! },
    });
  }
  return edges;
}

/**
 * Build the ship PipelineDefinition from a ShipConfig and chatId.
 *
 * Template values from ShipConfig are resolved at build time into the command
 * strings, so no runtime interpolation is required for ship-specific values.
 * The repoPath should be set as the cwd on each exec node by the caller
 * (runner.ts passes it when constructing the pipeline run).
 */
export function buildShipPipeline(
  config: ShipConfig,
  chatId: string,
  repoPath: string
): PipelineDefinition {
  const branchPattern = config.branchPattern ?? "ripline/{chatId}";
  const titleTemplate = config.titleTemplate ?? "ripline: chat #{chatId}";
  const shipBranch = resolve(branchPattern, chatId);
  const shipTitle = resolve(titleTemplate, chatId);

  const detectBase: ExecNode = {
    id: "detect-base-branch",
    name: "Detect base branch",
    type: "exec",
    command: `git symbolic-ref refs/remotes/origin/HEAD --short 2>/dev/null || echo main`,
    cwd: repoPath,
    captureOutput: true,
  };

  const createBranch: ExecNode = {
    id: "create-branch",
    name: "Create ship branch",
    type: "exec",
    // {{detect-base-branch}} is the stdout from the previous node (trimmed).
    command: `git fetch origin {{detect-base-branch}} && git checkout -B ${shipBranch} origin/{{detect-base-branch}}`,
    cwd: repoPath,
    captureOutput: false,
  };

  const stageAndCommit: ExecNode = {
    id: "stage-and-commit",
    name: "Stage and commit",
    type: "exec",
    command: `git add -A && git commit -m ${JSON.stringify(shipTitle)} --allow-empty`,
    cwd: repoPath,
    captureOutput: false,
  };

  const push: ExecNode = {
    id: "push",
    name: "Push branch",
    type: "exec",
    command: `git push -u origin ${shipBranch}`,
    cwd: repoPath,
    captureOutput: false,
  };

  const openPr: ExecNode = {
    id: "open-pr",
    name: "Open pull request",
    type: "exec",
    command: `gh pr create --title ${JSON.stringify(shipTitle)} --body ""`,
    cwd: repoPath,
    captureOutput: true,
  };

  const nodeIds = [
    detectBase.id,
    createBranch.id,
    stageAndCommit.id,
    push.id,
    openPr.id,
  ];

  return {
    id: `ship-${chatId}`,
    name: `Ship pipeline for chat ${chatId}`,
    entry: [detectBase.id],
    nodes: [detectBase, createBranch, stageAndCommit, push, openPr],
    edges: linearEdges(nodeIds),
  };
}
