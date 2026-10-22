// The private store (P2-11, ADR 0003): one directory per target, private to the operator, each
// record checked against its schema on the way in and out, and a profile that drifted from the
// one confirmed refused to tasks.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { factoryHome } from "../home.ts";
import { createValidator } from "../schemas/validate.ts";
import { activeProfile, journal, listTargets, profileDigest, profileFile, readTarget, RegistryError, targetDir, writeTarget, type TargetRecord } from "./registry.ts";

const scratch = mkdtempSync(join(tmpdir(), "registry-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const validator = createValidator();
const home = factoryHome({ FACTORY_HOME: join(scratch, "home") });
const at = "2026-10-22T09:00:00.000Z";
const record = (repo: string, state: TargetRecord["state"]): TargetRecord => ({ schema_version: 1, repo, remote: `https://github.com/${repo}.git`, default_branch: "main", state, created_at: at, updated_at: at });

describe("the private store", () => {
  it("keeps one private directory per target, and refuses a record its schema does not", () => {
    expect(listTargets(home, validator)).toEqual([]);
    writeTarget(home, record("example/b", "drafted"), validator);
    writeTarget(home, record("example/a", "drafted"), validator);
    journal(home, "example/a", { by: "op", step: "draft" }, new Date(at));
    expect(listTargets(home, validator).map((t) => t.repo)).toEqual(["example/a", "example/b"]);
    expect(statSync(targetDir(home, "example/a")).mode & 0o777).toBe(0o700);
    expect(statSync(join(targetDir(home, "example/a"), "target.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(targetDir(home, "example/a"), "journal.ndjson")).mode & 0o777).toBe(0o600);
    expect(() => {
      writeTarget(home, { ...record("example/c", "drafted"), state: "gone" as TargetRecord["state"] }, validator);
    }).toThrow(RegistryError);
    expect(readTarget(home, "example/c", validator)).toBeNull();
    // A record edited by hand into something else is refused on the way out too.
    mkdirSync(targetDir(home, "example/d"), { recursive: true });
    writeFileSync(join(targetDir(home, "example/d"), "target.json"), JSON.stringify({ ...record("example/d", "active"), extra: true }));
    expect(() => readTarget(home, "example/d", validator)).toThrow(/target\.json/);
    rmSync(targetDir(home, "example/d"), { recursive: true });
  });

  it("keeps every target's directory inside the store", () => {
    for (const bad of ["a/b/c", "a", "a/../../b", "", "o/x\n"]) expect(() => targetDir(home, bad)).toThrow(RegistryError);
    // One slash, made one path component: never a step out.
    expect(targetDir(home, "../x")).toBe(join(home.targets, "..__x"));
    expect(targetDir(home, "o/..")).toBe(join(home.targets, "o__.."));
  });

  it("gives tasks only an active target's profile, as it was confirmed", () => {
    expect(() => activeProfile(home, "example/none", validator)).toThrow("example/none is not onboarded: factoryctl onboard example/none");
    expect(() => activeProfile(home, "example/a", validator)).toThrow("example/a is drafted, not active: factoryctl onboard example/a takes it further");
    writeFileSync(profileFile(home, "example/a"), "schema_version: 1\n");
    const confirmed = { at, by: "op", profile_digest: profileDigest(home, "example/a"), release: { repo: "example/factory", sha: "3".repeat(40), tag: "v0.22.0" }, branch: "software-factory/onboard", base: "1".repeat(40), commit: "2".repeat(40), layer: { created: [], blocks: [], settings: [] } };
    writeTarget(home, { ...record("example/a", "active"), confirmed, active: { at, rulesets: ["factory-main", "factory-branches"] } }, validator);
    expect(activeProfile(home, "example/a", validator).path).toBe(profileFile(home, "example/a"));
    writeFileSync(profileFile(home, "example/a"), "schema_version: 1\nbudgets: {monthly_usd: 100}\n");
    expect(() => activeProfile(home, "example/a", validator)).toThrow(/changed since it was confirmed: factoryctl onboard example\/a --update proposes the change/);
    rmSync(profileFile(home, "example/a"));
    expect(() => activeProfile(home, "example/a", validator)).toThrow(/profile\.yaml is missing/);
  });
});
