import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs/promises";
import { loadInputs, parseEnvPairs } from "../../src/cli/helpers.js";

describe("parseEnvPairs", () => {
  it("parses key=value pairs into an object", () => {
    expect(parseEnvPairs(["FOO=bar", "BAZ=qux"])).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("treats missing = as key with empty value", () => {
    expect(parseEnvPairs(["NOEQ"])).toEqual({ NOEQ: "" });
  });

  it("allows = in value", () => {
    expect(parseEnvPairs(["A=B=C"])).toEqual({ A: "B=C" });
  });

  it("returns empty object for empty array", () => {
    expect(parseEnvPairs([])).toEqual({});
  });
});

describe("loadInputs", () => {
  it("parses inline JSON when value starts with {", async () => {
    const result = await loadInputs('  {"signals": [1, 2]}  ');
    expect(result).toEqual({ signals: [1, 2] });
  });

  it("loads and parses JSON from file path", async () => {
    const samplesPath = path.join(process.cwd(), "samples", "hello-world-inputs.json");
    const result = await loadInputs(samplesPath);
    expect(result).toHaveProperty("person");
    expect(typeof (result as { person: string }).person).toBe("string");
  });

  it("throws on invalid JSON", async () => {
    await expect(loadInputs("{ invalid }")).rejects.toThrow();
  });

  it("throws on non-existent file path", async () => {
    await expect(loadInputs("/nonexistent/path/to/file.json")).rejects.toThrow();
  });
});
