import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, TIERS, type ChangedFile, type DiffFacts, type ReviewKind, type Tier } from "./engine.ts";
import { loadRiskPolicy, REPO_ROOT } from "./load.ts";

const policy = loadRiskPolicy();
const selfPolicy = loadRiskPolicy(REPO_ROOT, join(REPO_ROOT, "profiles/self/profile.yaml"));

const file = (path: string, lines = 10, previousPath?: string): ChangedFile => ({
  path,
  additions: lines,
  deletions: 0,
  ...(previousPath === undefined ? {} : { previousPath }),
});
const facts = (files: ChangedFile[], extra: Partial<DiffFacts> = {}): DiffFacts => ({
  files,
  sinksAdded: [],
  secretMaterial: false,
  classificationUncertain: false,
  operationRequested: false,
  graphHopsToProtected: null,
  ...extra,
});

interface Case {
  name: string;
  facts: DiffFacts;
  tier: Tier;
  reviews?: ReviewKind[];
}

const defaultCases: Case[] = [
  { name: "docs-only change is R0", facts: facts([file("README.md"), file("docs/guide.md")]), tier: "R0" },
  { name: "ordinary code change is R1", facts: facts([file("src/orders/list.ts")]), tier: "R1" },
  { name: "empty diff is not treated as low risk", facts: facts([]), tier: "R1" },
  { name: "auth path is R3 with security review", facts: facts([file("src/auth/login.ts")]), tier: "R3", reviews: ["security"] },
  { name: "case-variant auth path cannot dodge the rule", facts: facts([file("src/Auth/Login.ts")]), tier: "R3" },
  { name: "workflow change is R3", facts: facts([file(".github/workflows/ci.yml")]), tier: "R3" },
  { name: "migration is R3 with migration and security review", facts: facts([file("db/migrations/001.sql")]), tier: "R3", reviews: ["migration", "security"] },
  { name: "manifest change is R2 with dependency review", facts: facts([file("package.json")]), tier: "R2", reviews: ["dependency", "security"] },
  { name: "nested lockfile counts as a manifest", facts: facts([file("web/pnpm-lock.yaml")]), tier: "R2" },
  { name: "401 changed lines is R2", facts: facts([file("src/a.ts", 401)]), tier: "R2" },
  { name: "400 changed lines stays R1", facts: facts([file("src/a.ts", 400)]), tier: "R1" },
  { name: "new code-exec sink is R3", facts: facts([file("src/a.ts")], { sinksAdded: ["code_exec"] }), tier: "R3", reviews: ["security"] },
  { name: "secret material is Restricted", facts: facts([file("src/a.ts")], { secretMaterial: true }), tier: "Restricted" },
  { name: "licence text is Restricted", facts: facts([file("LICENSE")]), tier: "Restricted" },
  { name: "operation request is Restricted", facts: facts([file("docs/run.md")], { operationRequested: true }), tier: "Restricted" },
  { name: "uncertainty raises R1 to R2", facts: facts([file("src/a.ts")], { classificationUncertain: true }), tier: "R2" },
  { name: "uncertainty raises docs from R0 to R1", facts: facts([file("docs/a.md")], { classificationUncertain: true }), tier: "R1" },
  { name: "uncertainty cannot exceed Restricted", facts: facts([file("LICENSE")], { classificationUncertain: true }), tier: "Restricted" },
  { name: "a proposed tier can raise", facts: facts([file("docs/a.md")], { proposedTier: "R2" }), tier: "R2" },
  { name: "a proposed tier cannot lower", facts: facts([file("src/auth/x.ts")], { proposedTier: "R0" }), tier: "R3" },
  { name: "renaming out of a protected area is judged by the old path", facts: facts([file("docs/x.md", 10, "src/auth/x.ts")]), tier: "R3" },
  { name: "shadow graph rule never changes the tier", facts: facts([file("src/a.ts")], { graphHopsToProtected: 1 }), tier: "R1" },
];

const selfCases: Case[] = [
  { name: "policy engine change is R3", facts: facts([file("controller/src/policy/engine.ts")]), tier: "R3" },
  { name: "roadmap edit is R3 despite the docs baseline", facts: facts([file("docs/factory/ROADMAP.md")]), tier: "R3" },
  { name: "STATUS update stays R0", facts: facts([file("docs/factory/STATUS.md")]), tier: "R0" },
  { name: "uncertainty on an R3 change makes it Restricted", facts: facts([file("policies/risk.yaml")], { classificationUncertain: true }), tier: "Restricted" },
];

describe("evaluate with policies/risk.yaml", () => {
  it.each(defaultCases)("$name", ({ facts: f, tier, reviews }) => {
    const decision = evaluate(f, policy);
    expect(decision.tier).toBe(tier);
    expect(decision.action).toBe(policy.tiers[tier]);
    if (reviews !== undefined) expect(decision.reviews).toEqual(reviews);
  });
});

describe("evaluate with the self profile", () => {
  it.each(selfCases)("$name", ({ facts: f, tier }) => {
    expect(evaluate(f, selfPolicy).tier).toBe(tier);
  });
});

describe("trace", () => {
  it("records the baseline, every rule, and shadow results separately", () => {
    const decision = evaluate(facts([file("src/a.ts")], { graphHopsToProtected: 1 }), policy);
    expect(decision.trace[0]).toMatchObject({ source: "baseline", tierAfter: "R1" });
    expect(decision.trace.filter((t) => t.source === "rule")).toHaveLength(policy.rules.length);
    const shadow = decision.trace.find((t) => t.shadow && t.matched);
    expect(shadow).toMatchObject({ tierAfter: "R2" });
  });
});

describe("fail upward", () => {
  const rank = (t: Tier) => TIERS.indexOf(t);
  const scenarios: DiffFacts[] = defaultCases.map((c) => c.facts);
  const signals: Partial<DiffFacts>[] = [
    { classificationUncertain: true },
    { secretMaterial: true },
    { operationRequested: true },
    { sinksAdded: ["shell"] },
    { proposedTier: "R3" },
    { graphHopsToProtected: 1 },
  ];

  it("adding any risk signal never lowers the tier", () => {
    for (const base of scenarios) {
      for (const signal of signals) {
        expect(rank(evaluate({ ...base, ...signal }, policy).tier)).toBeGreaterThanOrEqual(rank(evaluate(base, policy).tier));
      }
    }
  });

  // An empty diff means "no facts", not "small change": it keeps the default tier (tested above),
  // so monotonicity is a property of non-empty diffs.
  it("adding a changed file to a non-empty diff never lowers the tier", () => {
    for (const base of scenarios.filter((s) => s.files.length > 0)) {
      for (const extra of ["README.md", "src/x.ts", "src/auth/y.ts", "package.json"]) {
        const more = { ...base, files: [...base.files, file(extra)] };
        expect(rank(evaluate(more, policy).tier)).toBeGreaterThanOrEqual(rank(evaluate(base, policy).tier));
      }
    }
  });

  it("a profile never lowers a tier", () => {
    for (const base of scenarios) {
      expect(rank(evaluate(base, selfPolicy).tier)).toBeGreaterThanOrEqual(rank(evaluate(base, policy).tier));
    }
  });
});
