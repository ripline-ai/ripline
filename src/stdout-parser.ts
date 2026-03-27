/**
 * Robust stdout parser for extracting clean results from agent output.
 *
 * Handles common issues:
 * - ANSI escape codes mixed into output
 * - JSON result preceded by plain text lines
 * - Trailing newlines / blank lines after JSON
 * - Malformed or missing JSON (falls back to raw text)
 */

// Matches all ANSI escape sequences (CSI, OSC, simple escapes)
// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g;

/**
 * Strip all ANSI escape codes from a string.
 */
export function stripAnsi(input: string): string {
  return input.replace(ANSI_RE, "");
}

/**
 * Extract the last valid JSON object (or array) from a string.
 *
 * Strategy: scan backwards for the last `}` or `]`, then find its matching
 * opening `{` or `[` by tracking brace/bracket depth (ignoring characters
 * inside JSON string literals). If the candidate substring parses, return it.
 * Falls back through earlier candidates if the first attempt fails.
 *
 * Returns `undefined` if no valid JSON object/array is found.
 */
export function extractLastJson(input: string): string | undefined {
  const cleaned = stripAnsi(input);

  // Find all closing braces/brackets and try from the last one backwards
  for (let end = cleaned.length - 1; end >= 0; end--) {
    const closingChar = cleaned[end];
    if (closingChar !== "}" && closingChar !== "]") continue;

    const openingChar = closingChar === "}" ? "{" : "[";
    let depth = 0;
    let inString = false;
    let escape = false;

    for (let start = end; start >= 0; start--) {
      const ch = cleaned[start];

      if (escape) {
        escape = false;
        continue;
      }

      if (inString) {
        if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }

      if (ch === closingChar) {
        depth++;
      } else if (ch === openingChar) {
        depth--;
      }

      if (depth === 0) {
        const candidate = cleaned.slice(start, end + 1);
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          // Not valid JSON at this boundary; keep scanning
          break;
        }
      }
    }
  }

  return undefined;
}

export type ParsedStdout = {
  /** The extracted JSON string if found, otherwise the full cleaned text. */
  text: string;
  /** Whether the result was extracted from a JSON object. */
  isJson: boolean;
};

/**
 * Parse agent stdout into a clean result.
 *
 * 1. Strip ANSI escape codes.
 * 2. Attempt to extract the last valid JSON object/array.
 * 3. If found, return it as the result text with `isJson: true`.
 * 4. Otherwise, return the full ANSI-stripped, trimmed text with `isJson: false`.
 */
export function parseStdout(raw: string): ParsedStdout {
  const cleaned = stripAnsi(raw).trim();

  if (cleaned.length === 0) {
    return { text: "", isJson: false };
  }

  const json = extractLastJson(raw);
  if (json !== undefined) {
    return { text: json, isJson: true };
  }

  return { text: cleaned, isJson: false };
}
