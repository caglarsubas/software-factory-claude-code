// Seeded-defect suite (P0-06 "done when"): every fixture change runs through the real image
// and containers, and each seeded defect must fail exactly the gate it targets. Needs Docker;
// FACTORY_GATES_IMAGE selects a prebuilt image (CI builds it in the `gates` job).
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createValidator } from "../../controller/src/schemas/validate.ts";
import { ENGINE, HARDENING } from "./container.ts";
import type { Sink } from "./findings.ts";
import { ensureImage, GATES_DIR } from "./image.ts";
import type { GateProfile } from "./plan.ts";
import { runGates, type GatesResult } from "./run.ts";

const image = process.env["FACTORY_GATES_IMAGE"] ?? ensureImage();
const cacheVolume = `sf-gates-cache-int-${randomBytes(3).toString("hex")}`;
const osvVolume = process.env["FACTORY_GATES_OSV_VOLUME"] ?? "sf-gates-osv";
const fetchNetwork = process.env["FACTORY_GATES_FETCH_NETWORK"] ?? "bridge";
const caFile = process.env["FACTORY_GATES_CA_FILE"];
const work = mkdtempSync(join(tmpdir(), "gates-int-"));
const validator = createValidator();

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
  spawnSync(ENGINE, ["volume", "rm", "-f", cacheVolume], { stdio: "ignore" });
});

const profiles: Record<"ts" | "py", GateProfile> = {
  ts: {
    commands: {
      setup: "pnpm install --frozen-lockfile",
      typecheck: "pnpm exec tsc --noEmit",
      lint: "pnpm exec tsc --noEmit -p tsconfig.lint.json",
      test: "node --test",
    },
    gates: { adapters: ["typescript"] },
  },
  py: {
    commands: { setup: "uv sync --frozen", typecheck: "uv run --frozen mypy", lint: "uv run --frozen ruff check", test: "uv run --frozen pytest -q" },
    gates: { adapters: ["python"] },
    invariants: [{ id: "INV-1", text: "An empty cart costs nothing", check: "uv run --frozen pytest -q -k empty" }],
  },
};

/** An AWS-shaped key pair made at run time, so no secret-looking literal lives in this repository. */
function fakeAwsKey(): { id: string; secret: string } {
  const pick = (alphabet: string, n: number) => [...randomBytes(n)].map((b) => alphabet.charAt(b % alphabet.length)).join("");
  return { id: `AKIA${pick("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567", 16)}`, secret: pick("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789", 40) };
}

const variant = (name: string, file: string) => readFileSync(join(GATES_DIR, "fixtures/variants", name, `${file}.fixture`), "utf8");

interface Case {
  name: string;
  files: Record<string, string>;
  /** Gates that must not pass; every other gate must pass. */
  failing: string[];
  sinks?: Sink[];
  secret?: boolean;
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=gates@example.invalid", "-c", "user.name=gates", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

async function run(fixture: "ts" | "py", c: Case): Promise<GatesResult> {
  const repo = mkdtempSync(join(work, `${fixture}-`));
  cpSync(join(GATES_DIR, "fixtures", fixture), repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", "base"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  for (const [path, content] of Object.entries(c.files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-qm", c.name]);
  return runGates({
    worktree: repo,
    base,
    taskId: "T-0001",
    profile: profiles[fixture],
    image,
    cacheVolume,
    osvVolume,
    fetchNetwork,
    ...(caFile === undefined ? {} : { caFile }),
  });
}

function check(result: GatesResult, c: Case): void {
  const validation = validator.validate("gates.schema.json", result);
  expect(validation.errors).toEqual([]);
  const notPassing = result.gates.filter((g) => g.status !== "pass").map((g) => g.name).sort();
  expect(notPassing, JSON.stringify(result.gates, null, 2)).toEqual([...c.failing].sort());
  expect(result.passed).toBe(c.failing.length === 0);
  expect(result.signals.sink_added).toEqual(c.sinks ?? []);
  expect(result.signals.secret_material).toBe(c.secret ?? false);
}

const tsCart = readFileSync(join(GATES_DIR, "fixtures/ts/src/cart.ts"), "utf8");
const tsTest = readFileSync(join(GATES_DIR, "fixtures/ts/test/cart.test.ts"), "utf8");
const pyCart = readFileSync(join(GATES_DIR, "fixtures/py/src/cart.py"), "utf8");
const pyTest = readFileSync(join(GATES_DIR, "fixtures/py/tests/test_cart.py"), "utf8");
const tsKey = fakeAwsKey();
const pyKey = fakeAwsKey();

