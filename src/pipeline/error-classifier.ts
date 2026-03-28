/**
 * Error classifier module.
 *
 * Classifies errors into categories to decide whether a failed pipeline step
 * can be retried (transient) or should be treated as a hard failure (permanent).
 */

export type ErrorCategory = 'transient' | 'permanent' | 'unknown';

/** HTTP status codes considered transient (retryable). */
const TRANSIENT_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** HTTP status codes considered permanent (non-retryable). */
const PERMANENT_STATUS_CODES = new Set([400, 401, 403, 404, 422]);

/** Node/network error codes that are transient. */
const TRANSIENT_ERROR_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
]);

/** Patterns in error messages that indicate a transient failure. */
const TRANSIENT_MESSAGE_PATTERNS: RegExp[] = [
  /rate\s*limit/i,
];

export interface ClassifiableError {
  statusCode?: number;
  status?: number;
  code?: string;
  message?: string;
}

/**
 * Classify an error as transient, permanent, or unknown.
 *
 * Classification priority:
 *  1. HTTP status code
 *  2. Node-level error code (ECONNRESET, etc.)
 *  3. Error message pattern matching
 *  4. Fallback to 'unknown'
 */
export function classifyError(error: ClassifiableError | Error | unknown): ErrorCategory {
  const err = normalizeError(error);

  // 1. Check HTTP status code
  const status = err.statusCode ?? err.status;
  if (status != null) {
    if (TRANSIENT_STATUS_CODES.has(status)) return 'transient';
    if (PERMANENT_STATUS_CODES.has(status)) return 'permanent';
  }

  // 2. Check error code
  if (err.code && TRANSIENT_ERROR_CODES.has(err.code)) {
    return 'transient';
  }

  // 3. Check error message patterns
  if (err.message) {
    for (const pattern of TRANSIENT_MESSAGE_PATTERNS) {
      if (pattern.test(err.message)) return 'transient';
    }
  }

  // 4. Fallback
  return 'unknown';
}

/** Coerce an unknown value into a ClassifiableError shape. */
function normalizeError(error: unknown): ClassifiableError {
  if (error == null) return {};
  if (typeof error === 'object') return error as ClassifiableError;
  if (typeof error === 'string') return { message: error };
  return {};
}
