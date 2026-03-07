import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

const cliPath = path.join(process.cwd(), "dist", "cli", "run.js");

describe("CLI run", () => {
  it(
    "--help lists all options when dist is built",
    () => {
      if (!fs.existsSync(cliPath)) {
        return; // skip when dist not built
      }
      const out = execSync(`node "${cliPath}" --help`, { encoding: "utf-8" });
    expect(out).toContain("--pipeline");
    expect(out).toContain("--inputs");
    expect(out).toContain("--env");
    expect(out).toContain("--resume");
    expect(out).toContain("--out");
    expect(out).toContain("--verbose");
    expect(out).toContain("--demo");
    expect(out).toContain("--enqueue");
    expect(out).toContain("-p");
    expect(out).toContain("-i");
    expect(out).toContain("-o");
    expect(out).toContain("-v");
    },
    30000,
  );
});
