// The fixture targets through the real gate runner (needs Docker; CI's gates job). Each target
// is green at its base; each task's hidden tests fail at base and pass once the golden patch is
// in; and the golden change, with the sink signals the SAST gate reports, lands on the task's
// expected tier.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { ensureImage } from "../../../gates/src/image.ts";
import type { GateProfile } from "../../../gates/src/plan.ts";
import { runGates } from "../../../gates/src/run.ts";
import { changedFiles } from "../git/repo.ts";
import { evaluate } from "../policy/engine.ts";
import { loadRiskPolicy, REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { buildTargetRepo, commitGolden, commitHidden, fixtureNames, loadFixture, type Fixture, type FixtureTask } from "./targets.ts";

const validator = createValidator();
const image = process.env["FACTORY_GATES_IMAGE"] ?? ensureImage();
const root = mkdtempSync(join(tmpdir(), "fixtures-int-"));
const cacheVolume = `sf-gates-cache-fixtures-${String(process.pid)}`;
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  spawnSync(process.env["FACTORY_CONTAINER_ENGINE"] ?? "docker", ["volume", "rm", "-f", cacheVolume], { stdio: "ignore" });
});

const gateOptions = {
  image,
  cacheVolume,
  osvVolume: process.env["FACTORY_GATES_OSV_VOLUME"] ?? "sf-gates-osv",
  fetchNetwork: process.env["FACTORY_GATES_FETCH_NETWORK"] ?? "bridge",
  ...(process.env["FACTORY_GATES_CA_FILE"] === undefined ? {} : { caFile: process.env["FACTORY_GATES_CA_FILE"] }),
};

let n = 0;
const repoFor = (f: Fixture): { repo: string; base: string } => {
  const repo = join(root, `${f.name}-${String(++n)}`);
  return { repo, base: buildTargetRepo(f, repo) };
};
const gates = (f: Fixture, repo: string, base: string) =>
  runGates({ worktree: repo, base, taskId: "T-0001", profile: parse(readFileSync(f.profilePath, "utf8")) as GateProfile, ...gateOptions });
const failing = (r: Awaited<ReturnType<typeof gates>>) => r.gates.filter((g) => g.status !== "pass").map((g) => g.name);

describe.each(fixtureNames())("%s", (name) => {
  const f = loadFixture(name, validator);
  const risk = loadRiskPolicy(REPO_ROOT, f.profilePath);
  const cases: [string, FixtureTask][] = f.tasks.map((t) => [t.key, t]);

  it("is green at its base", async () => {
    const { repo, base } = repoFor(f);
    const r = await gates(f, repo, base);
    expect(failing(r), JSON.stringify(r.gates, null, 2)).toEqual([]);
    expect(r.gates.map((g) => g.name)).toEqual(["sast", "secret-scan", "dependency-audit", "setup", "typecheck", "lint", "test", "invariant-inv-1"]);
  });

  describe.concurrent("seeded tasks", () => {
    it.each(cases)("%s: hidden tests fail at base", async (_key, t) => {
      const { repo, base } = repoFor(f);
      commitHidden(repo, f, t);
      const r = await gates(f, repo, base);
      expect(failing(r), JSON.stringify(r.gates, null, 2)).toContain("test");
    });

    it.each(cases)("%s: the golden patch passes every gate, hidden tests included, at the expected tier", async (_key, t) => {
      const { repo, base } = repoFor(f);
      const golden = commitGolden(repo, f, t);
      commitHidden(repo, f, t);
      const r = await gates(f, repo, base);
      expect(failing(r), JSON.stringify(r.gates, null, 2)).toEqual([]);
      expect(r.signals.sink_added).toEqual(t.expect.sinks);
      const decision = evaluate(
        { files: changedFiles(repo, base, golden), sinksAdded: r.signals.sink_added, secretMaterial: r.signals.secret_material, classificationUncertain: false, operationRequested: false, graphHopsToProtected: null },
        risk,
      );
      expect(decision.tier).toBe(t.expect.tier);
    });
  });
});
