// `factoryctl onboard OWNER/NAME` (ROADMAP P2-11, ADR 0003): inventory → profile → STOP →
// footprint PR → rulesets and the App. Each run takes the target one state further and stops
// where a person must act; every step finds before it acts, so a run can be repeated at any
// point, a crashed one included.
//
//   (none) → drafted     inventory, a draft profile (written once, then the operator's), admission
//   drafted → confirmed  --confirm, only once admission passed on the profile as it is now: the
//                        footprint and the layer, built into one deterministic commit
//   confirmed → proposed the commit pushed to software-factory/onboard and its PR opened
//   proposed → merged    the operator merged the PR
//   merged → active      the target's gates passed on the PR, the rulesets applied and checked,
//                        and the App reaches the repository
//   active               checked again: a ruleset that drifted or went missing is applied again,
//                        and the App must still reach the repository
//
// --update re-proposes an active target's footprint (a profile edit, a new release) on
// software-factory/update. The App and the push need the operator's FACTORY_GITHUB_TOKEN
// (Contents, Workflows, Pull requests and Administration: write), never the App's.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { parse } from "yaml";
import type { GatesResult, RunOptions } from "../../../gates/src/run.ts";
import { writeAtomic } from "../fsutil.ts";
import { git, githubRemote, mirrorPath, resolveCommit, syncMirror, type GitAuth } from "../git/repo.ts";
import type { AppConfig } from "../github/app.ts";
import type { GitHub } from "../github/client.ts";
import { rulesetCheck } from "../doctor.ts";
import { applyRulesets, footprintRulesets, GITHUB_ACTIONS_APP_ID, renderFootprint, RULESET_NAMES } from "../governance/footprint.ts";
import type { Home } from "../home.ts";
import { loadRiskPolicy } from "../policy/load.ts";
import type { Release } from "../release.ts";
import { repositoryOf } from "../release/install.ts";
import type { Validator } from "../schemas/validate.ts";
import { loadProfile } from "../task/task.ts";
import { buildCommit, propose } from "./change.ts";
import { admit } from "./admission.ts";
import { appAccess, installationSettings, type TargetReads } from "./github.ts";
import { draftProfile, inventory, treeOf } from "./inventory.ts";
import { hasBlock, renderLayer, type LayerInput } from "./layer.ts";
import { changeOf, inventoryFile, journal, profileDigest, profileFile, readTarget, targetDir, writeTarget, type Confirmed, type TargetRecord } from "./registry.ts";

export class OnboardError extends Error {}

export interface OnboardDeps {
  home: Home;
  validator: Validator;
  release: Release;
  token: string | null;
  api: string;
  app: AppConfig | null;
  github: GitHub | null;
  reads: TargetReads | null;
  runGates: (o: RunOptions, label: string) => Promise<GatesResult>;
  gateImage: () => string;
  operator: string;
  now: () => Date;
  /** The report, line by line (stdout). */
  out: (line: string) => void;
  /** Progress (stderr). */
  log: (line: string) => void;
  probe?: (point: string) => void;
}

export interface OnboardOptions {
  remote?: string;
  confirm?: boolean;
  update?: boolean;
  /** The release to pin, from a development checkout: its tag, resolved in `source`. */
  factoryRef?: string;
  source?: string;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new OnboardError(what);
  return v;
};
const NEED_TOKEN = "FACTORY_GITHUB_TOKEN is needed: the operator's token, with Contents, Workflows, Pull requests and Administration: write on the target";
const NEED_APP = "the factory App is not set: factoryctl app init --app-id N --installation-id N";

