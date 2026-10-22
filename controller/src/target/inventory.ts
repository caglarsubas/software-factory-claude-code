// Onboarding's inventory (ROADMAP P2-11): what a target holds at one commit, read from its bare
// mirror without a checkout, and the draft profile proposed from it. It proposes; the operator
// decides at the STOP. A command it cannot find, or a stack it does not know, is a note for the
// operator, never a guess.
import { spawnSync } from "node:child_process";
import { stringify } from "yaml";
import { ADAPTERS } from "../../../gates/src/plan.ts";
import { git } from "../git/repo.ts";
import type { RiskPolicy } from "../policy/engine.ts";
import picomatch from "picomatch";

export interface TreeView {
  files: string[];
  read(path: string): string | null;
}

/** A commit's files, read from a (bare) repository. */
export function treeOf(repo: string, commit: string): TreeView {
  const files = git(repo, ["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter((f) => f !== "");
  return {
    files,
    read: (path) => {
      const r = spawnSync("git", ["-C", repo, "show", `${commit}:${path}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return r.status === 0 ? r.stdout : null;
    },
  };
}

export type PackageManager = "pnpm" | "npm" | "yarn" | "bun" | "uv";

export interface Inventory {
  schema_version: 1;
  repo: string;
  head: string;
  default_branch: string;
  adapters: ("typescript" | "python")[];
  package_manager: PackageManager | null;
  commands: { setup?: string; build?: string; typecheck?: string; lint?: string; test?: string };
  ci: string[];
  codeowners: string | null;
  notes: string[];
}

const LOCKFILES: Record<string, PackageManager> = {
  "pnpm-lock.yaml": "pnpm",
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "uv.lock": "uv",
};

const SETUP: Record<PackageManager, string> = {
  pnpm: "pnpm install --frozen-lockfile",
  npm: "npm ci",
  yarn: "yarn install --frozen-lockfile",
  bun: "bun install --frozen-lockfile",
  uv: "uv sync --frozen",
};

/** The factory's own workflows, which the footprint writes: not the target's CI. */
const FACTORY_WORKFLOWS = new Set([".github/workflows/factory-gates.yml", ".github/workflows/policy-check.yml"]);

/** Where GitHub looks for CODEOWNERS, in its order. */
const CODEOWNERS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** A package.json script as the gates run it: node itself as written, a plain pnpm tool through pnpm exec, else through the package manager. */
function scriptCommand(pm: PackageManager, name: string, body: string): string {
  if (/^node(\s|$)/.test(body)) return body;
  if (pm === "pnpm" && !/[&|;<>$`]/.test(body)) return `pnpm exec ${body}`;
  return pm === "npm" ? `npm run ${name}` : `${pm} run ${name}`;
}

/** Whether pyproject.toml uses a Python tool: a [tool.X] table or a dependency that names it. */
const usesTool = (pyproject: string, tool: string): boolean => new RegExp(`^\\[tool\\.${tool}(\\.|\\])`, "m").test(pyproject) || new RegExp(`["']${tool}([=<>!~ \\[]|["'])`).test(pyproject);

export function inventory(repo: string, head: string, defaultBranch: string, tree: TreeView): Inventory {
  const root = new Set(tree.files.filter((f) => !f.includes("/")));
  const notes: string[] = [];
  const lock = [...root].map((f) => LOCKFILES[f]).find((pm) => pm !== undefined) ?? null;
  const adapters: Inventory["adapters"] = [];
  const commands: Inventory["commands"] = {};
  let pm: PackageManager | null = null;
  if (root.has("package.json")) {
    adapters.push("typescript");
    if ([...root].some((f) => ADAPTERS.typescript.lockfiles.test(f)) && lock !== null && lock !== "uv") pm = lock;
    if (pm === null) notes.push("package.json without a lockfile the gates know: add one, or set the setup command yourself");
    else {
      commands.setup = SETUP[pm];
      const scripts = ((JSON.parse(tree.read("package.json") ?? "{}") as { scripts?: Record<string, string> }).scripts ?? {});
      for (const [kind, names] of [["build", ["build"]], ["typecheck", ["typecheck", "type-check", "tsc"]], ["lint", ["lint"]], ["test", ["test"]]] as const) {
        const name = names.find((n) => scripts[n] !== undefined);
        if (name !== undefined) commands[kind] = scriptCommand(pm, name, scripts[name] ?? "");
      }
    }
  } else if (root.has("pyproject.toml") || [...root].some((f) => ADAPTERS.python.lockfiles.test(f))) {
    adapters.push("python");
    if (lock === "uv") {
      pm = "uv";
      commands.setup = SETUP.uv;
      const pyproject = tree.read("pyproject.toml") ?? "";
      if (usesTool(pyproject, "mypy")) commands.typecheck = "uv run --frozen mypy";
      if (usesTool(pyproject, "ruff")) commands.lint = "uv run --frozen ruff check";
      if (usesTool(pyproject, "pytest")) commands.test = "uv run --frozen pytest -q";
    } else {
      notes.push("a Python project without uv.lock: the inventory proposes commands for uv only; set them yourself");
    }
  } else {
    notes.push("no package.json or pyproject.toml at the root: the gates support TypeScript and Python");
  }
  if (adapters.length > 0 && commands.test === undefined) notes.push("no test command found: set commands.test, or the target cannot be admitted");
  const ci = tree.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f) && !FACTORY_WORKFLOWS.has(f)).sort();
  return { schema_version: 1, repo, head, default_branch: defaultBranch, adapters, package_manager: pm, commands, ci, codeowners: CODEOWNERS.find((p) => tree.files.includes(p)) ?? null, notes };
}

export interface DraftInput {
  visibility: "public" | "private";
  /** The operator's GitHub login: the approver and intake maintainer until they say otherwise. */
  login: string;
  /** The release the footprint will pin. */
  tag: string;
  retention: { bundles: number; transcripts: number; otel: number };
  monthlyUsd: number;
  risk: RiskPolicy;
}

/** The profile proposed for the operator to edit, as YAML with what to decide in comments. */
export function draftProfile(inv: Inventory, tree: TreeView, d: DraftInput): { profile: Record<string, unknown>; yaml: string } {
  const profile: Record<string, unknown> = {
    schema_version: 1,
    target: { repo: inv.repo, default_branch: inv.default_branch, visibility: d.visibility },
    factory_release: d.tag,
    commands: { ...inv.commands, test: inv.commands.test ?? "set the test command" },
    gates: { adapters: inv.adapters.length > 0 ? inv.adapters : ["typescript"], sast_rules: ["default", "sink_added"] },
    protected_paths: [],
    restricted: [],
    egress_class: "anthropic_only",
    budgets: { monthly_usd: d.monthlyUsd },
    spec_dir: "docs/specs",
    retention_days: d.retention,
    governance: { approvers: [d.login] },
    intake: { label: "factory", maintainers: [d.login] },
  };
  // Files the release's own rules already hold at R3 or above, so the operator sees what is covered.
  const covered = d.risk.rules.flatMap((r) => (r.minimum_risk === "R3" || r.minimum_risk === "Restricted" ? (r.when.any_path ?? []).map((g) => [g, r.minimum_risk ?? "R3"] as const) : []));
  const hits = tree.files.flatMap((f) => {
    const hit = covered.find(([g]) => picomatch(g, { dot: true, nocase: true })(f));
    return hit === undefined ? [] : [`#   ${f} (${hit[1]}, by ${hit[0]})`];
  });
  const header = [
    `# Drafted by factoryctl onboard from ${inv.repo} at ${inv.head}. Review every field, then run:`,
    `#   factoryctl onboard ${inv.repo} --confirm`,
    "# protected_paths and restricted add to the release's own rules; these files already match them:",
    ...(hits.length === 0 ? ["#   (none)"] : hits.slice(0, 30)),
    ...(hits.length > 30 ? [`#   … and ${String(hits.length - 30)} more`] : []),
    ...inv.notes.map((n) => `# NOTE: ${n}`),
  ];
  return { profile, yaml: `${header.join("\n")}\n${stringify(profile)}` };
}
