import { describe, expect, it } from "vitest";
import {
  detectHttpError,
  isRetryableHttpError,
  computeBackoffMs,
  HttpResponseError,
} from "../../src/lib/http-response-guard.js";

// ─── detectHttpError ─────────────────────────────────────────────────────────

describe("detectHttpError", () => {
  describe("Anthropic API error JSON", () => {
    it("detects rate_limit_error and maps to 429", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Number of request tokens has exceeded your per-minute rate limit",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(429);
      expect(result!.message).toContain("rate_limit_error");
    });

    it("detects overloaded_error and maps to 529", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "overloaded_error",
          message: "Overloaded",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(529);
    });

    it("detects api_error and maps to 500", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "api_error",
          message: "Internal server error",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(500);
    });

    it("detects authentication_error and maps to 401", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "authentication_error",
          message: "Invalid API key",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(401);
    });

    it("detects permission_error and maps to 403", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "permission_error",
          message: "Not allowed",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(403);
    });

    it("detects invalid_request_error and maps to 400", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Missing required field",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(400);
    });

    it("falls back to 500 for unknown Anthropic error types", () => {
      const text = JSON.stringify({
        type: "error",
        error: {
          type: "some_new_error_type",
          message: "Something unexpected",
        },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(500);
    });

    it("parses Retry-After from header-style text alongside Anthropic error", () => {
      const text = `retry-after: 30\n${JSON.stringify({
        type: "error",
        error: {
          type: "rate_limit_error",
          message: "Rate limited",
        },
      })}`;
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(429);
      expect(result!.retryAfterSeconds).toBe(30);
    });
  });

  describe("generic HTTP error JSON", () => {
    it("detects error with status code >= 400", () => {
      const text = JSON.stringify({
        error: { message: "Too many requests", status: 429 },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(429);
    });

    it("detects error with code field", () => {
      const text = JSON.stringify({
        error: { message: "Server error", code: 502 },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(502);
    });

    it("ignores generic error JSON with status < 400", () => {
      const text = JSON.stringify({
        error: { message: "Redirect", status: 302 },
      });
      const result = detectHttpError(text);
      expect(result).toBeNull();
    });
  });

  describe("rate-limit keyword fallback", () => {
    it("detects rate limit keyword with error-like JSON structure", () => {
      const text = '{"type": "error", "message": "rate limit exceeded"}';
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(429);
    });

    it("detects rate limit with HTTP/1.1 429 pattern", () => {
      const text = 'HTTP/1.1 429 rate limit exceeded\n{"error": "too many requests"}';
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.statusCode).toBe(429);
    });

    it("ignores rate limit mentions in normal discussion text", () => {
      const text = "The rate limit has been successfully increased and all tests passed.";
      const result = detectHttpError(text);
      expect(result).toBeNull();
    });

    it("ignores rate limit keyword when 'completed' is present", () => {
      const text = '{"type": "info", "message": "rate limit check completed successfully"}';
      const result = detectHttpError(text);
      expect(result).toBeNull();
    });
  });

  describe("clean output", () => {
    it("returns null for valid JSON output", () => {
      const text = JSON.stringify({ stories: [{ id: "s1", title: "Auth" }] });
      expect(detectHttpError(text)).toBeNull();
    });

    it("returns null for plain text output", () => {
      expect(detectHttpError("The feature was implemented successfully.")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(detectHttpError("")).toBeNull();
    });

    it("returns null for null/undefined-ish input", () => {
      expect(detectHttpError(null as unknown as string)).toBeNull();
      expect(detectHttpError(undefined as unknown as string)).toBeNull();
    });
  });

  describe("message truncation", () => {
    it("truncates long error messages to 500 chars", () => {
      const longMessage = "x".repeat(1000);
      const text = JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: longMessage },
      });
      const result = detectHttpError(text);
      expect(result).not.toBeNull();
      expect(result!.message.length).toBeLessThanOrEqual(500);
    });
  });

  describe("Retry-After parsing", () => {
    it("parses retry_after from JSON-style key", () => {
      const text = `"retry_after": 15\n${JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      })}`;
      const result = detectHttpError(text);
      expect(result!.retryAfterSeconds).toBe(15);
    });

    it("ignores Retry-After values >= 3600", () => {
      const text = `retry-after: 7200\n${JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      })}`;
      const result = detectHttpError(text);
      expect(result!.retryAfterSeconds).toBeUndefined();
    });

    it("ignores Retry-After value of 0", () => {
      const text = `retry-after: 0\n${JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Rate limited" },
      })}`;
      const result = detectHttpError(text);
      expect(result!.retryAfterSeconds).toBeUndefined();
    });
  });
});