/** The release the footprint pins: the installed one, or a tag of a development checkout. */
export function releasePin(release: Release, o: OnboardOptions): { repo: string; sha: string; tag: string } {
  if (release.info !== null) {
    if (release.info.repository === null) throw new OnboardError("the installed release does not record its repository; reinstall it from a clone of the factory's GitHub repository");
    return { repo: release.info.repository, sha: release.info.sha, tag: release.info.tag };
  }
  if (o.factoryRef === undefined) throw new OnboardError("factoryctl runs from a development checkout: name the release the footprint pins with --factory-ref TAG [--source DIR]");
  const source = o.source ?? release.root;
  const sha = git(source, ["rev-parse", "--verify", "--end-of-options", `refs/tags/${o.factoryRef}^{commit}`]).trim();
  const repo = repositoryOf(git(source, ["remote", "get-url", "origin"]).trim());
  if (repo === null) throw new OnboardError(`${source}'s origin is not a GitHub repository`);
  return { repo, sha, tag: o.factoryRef };
}

export async function onboard(repo: string, o: OnboardOptions, d: OnboardDeps): Promise<number> {
  if (!REPO.test(repo)) throw new OnboardError(`not a repository: ${repo} (owner/name)`);
  const record = readTarget(d.home, repo, d.validator);
  const auth: GitAuth | null = d.token === null ? null : { token: d.token };
  const save = (r: TargetRecord, step: Record<string, unknown>): TargetRecord => {
    const next = { ...r, updated_at: d.now().toISOString() };
    writeTarget(d.home, next, d.validator);
    journal(d.home, repo, { by: d.operator, ...step }, d.now());
    return next;
  };

  if (o.confirm === true || o.update === true) {
    if (o.confirm === true && record?.state !== "drafted") throw new OnboardError(record === null ? `${repo} is not onboarding: run factoryctl onboard ${repo} first` : `${repo} is ${record.state}; --confirm follows the draft`);
    if (o.update === true && record?.state !== "active") throw new OnboardError(`${repo} is not active; --update re-proposes an onboarded target`);
    if (record === null) throw new OnboardError(`${repo} is not onboarding`);
    return await proposeFrom(confirm(record, o.update === true));
  }
  if (record === null || record.state === "drafted") return await draft(record);
  if (record.state === "confirmed") return await proposeFrom(record);
  if (record.state === "proposed") return await awaitMerge(record);
  if (record.state === "merged") return await finish(record);
  return await verify(record);

  async function draft(prior: TargetRecord | null): Promise<number> {
    const reads = need(d.reads, NEED_TOKEN);
    const info = await reads.repository(repo);
    const remote = o.remote ?? prior?.remote ?? githubRemote(repo);
    mkdirSync(d.home.mirrors, { recursive: true, mode: 0o700 });
    const mirror = syncMirror(d.home.mirrors, repo, remote, auth);
    const head = resolveCommit(mirror, `refs/heads/${info.defaultBranch}`);
    const tree = treeOf(mirror, head);
    const inv = inventory(repo, head, info.defaultBranch, tree);
    const checked = d.validator.validate("inventory.schema.json", inv);
    if (!checked.valid) throw new OnboardError(`the inventory of ${repo}: ${checked.errors.join("; ")}`);
    mkdirSync(targetDir(d.home, repo), { recursive: true, mode: 0o700 });
    writeAtomic(inventoryFile(d.home, repo), `${JSON.stringify(inv, null, 2)}\n`);
    const path = profileFile(d.home, repo);
    if (!existsSync(path)) {
      const tag = (() => {
        try {
          return releasePin(d.release, o).tag;
        } catch {
          return `v${d.release.version}`;
        }
      })();
      const drafted = draftProfile(inv, tree, { visibility: info.visibility, login: await reads.login(), tag, retention: d.release.config.retention_days, monthlyUsd: d.release.budgets.default_monthly_cap_usd, risk: loadRiskPolicy(d.release.root) });
      writeAtomic(path, drafted.yaml);
      d.out(`drafted ${path} from ${repo} at ${head}`);
    }
    const admission = await admit({
      home: d.home, repo, mirror, inventory: inv, profile: parse(readFileSync(path, "utf8")) as unknown, profileDigest: profileDigest(d.home, repo),
      validator: d.validator, reads, runGates: d.runGates, gateImage: d.gateImage, now: d.now(), log: d.log,
    });
    const now = d.now().toISOString();
    save({ schema_version: 1, repo, remote, default_branch: info.defaultBranch, state: "drafted", created_at: prior?.created_at ?? now, updated_at: now, admission }, { step: "draft", head, admitted: admission.passed });
    for (const c of admission.checks) d.out(`${c.ok ? "ok  " : "fail"}  ${c.name}: ${c.detail}`);
    for (const n of inv.notes) d.out(`note  ${n}`);
    d.out(admission.passed
      ? `STOP: review ${path}, then: factoryctl onboard ${repo} --confirm`
      : `not admitted: fix what fails above (in the target, or in ${path}), then: factoryctl onboard ${repo}`);
    return admission.passed ? 0 : 1;
  }

  function confirm(r: TargetRecord, update: boolean): TargetRecord {
    need(d.token, NEED_TOKEN);
    const app = need(d.app, NEED_APP);
    const path = profileFile(d.home, repo);
    const digest = profileDigest(d.home, repo);
    // The STOP: what is confirmed is the profile admission passed on, unchanged since.
    if (!update && (r.admission?.passed !== true || r.admission.profile_digest !== digest)) {
      throw new OnboardError(r.admission?.passed !== true ? `${repo} was not admitted: factoryctl onboard ${repo} shows why` : `${path} changed since its admission: run factoryctl onboard ${repo} to admit it as it is now`);
    }
    const profile = loadProfile(path, d.validator);
    const pin = releasePin(d.release, o);
    const declared = (parse(readFileSync(path, "utf8")) as { factory_release?: string }).factory_release;
    if (declared !== pin.tag) throw new OnboardError(`${path} says factory_release: ${declared ?? "(none)"}, and the footprint pins ${pin.tag}: set it to ${pin.tag}, then run factoryctl onboard ${repo}${update ? " --update" : ""} again`);
    const mirror = syncMirror(d.home.mirrors, repo, r.remote, auth);
    const base = resolveCommit(mirror, `refs/heads/${r.default_branch}`);
    const tree = treeOf(mirror, base);
    const footprint = renderFootprint({ profile: profile as unknown as Parameters<typeof renderFootprint>[0]["profile"], appId: app.appId, factoryRepo: pin.repo, factoryRef: pin.sha, factoryTag: pin.tag, validator: d.validator });
    // The schema holds protected_paths' tiers to the Tier enum, which the task module's type leaves as a string.
    const layer = renderLayer({ repo, profile: profile as unknown as LayerInput["profile"], risk: loadRiskPolicy(d.release.root, path), release: { repo: pin.repo, tag: pin.tag }, footprint: Object.keys(footprint), existing: (p) => tree.read(p), owned: r.confirmed?.layer.settings ?? [] });
    const at = d.now().toISOString();
    const branch = update ? "software-factory/update" : "software-factory/onboard";
    const files = { ...footprint, ...layer.files };
    const commit = buildCommit(mirror, base, files, `${update ? "Update" : "Add"} the software factory's footprint (${pin.tag})`, at);
    const prior = r.confirmed?.layer ?? { created: [], blocks: [], settings: [] };
    const union = (a: string[], b: string[]): string[] => [...new Set([...a, ...b])];
    // An update keeps the change it replaces: the target holds that one until the update merges, and again if it is closed.
    const replaces = update && r.confirmed !== undefined ? { replaces: changeOf(r.confirmed.replaces ?? r.confirmed) } : {};
    return save({
      ...r,
      state: "confirmed",
      confirmed: { at, by: d.operator, profile_digest: digest, release: pin, branch, base, commit, layer: { created: union(prior.created, [...Object.keys(footprint), ...layer.record.created]), blocks: union(prior.blocks, layer.record.blocks), settings: union(prior.settings, layer.record.settings) }, ...replaces },
    }, { step: update ? "update" : "confirm", commit, release: pin.tag, files: Object.keys(files).sort() });
  }

  async function proposeFrom(r: TargetRecord): Promise<number> {
    const github = need(d.github, NEED_TOKEN);
    const c = r.confirmed;
    if (c === undefined) throw new OnboardError(`${repo} has nothing confirmed to propose`);
    const mirror = mirrorPath(d.home.mirrors, repo);
    if (git(mirror, ["cat-file", "-t", c.commit], { allowFail: true }).trim() !== "commit") throw new OnboardError(`the confirmed commit ${c.commit} is gone from the mirror; confirm again: factoryctl onboard ${repo} --confirm`);
    const treeOfCommit = (rev: string): string => git(mirror, ["rev-parse", "--verify", "--end-of-options", `${rev}^{tree}`]).trim();
    if (treeOfCommit(c.commit) === treeOfCommit(c.base)) {
      d.out(`${repo} already has this footprint at ${c.base}: nothing to propose`);
      save({ ...r, state: "active", confirmed: landed(c) }, { step: "unchanged", commit: c.commit });
      return 0;
    }
    const pr = await propose({
      repo, mirror, remote: r.remote, branch: c.branch, commit: c.commit, baseBranch: r.default_branch, github, auth,
      title: c.branch.endsWith("/update") ? `Update the software factory's footprint to ${c.release.tag}` : `Onboard this repository to the software factory (${c.release.tag})`,
      body: [
        `The software factory's ${c.branch.endsWith("/update") ? "updated " : ""}footprint for this repository (ROADMAP §2.7), from its profile as the operator confirmed it, pinned to release \`${c.release.tag}\` (\`${c.release.sha}\`).`,
        "",
        "- `.factory/policy.yaml` and `.factory/gates.yaml`: the approvers, protected and restricted paths, commands and gates.",
        "- `.github/workflows/factory-gates.yml` and `policy-check.yml`: the gates and the policy check, from the pinned release.",
        "- A marked block in `CODEOWNERS` and in `CLAUDE.md`, `.claude/rules/factory-invariants.md`, and the factory's plugin in `.claude/settings.json`.",
        "",
        "After it merges, `factoryctl onboard` applies the rulesets and checks the factory App's access. Offboarding takes out exactly this.",
      ].join("\n"),
      journal: (e) => {
        journal(d.home, repo, { by: d.operator, ...e }, d.now());
      },
      ...(d.probe === undefined ? {} : { probe: d.probe }),
    });
    save({ ...r, state: "proposed", pr: { number: pr.number, url: pr.url } }, { step: "proposed", number: pr.number });
    d.out(`opened ${pr.url}: review and merge it, then: factoryctl onboard ${repo}`);
    return 0;
  }

  async function awaitMerge(r: TargetRecord): Promise<number> {
    const github = need(d.github, NEED_TOKEN);
    if (r.pr === undefined) throw new OnboardError(`${repo} is proposed without a PR on record`);
    const pr = await github.pullRequest(repo, r.pr.number);
    if (pr.merged) return await finish(save({ ...r, state: "merged" }, { step: "merged", number: pr.number }));
    if (pr.state === "closed") {
      // Back where it was: a closed onboarding is a draft again; a closed update leaves the target
      // active on the change it replaced, with the layer's record a superset of what it holds.
      const c = r.confirmed;
      const back: TargetRecord = { schema_version: 1, repo: r.repo, remote: r.remote, default_branch: r.default_branch, state: r.active === undefined ? "drafted" : "active", created_at: r.created_at, updated_at: r.updated_at, ...(r.admission === undefined ? {} : { admission: r.admission }), ...(r.active === undefined || c === undefined ? {} : { confirmed: { ...(c.replaces ?? changeOf(c)), layer: c.layer }, active: r.active }) };
      save(back, { step: "closed", number: pr.number });
      d.out(`${r.pr.url} was closed without merging: ${r.active === undefined ? `factoryctl onboard ${repo} --confirm proposes it again` : "the target stays as it was"}`);
      return 1;
    }
    d.out(`waiting for ${r.pr.url} to merge`);
    return 0;
  }

  async function finish(r: TargetRecord): Promise<number> {
    const token = need(d.token, NEED_TOKEN);
    const github = need(d.github, NEED_TOKEN);
    const app = need(d.app, NEED_APP);
    const c = r.confirmed;
    if (c === undefined) throw new OnboardError(`${repo} has nothing confirmed`);
    // The default branch must hold what the PR carried: the factory's files as written, its blocks and its settings.
    const mirror = syncMirror(d.home.mirrors, repo, r.remote, auth);
    const head = treeOf(mirror, resolveCommit(mirror, `refs/heads/${r.default_branch}`));
    const proposed = treeOf(mirror, c.commit);
    const missing = [
      ...c.layer.created.filter((p) => !c.layer.blocks.includes(p) && p !== ".claude/settings.json" && head.read(p) !== proposed.read(p)),
      ...c.layer.blocks.filter((p) => !hasBlock(head.read(p) ?? "", p)),
      ...(c.layer.settings.length > 0 && head.read(".claude/settings.json") === null ? [".claude/settings.json"] : []),
    ];
    if (missing.length > 0) {
      d.out(`${r.default_branch} does not hold the footprint as proposed (${missing.join(", ")}): merge ${r.pr?.url ?? "the PR"} as it is, then run this again`);
      return 1;
    }
    const gates = (await github.checkRunsOn(repo, c.commit)).find((x) => x.name === "gates" && x.appId === GITHUB_ACTIONS_APP_ID);
    if (gates?.conclusion !== "success") {
      d.out(`the target's own gates have not passed on ${c.commit} (${gates === undefined ? "no gates run from GitHub Actions" : `gates: ${gates.status}/${gates.conclusion ?? "pending"}`}): the footprint's gates must run green before the rulesets require them`);
      return 1;
    }
    if (!(await governed(token, app))) return 1;
    const active = save({ ...r, state: "active", confirmed: landed(c), active: { at: d.now().toISOString(), rulesets: [...RULESET_NAMES] } }, { step: "active" });
    report(active);
    return 0;
  }

  async function verify(r: TargetRecord): Promise<number> {
    const ok = await governed(need(d.token, NEED_TOKEN), need(d.app, NEED_APP));
    report(r);
    return ok ? 0 : 1;
  }

  /** The rulesets as the release has them (applied again only where they differ), and the App's access. */
  async function governed(token: string, app: AppConfig): Promise<boolean> {
    const expected = footprintRulesets();
    const before = await Promise.all(expected.map((e) => rulesetCheck({ repo, expected: e, token, api: d.api })));
    const drifted = expected.filter((_, i) => before[i]?.status === "fail");
    if (drifted.length > 0) {
      for (const line of await applyRulesets({ repo, token, api: d.api, rulesets: drifted })) d.out(line);
      journal(d.home, repo, { by: d.operator, step: "rulesets", applied: drifted.map((x) => x.name) }, d.now());
    }
    const rulesets = drifted.length === 0 ? before : await Promise.all(expected.map((e) => rulesetCheck({ repo, expected: e, token, api: d.api })));
    for (const x of rulesets) d.out(`${x.status.padEnd(4)}  ${x.name}: ${x.detail}`);
    if (rulesets.some((x) => x.status !== "ok")) return false;
    const access = await appAccess({ app, api: d.api, repo });
    if (!access.installed) {
      d.out(`${access.detail}. Add it: ${installationSettings(app)} → Repository access → Only select repositories → add ${repo.split("/")[1] ?? repo} → Save; then: factoryctl onboard ${repo}`);
      return false;
    }
    d.out(access.detail);
    return true;
  }

  /** The change once it is on the target: what it replaced no longer matters. */
  function landed(c: Confirmed): Confirmed {
    return { ...changeOf(c), layer: c.layer };
  }

  function report(r: TargetRecord): void {
    d.out(`${repo} is ${r.state}: release ${r.confirmed?.release.tag ?? "?"}, PR ${r.pr?.url ?? "none"}, rulesets ${(r.active?.rulesets ?? []).join(", ") || "none"}`);
  }
}
