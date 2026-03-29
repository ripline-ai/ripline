/**
 * Utilities for normalizing parallel (child-run) iteration results to match
 * the shape produced by the sequential loop executor.
 *
 * Sequential loop stores `context.artifacts[lastBodyNode.id]` per iteration.
 * Parallel loop collects `record.outputs` from each child run — a full outputs
 * object, not the individual artifact value.  This module bridges the gap.
 */

/**
 * Maximum safe size (in bytes) for a single serialized artifact value.
 * Values exceeding this are truncated to prevent memory/serialization issues.
 */
const MAX_ARTIFACT_BYTES = 512 * 1024; // 512 KB

/**
 * Extract the iteration-level result from a child run's outputs object so it
 * matches what the sequential loop would have captured.
 *
 * Resolution order:
 *   1. If `resultKey` is provided and exists in outputs, use that value.
 *   2. If outputs has exactly one key, unwrap and use that value.
 *   3. Otherwise return the full outputs object (best-effort).
 */
export function extractIterationResult(
  outputs: Record<string, unknown>,
  resultKey?: string,
): unknown {
  if (resultKey && resultKey in outputs) {
    return outputs[resultKey];
  }

  const keys = Object.keys(outputs);
  if (keys.length === 1) {
    return outputs[keys[0]!];
  }

  // Multiple keys and no resultKey — return full outputs (backwards-compat).
  return outputs;
}

/**
 * Determine the result key from inline body nodes.
 * The sequential loop captures `context.artifacts[lastBodyNode.id]` — so the
 * child pipeline's equivalent output key is the last body node's id.
 */
export function deriveResultKey(
  bodyNodes?: Array<{ id: string }>,
): string | undefined {
  if (!bodyNodes || bodyNodes.length === 0) return undefined;
  return bodyNodes[bodyNodes.length - 1]!.id;
}

/**
 * Safely serialize a value, truncating if it exceeds `MAX_ARTIFACT_BYTES`.
 * Returns the original value if serialization is within bounds, or a
 * truncated wrapper if it's too large.
 *
 * This prevents OOM or JSON.stringify failures with very large artifacts
 * while preserving the value for normal-sized outputs.
 */
export function safeLargeArtifact(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length <= MAX_ARTIFACT_BYTES) {
      return value;
    }
    // For string values, truncate the string itself
    if (typeof value === "string") {
      return value.slice(0, MAX_ARTIFACT_BYTES) + "\n...[truncated, original size: " + serialized.length + " bytes]";
    }
    // For objects, keep a metadata wrapper so downstream knows it was large
    if (typeof value === "object" && value !== null) {
      const textValue = (value as Record<string, unknown>).text;
      if (typeof textValue === "string" && textValue.length > MAX_ARTIFACT_BYTES) {
        return {
          ...value as Record<string, unknown>,
          text: textValue.slice(0, MAX_ARTIFACT_BYTES) + "\n...[truncated, original size: " + textValue.length + " chars]",
        };
      }
    }
    // Fallback: return as-is and let downstream handle
    return value;
  } catch {
    // JSON.stringify failed (circular reference, etc.) — return a safe fallback
    return {
      __error: true,
      message: "Artifact too large or not serializable",
      type: typeof value,
    };
  }
}

/**
 * Merge a wave's collected results into the iteration results array,
 * normalizing each child output to match sequential loop shape.
 *
 * Results are placed at their original collection indices (story order),
 * regardless of the order children completed.
 */
export function mergeWaveResults(
  iterationResults: unknown[],
  waveResults: Array<{ index: number; result: unknown }>,
  resultKey?: string,
): void {
  for (const { index, result } of waveResults) {
    // Error markers pass through as-is
    if (result && typeof result === "object" && (result as Record<string, unknown>).__error) {
      iterationResults[index] = result;
      continue;
    }

    // Normalize child outputs to match sequential shape
    const normalized =
      result && typeof result === "object" && !Array.isArray(result)
        ? extractIterationResult(result as Record<string, unknown>, resultKey)
        : result;

    iterationResults[index] = safeLargeArtifact(normalized);
  }
}

/**
 * Build the subset of accumulated iteration results that child runs in
 * wave N+1 can reference (results from waves 0..N).
 *
 * Filters out nulls (incomplete slots) and error markers to keep the
 * context payload lean.
 */
export function buildPriorResultsContext(
  iterationResults: unknown[],
  collection: unknown[],
): Array<{ index: number; id?: string; result: unknown }> {
  const priorResults: Array<{ index: number; id?: string; result: unknown }> = [];
  for (let i = 0; i < iterationResults.length; i++) {
    const r = iterationResults[i];
    if (r == null) continue;
    if (r && typeof r === "object" && (r as Record<string, unknown>).__error) continue;
    const item = collection[i] as Record<string, unknown> | undefined;
    priorResults.push({
      index: i,
      ...(item && typeof item.id === "string" ? { id: item.id } : {}),
      result: r,
    });
  }
  return priorResults;
}