const tsCases: Case[] = [
  { name: "clean change", files: { "src/cart.ts": `${tsCart}\nexport const isEmpty = (lines: readonly Line[]): boolean => lines.length === 0;\n` }, failing: [] },
  { name: "type error", files: { "src/cart.ts": `${tsCart}\nexport const count: number = "three";\n` }, failing: ["typecheck", "lint"] },
  { name: "lint error", files: { "src/cart.ts": `${tsCart}\nfunction unused(): void {}\n` }, failing: ["lint"] },
  { name: "failing test", files: { "test/cart.test.ts": tsTest.replace("600);", "601);") }, failing: ["test"] },
  {
    name: "insecure TLS",
    files: { "src/http.ts": 'import https from "node:https";\n\nexport const agent = new https.Agent({ rejectUnauthorized: false });\n' },
    failing: ["sast"],
  },
  {
    name: "suppression comment does not hide a finding",
    files: { "src/http.ts": 'import https from "node:https";\n\nexport const agent = new https.Agent({ rejectUnauthorized: false }); // nosemgrep\n' },
    failing: ["sast"],
  },
  {
    name: "export-ignore does not hide a file",
    files: {
      ".gitattributes": "src/hidden.ts export-ignore\n",
      "src/hidden.ts": 'import https from "node:https";\n\nexport const agent = new https.Agent({ rejectUnauthorized: false });\n',
    },
    failing: ["sast"],
  },
  {
    name: "sinks added",
    files: {
      "src/run.ts": 'import { execFileSync } from "node:child_process";\n\nexport const run = (cmd: string): string => execFileSync(cmd, { encoding: "utf8" });\n',
      "src/evaluate.ts": "export const evaluate = (source: string): unknown => eval(source);\n",
    },
    failing: [],
    sinks: ["code_exec", "shell"],
  },
  {
    name: "secret",
    files: { "src/config.ts": `export const awsAccessKeyId = "${tsKey.id}";\nexport const awsSecretAccessKey = "${tsKey.secret}";\n` },
    failing: ["secret-scan"],
    secret: true,
  },
  {
    name: "ignore tag does not hide a secret",
    files: { "src/config.ts": `export const awsAccessKeyId = "${tsKey.id}"; // trufflehog:ignore\nexport const awsSecretAccessKey = "${tsKey.secret}"; // trufflehog:ignore\n` },
    failing: ["secret-scan"],
    secret: true,
  },
  {
    name: "vulnerable dependency",
    files: { "package.json": variant("ts-vulnerable-dependency", "package.json"), "pnpm-lock.yaml": variant("ts-vulnerable-dependency", "pnpm-lock.yaml") },
    failing: ["dependency-audit"],
  },
  {
    name: "lockfile out of date",
    files: { "package.json": variant("ts-vulnerable-dependency", "package.json") },
    failing: ["setup", "typecheck", "lint", "test"],
  },
];

const pyCases: Case[] = [
  { name: "clean change", files: { "src/cart.py": `${pyCart}\n\ndef is_empty(lines: list[Line]) -> bool:\n    return not lines\n` }, failing: [] },
  { name: "type error", files: { "src/cart.py": `${pyCart}\n\ndef count() -> int:\n    return "three"\n` }, failing: ["typecheck"] },
  { name: "lint error", files: { "src/cart.py": `import os\n${pyCart}` }, failing: ["lint"] },
  { name: "failing test", files: { "tests/test_cart.py": pyTest.replace("== 600", "== 601") }, failing: ["test"] },
  {
    name: "insecure TLS",
    files: { "src/net.py": "import ssl\n\n\ndef context() -> ssl.SSLContext:\n    return ssl._create_unverified_context()\n" },
    failing: ["sast"],
  },
  {
    name: "sinks added",
    files: {
      "src/jobs.py":
        "import pickle\nimport subprocess\n\n\ndef run(cmd: str) -> int:\n    return subprocess.run(cmd, shell=True, check=False).returncode\n\n\ndef load(blob: bytes) -> object:\n    value: object = pickle.loads(blob)\n    return value\n",
    },
    failing: [],
    sinks: ["deserialization", "shell"],
  },
  {
    name: "secret",
    files: { "src/settings.py": `AWS_ACCESS_KEY_ID = "${pyKey.id}"\nAWS_SECRET_ACCESS_KEY = "${pyKey.secret}"\n` },
    failing: ["secret-scan"],
    secret: true,
  },
  {
    name: "vulnerable dependency",
    files: { "pyproject.toml": variant("py-vulnerable-dependency", "pyproject.toml"), "uv.lock": variant("py-vulnerable-dependency", "uv.lock") },
    failing: ["dependency-audit"],
  },
];

describe("rule packs", () => {
  // `opengrep test` needs the trailing slashes: without them it pairs rules and targets wrongly.
  it("pass their annotated tests (opengrep test)", () => {
    const r = spawnSync(
      ENGINE,
      ["run", "--rm", ...HARDENING, "--network", "none", "--mount", `type=bind,src=${join(GATES_DIR, "rules")},dst=/rules,readonly`, image, "opengrep", "test", "--config", "/rules/", "/rules/"],
      { encoding: "utf8" },
    );
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/All tests passed/);
  });
});

describe.concurrent("TypeScript fixture", () => {
  it.each(tsCases)("$name", async (c) => {
    check(await run("ts", c), c);
  });
});

describe.concurrent("Python fixture", () => {
  it.each(pyCases)("$name", async (c) => {
    check(await run("py", c), c);
  });
});
