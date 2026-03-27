import { describe, expect, it } from "vitest";
import { stripAnsi, extractLastJson, parseStdout } from "../src/stdout-parser.js";

// ─── stripAnsi ──────────────────────────────────────────────────────────────

describe("stripAnsi", () => {
  it("removes SGR color codes", () => {
    expect(stripAnsi("\x1b[31mERROR\x1b[0m")).toBe("ERROR");
  });

  it("removes multiple ANSI sequences", () => {
    expect(stripAnsi("\x1b[1m\x1b[32mOK\x1b[0m done")).toBe("OK done");
  });

  it("removes cursor movement codes", () => {
    expect(stripAnsi("\x1b[2Jhello\x1b[H")).toBe("hello");
  });

  it("returns plain text unchanged", () => {
    expect(stripAnsi("just plain text")).toBe("just plain text");
  });

  it("handles empty string", () => {
    expect(stripAnsi("")).toBe("");
  });

  it("strips ANSI from within JSON-like text", () => {
    const input = '\x1b[33m{"result":\x1b[0m "hello"}\x1b[0m';
    expect(stripAnsi(input)).toBe('{"result": "hello"}');
  });
});

// ─── extractLastJson ────────────────────────────────────────────────────────

describe("extractLastJson", () => {
  it("extracts a simple JSON object", () => {
    const result = extractLastJson('{"text": "hello"}');
    expect(result).toBe('{"text": "hello"}');
    expect(JSON.parse(result!)).toEqual({ text: "hello" });
  });

  it("extracts last JSON object when preceded by plain text", () => {
    const input = 'Starting task...\nProcessing...\n{"result": "done", "status": "ok"}';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ result: "done", status: "ok" });
  });

  it("extracts last JSON when multiple JSON objects present", () => {
    const input = '{"first": 1}\nsome text\n{"second": 2}';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ second: 2 });
  });

  it("extracts JSON with ANSI codes interspersed", () => {
    const input = '\x1b[32m{"text": "hello world"}\x1b[0m';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ text: "hello world" });
  });

  it("handles trailing newlines and blank lines after JSON", () => {
    const input = '{"done": true}\n\n\n';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ done: true });
  });

  it("handles nested objects", () => {
    const input = 'prefix\n{"outer": {"inner": [1,2,3]}}';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ outer: { inner: [1, 2, 3] } });
  });

  it("handles JSON with escaped quotes in strings", () => {
    const input = '{"text": "he said \\"hello\\""}';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ text: 'he said "hello"' });
  });

  it("handles JSON with braces inside strings", () => {
    const input = '{"code": "function() { return {}; }"}';
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({ code: "function() { return {}; }" });
  });

  it("extracts JSON array", () => {
    const input = "some output\n[1, 2, 3]";
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual([1, 2, 3]);
  });

  it("returns undefined for plain text with no JSON", () => {
    expect(extractLastJson("just plain text output")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractLastJson("")).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(extractLastJson("{not valid json}")).toBeUndefined();
  });

  it("handles complex ANSI-contaminated multi-line output", () => {
    const input = [
      "\x1b[1m\x1b[34m⏳ Running agent...\x1b[0m",
      "\x1b[33mStep 1: reading files\x1b[0m",
      "\x1b[33mStep 2: processing\x1b[0m",
      '\x1b[32m{"text": "Implementation complete", "files": ["a.ts", "b.ts"]}\x1b[0m',
      "",
    ].join("\n");
    const result = extractLastJson(input);
    expect(JSON.parse(result!)).toEqual({
      text: "Implementation complete",
      files: ["a.ts", "b.ts"],
    });
  });
});

// ─── parseStdout ────────────────────────────────────────────────────────────

describe("parseStdout", () => {
  it("extracts JSON result from clean output", () => {
    const result = parseStdout('{"text": "hello"}');
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ text: "hello" });
  });

  it("extracts JSON from ANSI-contaminated output", () => {
    const input = '\x1b[32mDone!\x1b[0m\n\x1b[1m{"result": "success"}\x1b[0m\n';
    const result = parseStdout(input);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ result: "success" });
  });

  it("returns full text when no JSON is present", () => {
    const input = "Task completed successfully\nAll files updated";
    const result = parseStdout(input);
    expect(result.isJson).toBe(false);
    expect(result.text).toBe("Task completed successfully\nAll files updated");
  });

  it("strips ANSI from plain text fallback", () => {
    const input = "\x1b[31mError occurred\x1b[0m but recovered";
    const result = parseStdout(input);
    expect(result.isJson).toBe(false);
    expect(result.text).toBe("Error occurred but recovered");
  });

  it("returns empty text for empty input", () => {
    const result = parseStdout("");
    expect(result.isJson).toBe(false);
    expect(result.text).toBe("");
  });

  it("returns empty text for whitespace-only input", () => {
    const result = parseStdout("   \n\n  ");
    expect(result.isJson).toBe(false);
    expect(result.text).toBe("");
  });

  it("handles JSON preceded by plain text lines", () => {
    const input = "Starting...\nWorking on task\nAlmost done\n{\"status\": \"complete\", \"output\": \"42\"}";
    const result = parseStdout(input);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ status: "complete", output: "42" });
  });

  it("handles trailing newlines and blank lines after JSON", () => {
    const input = '{"done": true}\n\n\n\n';
    const result = parseStdout(input);
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ done: true });
  });

  it("handles malformed JSON by returning full text", () => {
    const input = "{not valid json at all}";
    const result = parseStdout(input);
    expect(result.isJson).toBe(false);
    expect(result.text).toBe("{not valid json at all}");
  });

  it("handles multi-line ANSI output with embedded JSON result", () => {
    const lines = [
      "\x1b[1;34m┌─ Agent Output ─┐\x1b[0m",
      "\x1b[33m│ Processing...  │\x1b[0m",
      "\x1b[33m│ Reading files  │\x1b[0m",
      "\x1b[32m│ Done!          │\x1b[0m",
      "\x1b[1;34m└────────────────┘\x1b[0m",
      '\x1b[0m{"text":"All tasks completed","count":3}\x1b[0m',
      "",
      "",
    ];
    const result = parseStdout(lines.join("\n"));
    expect(result.isJson).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ text: "All tasks completed", count: 3 });
  });
});
