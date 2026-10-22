// Onboarding's inventory (P2-11): it reads a target at one commit without a checkout, proposes
// the commands the fixtures' own profiles hold, and says what it cannot tell instead of guessing.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { buildTargetRepo, fixtureNames, loadFixture } from "../fixtures/targets.ts";
import { loadRiskPolicy } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { git } from "../cli/testing.ts";
import { draftProfile, inventory, treeOf, type TreeView } from "./inventory.ts";

const scratch = mkdtempSync(join(tmpdir(), "inventory-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});
const validator = createValidator();

/** A tree from a map of files, as the inventory reads one. */
const tree = (files: Record<string, string>): TreeView => ({ files: Object.keys(files).sort(), read: (p) => files[p] ?? null });

const draft = { visibility: "public" as const, login: "operator", tag: "v0.22.0", retention: { bundles: 30, transcripts: 30, otel: 30 }, monthlyUsd: 25, risk: loadRiskPolicy() };

describe("the inventory", () => {
  it.each(fixtureNames())("proposes the %s fixture's own commands and adapters, read from its commit", (name) => {
    const f = loadFixture(name, validator);
    const dir = join(scratch, name);
    const head = buildTargetRepo(f, dir);
    const profile = parse(readFileSync(f.profilePath, "utf8")) as { commands: Record<string, string>; gates: { adapters: string[] } };
    const inv = inventory(`example/${name}`, head, "main", treeOf(dir, head));
    expect(inv.commands).toEqual(profile.commands);
    expect(inv.adapters).toEqual(profile.gates.adapters);
    expect(inv.notes).toEqual([]);
    expect(validator.validate("inventory.schema.json", inv).errors).toEqual([]);
    // The draft is a valid profile, the operator's to edit, and it names what the release already holds at R3.
    const drafted = draftProfile(inv, treeOf(dir, head), draft);
    expect(validator.validate("profile.schema.json", drafted.profile).errors).toEqual([]);
    expect(parse(drafted.yaml)).toEqual(drafted.profile);
    expect(drafted.yaml).toContain(`factoryctl onboard example/${name} --confirm`);
    expect(drafted.profile["governance"]).toEqual({ approvers: ["operator"] });
  });

  it("finds the target's own CI and CODEOWNERS, never the factory's workflows", () => {
    const dir = join(scratch, "ci");
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    for (const f of ["ci.yml", "release.yaml", "factory-gates.yml", "policy-check.yml"]) writeFileSync(join(dir, ".github/workflows", f), "on: push\n");
    writeFileSync(join(dir, ".github/CODEOWNERS"), "* @alice\n");
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc -b && vite build", test: "vitest run", lint: "eslint ." } }));
    writeFileSync(join(dir, "package-lock.json"), "{}\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base"]);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const inv = inventory("example/ci", head, "main", treeOf(dir, head));
    expect(inv.ci).toEqual([".github/workflows/ci.yml", ".github/workflows/release.yaml"]);
    expect(inv.codeowners).toBe(".github/CODEOWNERS");
    // npm runs every script through itself.
    expect(inv.commands).toEqual({ setup: "npm ci", build: "npm run build", lint: "npm run lint", test: "npm run test" });
  });

  it("says what it cannot tell", () => {
    expect(inventory("example/a", "a".repeat(40), "main", tree({ "package.json": "{}" })).notes).toEqual([
      "package.json without a lockfile the gates know: add one, or set the setup command yourself",
      "no test command found: set commands.test, or the target cannot be admitted",
    ]);
    expect(inventory("example/b", "b".repeat(40), "main", tree({ "requirements.txt": "flask\n" })).notes[0]).toMatch(/without uv.lock/);
    expect(inventory("example/c", "c".repeat(40), "main", tree({ "go.mod": "module x\n" }))).toMatchObject({ adapters: [], notes: [expect.stringMatching(/TypeScript and Python/) as unknown] });
    // A pnpm script with shell syntax runs through pnpm, as written.
    expect(inventory("example/d", "d".repeat(40), "main", tree({ "package.json": JSON.stringify({ scripts: { test: "vitest run && node e2e.js" } }), "pnpm-lock.yaml": "" })).commands.test).toBe("pnpm run test");
    // A draft without a test command is still a profile, and it says so where the operator looks.
    const inv = inventory("example/e", "e".repeat(40), "main", tree({ "package.json": "{}", "pnpm-lock.yaml": "" }));
    const drafted = draftProfile(inv, tree({ "src/auth/session.ts": "" }), draft);
    expect(drafted.profile["commands"]).toMatchObject({ test: "set the test command" });
    expect(drafted.yaml).toContain("# NOTE: no test command found");
  });
});
