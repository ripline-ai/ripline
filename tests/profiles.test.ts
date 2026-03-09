import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  loadProfile,
  listProfiles,
  mergeInputs,
} from "../src/profiles.js";

describe("loadProfile", () => {
  it("loads a valid profile YAML and returns profile", () => {
    const dir = path.join(os.tmpdir(), "ripline-profile-load-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "myapp.yaml"),
      `name: myapp
description: My Rails app
inputs:
  projectRoot: /code/myapp
  memoryPath: /code/myapp/.context/memory.md
`,
      "utf-8"
    );
    try {
      const p = loadProfile("myapp", dir);
      expect(p.name).toBe("myapp");
      expect(p.description).toBe("My Rails app");
      expect(p.inputs).toEqual({
        projectRoot: "/code/myapp",
        memoryPath: "/code/myapp/.context/memory.md",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws with clear message when profile not found", () => {
    const dir = path.join(os.tmpdir(), "ripline-profile-missing-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      expect(() => loadProfile("nonexistent", dir)).toThrow(
        /Profile not found.*nonexistent.*looked in/
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads .yml extension", () => {
    const dir = path.join(os.tmpdir(), "ripline-profile-yml-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "foo.yml"),
      "name: foo\ninputs:\n  x: 1\n",
      "utf-8"
    );
    try {
      const p = loadProfile("foo", dir);
      expect(p.name).toBe("foo");
      expect(p.inputs).toEqual({ x: 1 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("listProfiles", () => {
  it("returns all valid profiles in directory", () => {
    const dir = path.join(os.tmpdir(), "ripline-profile-list-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "a.yaml"),
      "name: a\ninputs: {}\n",
      "utf-8"
    );
    fs.writeFileSync(
      path.join(dir, "b.yaml"),
      "name: b\ndescription: B\ninputs:\n  key: val\n",
      "utf-8"
    );
    try {
      const list = listProfiles(dir);
      expect(list).toHaveLength(2);
      const names = list.map((p) => p.name).sort();
      expect(names).toEqual(["a", "b"]);
      const b = list.find((p) => p.name === "b");
      expect(b?.description).toBe("B");
      expect(b?.inputs).toEqual({ key: "val" });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array for empty directory", () => {
    const dir = path.join(os.tmpdir(), "ripline-profile-empty-" + Date.now());
    fs.mkdirSync(dir, { recursive: true });
    try {
      expect(listProfiles(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty array for missing directory", () => {
    const dir = path.join(os.tmpdir(), "ripline-profile-missing-dir-" + Date.now());
    expect(listProfiles(dir)).toEqual([]);
  });
});

describe("mergeInputs", () => {
  it("returns profile inputs when no explicit input", () => {
    const profile = {
      name: "p",
      inputs: { a: 1, b: 2 },
    };
    expect(mergeInputs(profile, {})).toEqual({ a: 1, b: 2 });
  });

  it("explicit input overrides profile input for same key", () => {
    const profile = {
      name: "p",
      inputs: { a: 1, b: 2 },
    };
    expect(mergeInputs(profile, { b: 99 })).toEqual({ a: 1, b: 99 });
  });

  it("explicit input is merged with non-overlapping profile inputs", () => {
    const profile = {
      name: "p",
      inputs: { a: 1, b: 2 },
    };
    expect(mergeInputs(profile, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("handles null profile (no profile passed)", () => {
    expect(mergeInputs(null, { x: 1 })).toEqual({ x: 1 });
    expect(mergeInputs(null, {})).toEqual({});
  });
});
