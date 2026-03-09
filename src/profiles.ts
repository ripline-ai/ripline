import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { RiplineProfile } from "./types.js";

/**
 * Load a profile by name from the profile directory.
 * Looks for {name}.yaml then {name}.yml. The profile's `name` must match the filename (without extension).
 * @throws Error with clear message if file not found or invalid
 */
export function loadProfile(name: string, profileDir: string): RiplineProfile {
  const base = name.replace(/[/\\]/g, "");
  if (base !== name || !base) {
    throw new Error(`Invalid profile name: ${name}`);
  }
  const dir = path.resolve(profileDir);
  const yamlPath = path.join(dir, `${base}.yaml`);
  const ymlPath = path.join(dir, `${base}.yml`);
  let filePath: string;
  if (fs.existsSync(yamlPath) && fs.statSync(yamlPath).isFile()) {
    filePath = yamlPath;
  } else if (fs.existsSync(ymlPath) && fs.statSync(ymlPath).isFile()) {
    filePath = ymlPath;
  } else {
    throw new Error(`Profile not found: "${name}" (looked in ${dir})`);
  }

  const raw = fs.readFileSync(filePath, "utf-8");
  const parsed = YAML.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid profile "${name}": expected YAML object`);
  }
  const obj = parsed as Record<string, unknown>;
  const profileName = obj.name;
  if (typeof profileName !== "string" || profileName.trim() === "") {
    throw new Error(`Invalid profile "${name}": missing or invalid 'name' field`);
  }
  if (profileName !== base) {
    throw new Error(
      `Invalid profile "${name}": 'name' in file ("${profileName}") must match filename`
    );
  }
  const inputs = obj.inputs;
  const result: RiplineProfile = {
    name: profileName.trim(),
    inputs:
      inputs != null && typeof inputs === "object" && !Array.isArray(inputs)
        ? (inputs as Record<string, unknown>)
        : {},
  };
  if (typeof obj.description === "string") {
    const d = obj.description.trim();
    if (d) result.description = d;
  }
  return result;
}

/**
 * List all valid profiles in the directory (.yaml and .yml). Skips invalid files.
 */
export function listProfiles(profileDir: string): RiplineProfile[] {
  const dir = path.resolve(profileDir);
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const profiles: RiplineProfile[] = [];
  for (const file of entries.sort()) {
    const stem =
      file.endsWith(".yaml") ? file.slice(0, -5) :
      file.endsWith(".yml") ? file.slice(0, -4) :
      null;
    if (stem === null || seen.has(stem)) continue;
    seen.add(stem);
    try {
      profiles.push(loadProfile(stem, dir));
    } catch {
      // skip invalid profiles
    }
  }
  return profiles;
}

/**
 * Merge profile inputs with explicit inputs. Explicit values take precedence.
 * When profile is null, returns a copy of explicitInput only.
 */
export function mergeInputs(
  profile: RiplineProfile | null,
  explicitInput: Record<string, unknown>
): Record<string, unknown> {
  if (profile === null) {
    return { ...explicitInput };
  }
  return { ...profile.inputs, ...explicitInput };
}
