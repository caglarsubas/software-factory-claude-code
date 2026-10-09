import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { POLICY_FILES, REPO_ROOT } from "../policy/load.ts";
import { createValidator, SCHEMA_DIR } from "./validate.ts";

const validator = createValidator();
const FIXTURES = join(SCHEMA_DIR, "fixtures");
const ARTIFACTS = ["task", "triage", "spec", "plan", "finding", "review", "verdict", "summary", "manifest", "event", "gates", "profile"];

const read = (path: string): unknown =>
  path.endsWith(".json") ? JSON.parse(readFileSync(path, "utf8")) : parse(readFileSync(path, "utf8"));
const fixtures = (schema: string, kind: "valid" | "invalid"): string[] => {
  const dir = join(FIXTURES, schema, kind);
  return existsSync(dir) ? readdirSync(dir).map((f) => join(dir, f)) : [];
};

describe("schemas", () => {
  // Shared definitions and findings (embedded in reviews) are not standalone documents.
  const EMBEDDED = new Set(["defs.schema.json", "finding.schema.json"]);

  it("every standalone schema compiles in strict mode and pins schema_version", () => {
    expect(validator.schemas.length).toBeGreaterThanOrEqual(17);
    for (const file of validator.schemas) {
      expect(() => validator.validate(file, {}), file).not.toThrow();
      if (EMBEDDED.has(file)) continue;
      const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as { required?: string[] };
      expect(schema.required, file).toContain("schema_version");
    }
  });

  it("covers every artifact the roadmap names (P0-02)", () => {
    for (const name of ARTIFACTS) expect(validator.schemas).toContain(`${name}.schema.json`);
  });
});

describe.each(readdirSync(FIXTURES))("%s fixtures", (schema) => {
  const valid = fixtures(schema, "valid");
  const invalid = fixtures(schema, "invalid");

  it.each(valid)("accepts %s", (path) => {
    expect(validator.validate(`${schema}.schema.json`, read(path)).errors).toEqual([]);
  });

  it.each(invalid)("rejects %s", (path) => {
    expect(validator.validate(`${schema}.schema.json`, read(path)).valid).toBe(false);
  });
});

describe("fixture coverage", () => {
  it.each(ARTIFACTS.filter((a) => a !== "profile"))("%s has valid and invalid fixtures", (name) => {
    expect(fixtures(name, "valid").length).toBeGreaterThan(0);
    expect(fixtures(name, "invalid").length).toBeGreaterThan(0);
  });
});

describe("repository files", () => {
  it.each(Object.entries(POLICY_FILES))("%s matches %s", (file, schema) => {
    expect(validator.validate(schema, read(join(REPO_ROOT, file))).errors).toEqual([]);
  });

  it.each(["profiles/self/profile.yaml", "profiles/template/profile.yaml"])("%s is a valid profile", (file) => {
    expect(validator.validate("profile.schema.json", read(join(REPO_ROOT, file))).errors).toEqual([]);
  });
});
