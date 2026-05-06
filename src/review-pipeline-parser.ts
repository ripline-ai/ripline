/**
 * review-pipeline-parser.ts
 *
 * Parses a review pipeline YAML string (or file) into a ReviewPipelineDefinition.
 *
 * Edge generation rules:
 *   1. When a phase declares `inputs.include: [phaseId, ...]`, explicit edges are
 *      generated from each listed source phase to this phase.
 *   2. When a phase has no `inputs.include` (or it is empty), a sequential edge
 *      is generated from the previous phase to this phase (implicit ordering).
 *   3. When `inputs.include` is present and non-empty, sequential auto-wiring is
 *      suppressed for that phase — only the explicitly listed sources are wired.
 */

import { promises as fs } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  reviewPipelineDefinitionSchema,
  type ReviewPipelineDefinition,
} from "./review-phase-types.js";
import type { PipelineEdge } from "./types.js";

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

export type ParseResult =
  | { ok: true; pipeline: ReviewPipelineDefinition }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the id of any phase object.
 * All review phases and ripline nodes carry an `id` field, so this is always
 * defined for valid phases; we return `undefined` for guard completeness.
 */
function phaseId(phase: unknown): string | undefined {
  if (phase !== null && typeof phase === "object" && "id" in phase) {
    const raw = (phase as Record<string, unknown>).id;
    if (typeof raw === "string") return raw;
  }
  return undefined;
}

/**
 * Extract `inputs.include` from a phase, returning an empty array when absent.
 */
function phaseInputsInclude(phase: unknown): string[] {
  if (phase !== null && typeof phase === "object") {
    const p = phase as Record<string, unknown>;
    if (
      p.inputs !== null &&
      typeof p.inputs === "object"
    ) {
      const inputs = p.inputs as Record<string, unknown>;
      if (Array.isArray(inputs.include)) {
        return inputs.include.filter((v): v is string => typeof v === "string");
      }
    }
  }
  return [];
}

/**
 * Generate edges for a list of raw (pre-validation) phases.
 *
 * Rules:
 *   - For each phase at index i (i > 0):
 *     - If `inputs.include` has entries → add edges from each listed source.
 *     - Otherwise → add a sequential edge from phase[i-1] to phase[i].
 */
function deriveEdges(phases: unknown[]): PipelineEdge[] {
  const edges: PipelineEdge[] = [];
  let edgeCounter = 0;

  for (let i = 1; i < phases.length; i++) {
    const phase = phases[i];
    const toId = phaseId(phase);
    if (toId === undefined) continue;

    const include = phaseInputsInclude(phase);

    if (include.length > 0) {
      // Explicit wiring: each listed source → this phase
      for (const sourceId of include) {
        edgeCounter += 1;
        edges.push({
          id: `e${edgeCounter}`,
          from: { node: sourceId },
          to: { node: toId },
        });
      }
    } else {
      // Sequential fallback: previous phase → this phase
      const prevPhase = phases[i - 1];
      const fromId = phaseId(prevPhase);
      if (fromId === undefined) continue;
      edgeCounter += 1;
      edges.push({
        id: `e${edgeCounter}`,
        from: { node: fromId },
        to: { node: toId },
      });
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Core parser
// ---------------------------------------------------------------------------

/**
 * Parse a review pipeline YAML string into a ReviewPipelineDefinition.
 *
 * Steps:
 *   1. Parse YAML text into a plain object.
 *   2. Derive edges from the phases array (if `edges` is not already present).
 *   3. Derive `entry` from the first phase (if `entry` is not already present).
 *   4. Validate with the Zod schema, returning structured errors on failure.
 */
export function parseReviewPipeline(yaml: string): ParseResult {
  // Step 1: parse YAML
  let raw: unknown;
  try {
    raw = parseYaml(yaml);
  } catch (err) {
    return {
      ok: false,
      error: `YAML parse error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "YAML root must be a mapping object" };
  }

  const doc = raw as Record<string, unknown>;

  // Step 2: derive edges when not explicitly supplied
  const phases = Array.isArray(doc.phases) ? doc.phases : [];
  if (!Array.isArray(doc.edges) || doc.edges.length === 0) {
    const derived = deriveEdges(phases);
    if (derived.length > 0) {
      doc.edges = derived;
    }
  }

  // Step 3: derive `entry` from the first phase when not supplied
  if (!Array.isArray(doc.entry) || doc.entry.length === 0) {
    const firstId = phases.length > 0 ? phaseId(phases[0]) : undefined;
    if (firstId !== undefined) {
      doc.entry = [firstId];
    }
  }

  // Step 4: validate
  const result = reviewPipelineDefinitionSchema.safeParse(doc);
  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    return { ok: false, error: `Validation error: ${messages}` };
  }

  return { ok: true, pipeline: result.data };
}

// ---------------------------------------------------------------------------
// File loader
// ---------------------------------------------------------------------------

/**
 * Load and parse a review pipeline YAML file from disk.
 */
export async function loadReviewPipeline(filePath: string): Promise<ParseResult> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `File read error (${filePath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return parseReviewPipeline(content);
}
