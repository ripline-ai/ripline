/**
 * HTTP Response Guard
 *
 * Detects HTTP error responses (4xx/5xx) embedded in agent output text.
 * When a Claude Code agent runs `curl`, the curl command itself exits 0
 * even when the upstream API returns an error. This guard inspects the
 * agent output for known error patterns and throws so the node-level
 * retry mechanism in the runner can re-attempt.
 *
 * Specifically targets:
 *   - Anthropic / Claude API rate-limit responses (429)
 *   - Generic HTTP error JSON bodies ({ "error": { ... } })
 *   - curl -w HTTP status codes if present
 */

/** Parsed information from an HTTP error detected in agent output. */
export interface HttpErrorInfo {
  statusCode: number;
  message: string;
  retryAfterSeconds?: number;
}

/**
 * Well-known error patterns from the Anthropic API.
 * The API returns JSON like: { "type": "error", "error": { "type": "rate_limit_error", ... } }
 */
const ANTHROPIC_ERROR_PATTERNS: { pattern: RegExp; statusCode: number }[] = [
  { pattern: /rate_limit_error/i, statusCode: 429 },
  { pattern: /overloaded_error/i, statusCode: 529 },
  { pattern: /api_error/i, statusCode: 500 },
  { pattern: /authentication_error/i, statusCode: 401 },
  { pattern: /permission_error/i, statusCode: 403 },
  { pattern: /invalid_request_error/i, statusCode: 400 },
];

/**
 * Inspect agent output text for HTTP error responses.
 * Returns null if output looks clean, or HttpErrorInfo if an error is detected.
 */
export function detectHttpError(text: string): HttpErrorInfo | null {
  if (!text || typeof text !== "string") return null;

  // 1. Check for Anthropic API error JSON: { "type": "error", "error": { "type": "...", "message": "..." } }
  const anthropicErrorMatch = text.match(
    /\{\s*"type"\s*:\s*"error"\s*,\s*"error"\s*:\s*\{[^}]*"type"\s*:\s*"([^"]+)"[^}]*"message"\s*:\s*"([^"]*)"[^}]*\}/s
  );
  if (anthropicErrorMatch) {
    const errorType = anthropicErrorMatch[1]!;
    const errorMsg = anthropicErrorMatch[2]!;
    const knownPattern = ANTHROPIC_ERROR_PATTERNS.find((p) => p.pattern.test(errorType));
    const statusCode = knownPattern?.statusCode ?? 500;
    const retryAfter = parseRetryAfter(text);
    return {
      statusCode,
      message: `Anthropic API error (${errorType}): ${errorMsg}`.slice(0, 500),
      ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
    };
  }

  // 2. Check for generic HTTP error JSON with status code: { "error": { "message": "...", "status": 429 } }
  const httpErrorMatch = text.match(
    /\{\s*"error"\s*:\s*\{[^}]*"(?:status|code)"\s*:\s*(\d{3})/s
  );
  if (httpErrorMatch) {
    const statusCode = parseInt(httpErrorMatch[1]!, 10);
    if (statusCode >= 400) {
      return {
        statusCode,
        message: `HTTP ${statusCode} error in response: ${text.slice(0, 500)}`,
      };
    }
  }

  // 3. Check for rate-limit keywords as a fallback (the response may not be well-formed JSON)
  if (/rate.?limit/i.test(text) && !/successfully|completed|passed/i.test(text)) {
    // Only flag if the text looks like an error response, not a discussion about rate limits
    const looksLikeErrorResponse =
      /\{\s*"(type|error)"/i.test(text) || /HTTP\/[\d.]+ 429/i.test(text);
    if (looksLikeErrorResponse) {
      const retryAfter = parseRetryAfter(text);
      return {
        statusCode: 429,
        message: `Rate limit detected in response: ${text.slice(0, 500)}`,
        ...(retryAfter !== undefined && { retryAfterSeconds: retryAfter }),
      };
    }
  }

  return null;
}

/**
 * Try to parse a Retry-After value from the response text.
 * Looks for: "retry-after: N", "retry_after": N, or "Retry-After: N" in headers or JSON.
 */
function parseRetryAfter(text: string): number | undefined {
  // Header-style: Retry-After: 30
  // Also handles JSON-style: "retry_after": 15
  const headerMatch = text.match(/retry[_-]after"?\s*[:\s]+(\d+)/i);
  if (headerMatch) {
    const val = parseInt(headerMatch[1]!, 10);
    if (val > 0 && val < 3600) return val;
  }
  return undefined;
}

/**
 * Returns true if the status code is retryable (429, 5xx).
 */
export function isRetryableHttpError(statusCode: number): boolean {
  return statusCode === 429 || (statusCode >= 500 && statusCode < 600);
}

/**
 * Compute exponential backoff delay in milliseconds.
 * Base: 5s, factor: 2x, max: 60s.
 * If retryAfterSeconds is provided, use it as the minimum delay.
 */
export function computeBackoffMs(attempt: number, retryAfterSeconds?: number): number {
  const baseMs = 5_000;
  const factor = 2;
  const maxMs = 60_000;
  const exponentialMs = Math.min(baseMs * Math.pow(factor, attempt - 1), maxMs);
  const retryAfterMs = retryAfterSeconds ? retryAfterSeconds * 1000 : 0;
  return Math.max(exponentialMs, retryAfterMs);
}

/**
 * Error class for HTTP errors detected in agent output.
 * Carries structured info so the runner can make retry decisions.
 */
export class HttpResponseError extends Error {
  public readonly statusCode: number;
  public readonly retryAfterSeconds?: number;
  public readonly retryable: boolean;

  constructor(info: HttpErrorInfo) {
    super(info.message);
    this.name = "HttpResponseError";
    this.statusCode = info.statusCode;
    if (info.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = info.retryAfterSeconds;
    }
    this.retryable = isRetryableHttpError(info.statusCode);
  }
}
