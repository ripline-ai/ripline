import Ajv from "ajv";
import type { ValidateFunction } from "ajv";
import type { JSONSchema7 } from "json-schema";

const ajv = new Ajv({ allErrors: true });
const cache = new Map<string, ValidateFunction>();

function getValidator(schema: JSONSchema7): ValidateFunction {
  const key = JSON.stringify(schema);
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(schema as object);
    cache.set(key, fn);
  }
  return fn;
}

/**
 * Resolve the payload to validate: for agent nodes, parse artifact.text as JSON;
 * for other nodes, use the artifact as-is.
 */
function resolvePayload(nodeId: string, nodeType: string, artifact: unknown): unknown {
  if (nodeType !== "agent") {
    return artifact;
  }
  const obj = artifact as { text?: unknown };
  if (obj == null || typeof obj.text !== "string") {
    throw new Error(`Node "${nodeId}": Agent artifact must have a string 'text' property`);
  }
  try {
    return JSON.parse(obj.text) as unknown;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Node "${nodeId}": Agent output is not valid JSON: ${msg}`);
  }
}

/**
 * Validate a node's output artifact against its contracts.output schema.
 * For agent nodes, validates JSON.parse(artifact.text); for other nodes, validates the artifact directly.
 * @throws Error with node id and schema errors when validation fails
 */
export function validateOutputContract(
  nodeId: string,
  nodeType: string,
  schema: JSONSchema7,
  artifact: unknown
): void {
  const payload = resolvePayload(nodeId, nodeType, artifact);
  const validate = getValidator(schema);
  const valid = validate(payload);
  if (valid) return;
  const errors = validate.errors ?? [];
  const details = errors.map((e) => `${e.instancePath || "/"} ${e.message ?? ""}`.trim()).join("; ");
  throw new Error(`Output contract validation failed for node "${nodeId}": ${details}`);
}