// ─── isRetryableHttpError ────────────────────────────────────────────────────

describe("isRetryableHttpError", () => {
  it("returns true for 429", () => {
    expect(isRetryableHttpError(429)).toBe(true);
  });

  it("returns true for 500", () => {
    expect(isRetryableHttpError(500)).toBe(true);
  });

  it("returns true for 529 (overloaded)", () => {
    expect(isRetryableHttpError(529)).toBe(true);
  });

  it("returns true for 502 (bad gateway)", () => {
    expect(isRetryableHttpError(502)).toBe(true);
  });

  it("returns false for 400", () => {
    expect(isRetryableHttpError(400)).toBe(false);
  });

  it("returns false for 401", () => {
    expect(isRetryableHttpError(401)).toBe(false);
  });

  it("returns false for 403", () => {
    expect(isRetryableHttpError(403)).toBe(false);
  });

  it("returns false for 404", () => {
    expect(isRetryableHttpError(404)).toBe(false);
  });

  it("returns false for 600", () => {
    expect(isRetryableHttpError(600)).toBe(false);
  });
});

// ─── computeBackoffMs ────────────────────────────────────────────────────────

describe("computeBackoffMs", () => {
  it("returns 5000ms for attempt 1", () => {
    expect(computeBackoffMs(1)).toBe(5_000);
  });

  it("returns 10000ms for attempt 2", () => {
    expect(computeBackoffMs(2)).toBe(10_000);
  });

  it("returns 20000ms for attempt 3", () => {
    expect(computeBackoffMs(3)).toBe(20_000);
  });

  it("caps at 60000ms for high attempt numbers", () => {
    expect(computeBackoffMs(10)).toBe(60_000);
    expect(computeBackoffMs(100)).toBe(60_000);
  });

  it("uses retryAfterSeconds as minimum when larger than exponential", () => {
    // attempt 1 = 5000ms, but retryAfter = 45s = 45000ms
    expect(computeBackoffMs(1, 45)).toBe(45_000);
  });

  it("uses exponential when larger than retryAfterSeconds", () => {
    // attempt 3 = 20000ms, retryAfter = 5s = 5000ms
    expect(computeBackoffMs(3, 5)).toBe(20_000);
  });

  it("returns exponential when retryAfterSeconds is 0", () => {
    expect(computeBackoffMs(1, 0)).toBe(5_000);
  });
});

// ─── HttpResponseError ───────────────────────────────────────────────────────

describe("HttpResponseError", () => {
  it("constructs with statusCode, message, and retryable flag", () => {
    const err = new HttpResponseError({
      statusCode: 429,
      message: "Rate limited",
      retryAfterSeconds: 30,
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpResponseError);
    expect(err.name).toBe("HttpResponseError");
    expect(err.statusCode).toBe(429);
    expect(err.message).toBe("Rate limited");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.retryable).toBe(true);
  });

  it("marks 401 as not retryable", () => {
    const err = new HttpResponseError({
      statusCode: 401,
      message: "Unauthorized",
    });
    expect(err.retryable).toBe(false);
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("marks 500 as retryable", () => {
    const err = new HttpResponseError({
      statusCode: 500,
      message: "Internal server error",
    });
    expect(err.retryable).toBe(true);
  });
});

// ─── Regression: exact bug scenario ──────────────────────────────────────────

describe("Regression: rate-limit mid-pipeline detection", () => {
  it("detects a real Anthropic 429 response that curl returns with exit code 0", () => {
    // This is the exact scenario that caused the bug: curl successfully
    // fetched a 429 response, agent executor treated it as valid output,
    // downstream steps parsed null from it, and the pipeline completed
    // with all-null story results.
    const curlOutput = `{"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit (https://docs.anthropic.com/en/api/rate-limits); see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later. We also have a much higher rate limit tier available for customers who need it: https://docs.anthropic.com/en/api/rate-limits#rate-limits"}}`;

    const result = detectHttpError(curlOutput);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(429);
    expect(result!.message).toContain("rate_limit_error");

    // The error should be flagged as retryable
    expect(isRetryableHttpError(result!.statusCode)).toBe(true);

    // And HttpResponseError should carry the retryable flag
    const err = new HttpResponseError(result!);
    expect(err.retryable).toBe(true);
  });

  it("detects an overloaded_error that also causes silent failures", () => {
    const curlOutput = `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`;

    const result = detectHttpError(curlOutput);
    expect(result).not.toBeNull();
    expect(result!.statusCode).toBe(529);
    expect(new HttpResponseError(result!).retryable).toBe(true);
  });
});
