// `factoryctl offboard OWNER/NAME` (ROADMAP P2-11, ADR 0003): the factory lets go of a target, in
// an order that takes its access away first.
//
//   stop      the target takes no new task (it is offboarding); refused while a task of it is unfinished
//   app       the operator removed the repository from the App's installation; a narrowed mint checks it
//   rulesets  the footprint's rulesets are deleted: before the PR, which deletes the gates workflow they require
//   change    a PR from software-factory/offboard deletes the footprint and takes the layer out; done once
//             it merged and the default branch holds nothing of the factory's
//   purge     every task of the target by a purge journal, in the home and the replica, with its mirror,
//             its gate cache volume and its place in the calibration; then the private store's directory
//
// Each step is recorded in target.json under `offboard` once done, and never done twice; a run
// stops where a person acts (the App, the merge) and can be repeated at any point, a crashed one
// included. A repository that is gone or out of reach takes --local-only --reason: the GitHub
// steps are skipped, and the record says why. The report ends with a scan of the home and the
// replica for anything of the target's that is left.
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cacheVolumeFor } from "../../../gates/src/run.ts";
import { calibrate, completedRuns } from "../budget/budget.ts";
import { pendingJournals, planPurge, runJournal, tasksOfTarget, type PurgeOutcome } from "../durable/purge.ts";
import { readReplicaConfig } from "../durable/replica.ts";
import { scanRecords, scanTree, type Hit, type Needle, type Scanned } from "../gate/canary.ts";
import { git, mirrorPath, resolveCommit, syncMirror, type GitAuth } from "../git/repo.ts";
import type { AppConfig } from "../github/app.ts";
import type { GitHub } from "../github/client.ts";
import { RULESET_NAMES } from "../governance/footprint.ts";
import { runDir, sessionDir, worktreeDir, type Home } from "../home.ts";
import type { Release } from "../release.ts";
import type { Validator } from "../schemas/validate.ts";
import { EventStore, type FactoryEvent } from "../store/events.ts";
import { currentState, isTerminal } from "../task/lifecycle.ts";
import { taskRecord } from "../task/task.ts";
import { writeAtomic } from "../fsutil.ts";
import { ADMISSION_TASK } from "./admission.ts";
import { buildCommit, propose } from "./change.ts";
import { appAccess, installationSettings, removeRulesets } from "./github.ts";
import { treeOf } from "./inventory.ts";
import { removeLayer } from "./layer.ts";
import { journal, readTarget, targetDir, targetSlug, writeTarget, type Offboard, type TargetRecord } from "./registry.ts";

export class OffboardError extends Error {}

export interface OffboardDeps {
  home: Home;
  store: EventStore;
  validator: Validator;
  release: Release;
  token: string | null;
  api: string;
  app: AppConfig | null;
  github: GitHub | null;
  operator: string;
  now: () => Date;
  /** What runs now, or null when no writer, session, runner or gate container is live. */
  busy: () => string | null;
  /** The container engine, which holds the target's gate cache volume. */
  engine: (args: string[]) => { status: number | null; stderr: string };
  out: (line: string) => void;
  log: (line: string) => void;
  probe?: (point: string) => void;
}

export interface OffboardOptions {
  /** The repository is gone or out of reach: skip the GitHub steps. Needs a reason. */
  localOnly?: boolean;
  /** The App cannot be asked (suspended, or deleted): skip its check. Needs a reason. */
  appUnavailable?: boolean;
  reason?: string;
}

const BRANCH = "software-factory/offboard";
const NEED_TOKEN = "FACTORY_GITHUB_TOKEN is needed: the operator's token, with Contents, Workflows, Pull requests and Administration: write on the target";

const need = <T>(v: T | null, what: string): T => {
  if (v === null) throw new OffboardError(what);
  return v;
};

/** Where a hit is the operator's own record, kept on purpose: gate evidence and drill records. */
const KEPT = /^home\/(gates|drills)\//;
/** The release's own files, never a target's data: not scanned. */
const RELEASE = new Set(["releases", "current", "bin"]);
/** A title shorter than this is too likely to occur by chance. */
const MIN_TITLE = 8;

export async function offboard(repo: string, o: OffboardOptions, d: OffboardDeps): Promise<number> {
  if ((o.localOnly === true || o.appUnavailable === true) && (o.reason ?? "").trim() === "") throw new OffboardError("--local-only and --app-unavailable need --reason \"…\"");
  const found = readTarget(d.home, repo, d.validator);
  if (found === null) {
    d.out(`${repo} is not registered: nothing to offboard`);
    return 0;
  }
  let record: TargetRecord = found;
  const auth: GitAuth | null = d.token === null ? null : { token: d.token };
  const at = (): string => d.now().toISOString();
  const save = (r: TargetRecord, off: Offboard, step: Record<string, unknown>): TargetRecord => {
    const next: TargetRecord = { ...r, state: "offboarding", offboard: off, updated_at: at() };
    writeTarget(d.home, next, d.validator);
    journal(d.home, repo, { by: d.operator, ...step }, d.now());
    return next;
  };

  if (record.state !== "offboarding") {
    // Nothing new from here on; nothing half-done left behind.
    const open = tasksOfTarget(d.home, d.store, repo).tasks.filter((id) => !isTerminal(currentState(d.store.events(id))));
    if (open.length > 0) throw new OffboardError(`${repo} has unfinished tasks (${open.join(", ")}): cancel them (factoryctl cancel ID) or let them finish, then offboard again`);
    // An onboarding PR still open would put the footprint in after offboarding took it out. A repository that is gone has none.
    if (o.localOnly !== true && (record.state === "confirmed" || record.state === "proposed") && record.pr !== undefined && d.github !== null) {
      const pr = await d.github.pullRequest(repo, record.pr.number);
      if (pr.state === "open") throw new OffboardError(`${record.pr.url} is still open: close it first; offboarding takes out only what merged`);
    }
    record = save(record, { at: at(), by: d.operator, local_only: o.localOnly === true, ...(o.reason === undefined ? {} : { reason: o.reason }) }, { step: "offboard", from: record.state });
    d.out(`${repo} is offboarding: it takes no new task`);
  } else if (o.localOnly === true && record.offboard?.local_only !== true) {
    record = save(record, { ...(record.offboard ?? { at: at(), by: d.operator }), local_only: true, reason: o.reason ?? "" }, { step: "local_only", reason: o.reason });
  }
  let off: Offboard = record.offboard ?? { at: at(), by: d.operator, local_only: o.localOnly === true };

  if (!off.local_only) {
    if (off.app === undefined) {
      const detail = await appGone();
      if (detail === null) return 1;
      off = { ...off, app: { at: at(), detail } };
      record = save(record, off, { step: "app", detail });
    }
    if (off.rulesets === undefined) {
      const removed = await removeRulesets({ repo, token: need(d.token, NEED_TOKEN), api: d.api, names: RULESET_NAMES });
      for (const line of removed) d.out(line);
      off = { ...off, rulesets: { at: at(), removed } };
      record = save(record, off, { step: "rulesets", removed: removed.length });
    }
    if (off.cleaned === undefined) {
      const code = await takeOut();
      if (code !== null) return code;
    }
  }
  return purge();

  /** The App's access, checked; null after printing the step when the App still reaches the repository. */
  async function appGone(): Promise<string | null> {
    if (o.appUnavailable === true) return `not checked: ${o.reason ?? ""}`;
    const app = need(d.app, "the factory App is not set: if it was removed, run again with --app-unavailable --reason \"…\"");
    let access;
    try {
      access = await appAccess({ app, api: d.api, repo });
    } catch (e) {
      throw new OffboardError(`${e instanceof Error ? e.message : String(e)}: if the App is suspended or gone, run again with --app-unavailable --reason "…"`);
    }
    if (!access.installed) return access.detail;
    d.out(`${access.detail}. Remove it: ${installationSettings(app)} → Repository access → Only select repositories → remove ${repo.split("/")[1] ?? repo} → Save; then: factoryctl offboard ${repo}`);
    return null;
  }

  /** What of the factory's the default branch still holds: the layer's record taken out of its files. */
  function leftOn(mirror: string, base: string): Record<string, string | null> {
    const layer = record.confirmed?.layer;
    if (layer === undefined) return {};
    const tree = treeOf(mirror, base);
    return Object.fromEntries(Object.entries(removeLayer(layer, (p) => tree.read(p))).filter(([p, content]) => content !== tree.read(p)));
  }

  /** The offboarding PR: proposed, waited for, and checked once merged; null once the default branch is clean. */
  async function takeOut(): Promise<number | null> {
    const r = record;
    const github = need(d.github, NEED_TOKEN);
    const mirror = syncMirror(d.home.mirrors, repo, r.remote, auth);
    const head = resolveCommit(mirror, `refs/heads/${r.default_branch}`);
    let change = off.change;
    if (change === undefined) {
      const files = leftOn(mirror, head);
      if (Object.keys(files).length === 0) {
        off = { ...off, cleaned: { at: at(), detail: `${r.default_branch} holds nothing of the factory's` } };
        record = save(r, off, { step: "cleaned", pr: null });
        return null;
      }
      const commit = buildCommit(mirror, head, files, "Remove the software factory's footprint", at());
      change = { branch: BRANCH, base: head, commit, files: Object.keys(files).sort() };
      off = { ...off, change };
      record = save(r, off, { step: "change", commit, files: change.files });
    }
    if (off.pr === undefined) {
      if (git(mirror, ["cat-file", "-t", change.commit], { allowFail: true }).trim() !== "commit") {
        // The mirror lost it (a fresh clone): build the change again.
        off = dropKeys(off, ["change"]);
        record = save(r, off, { step: "change_lost", commit: change.commit });
        return takeOut();
      }
      const pr = await propose({
        repo, mirror, remote: r.remote, branch: change.branch, commit: change.commit, baseBranch: r.default_branch, github, auth,
        title: "Offboard this repository from the software factory",
        body: [
          "The software factory is letting go of this repository (ROADMAP P2-11). This takes out exactly what its onboarding put in:",
          "",
          ...change.files.map((f) => `- \`${f}\``),
          "",
          "Its rulesets are already removed, and the factory App no longer reaches the repository. After this merges, `factoryctl offboard` purges the factory's own records of it.",
        ].join("\n"),
        journal: (e) => {
          journal(d.home, repo, { by: d.operator, ...e }, d.now());
        },
        ...(d.probe === undefined ? {} : { probe: d.probe }),
      });
      off = { ...off, pr: { number: pr.number, url: pr.url } };
      record = save(r, off, { step: "proposed", number: pr.number });
      d.out(`opened ${pr.url}: review and merge it, then: factoryctl offboard ${repo}`);
      return 0;
    }
    const pr = await github.pullRequest(repo, off.pr.number);
    if (!pr.merged) {
      if (pr.state === "closed") {
        off = dropKeys(off, ["change", "pr"]);
        record = save(r, off, { step: "closed", number: pr.number });
        d.out(`${pr.url} was closed without merging: factoryctl offboard ${repo} proposes it again`);
        return 1;
      }
      d.out(`waiting for ${pr.url} to merge`);
      return 0;
    }
    const left = Object.keys(leftOn(mirror, head));
    if (left.length > 0) {
      // Merged, yet the default branch holds the factory's files again (someone put them back): propose taking them out anew.
      off = dropKeys(off, ["change", "pr"]);
      record = save(r, off, { step: "left", files: left });
      d.out(`${r.default_branch} still holds ${left.join(", ")}: factoryctl offboard ${repo} proposes taking them out`);
      return 1;
    }
    off = { ...off, cleaned: { at: at(), detail: `${pr.url} merged; ${r.default_branch} holds nothing of the factory's` } };
    record = save(r, off, { step: "cleaned", number: pr.number });
    return null;
  }

  /** The tier budgets as the P1-01 rule sets them from the events in the store now. */
  function budgets(): Record<string, number> {
    const byTask = new Map<string, FactoryEvent[]>();
    for (const e of d.store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
    return Object.fromEntries(Object.values(calibrate(d.release.budgets, completedRuns(byTask))).map((t) => [t.tier, t.budget]));
  }

  function purge(): number {
    const r = record;
    const busy = d.busy();
    if (busy !== null) throw new OffboardError(`the purge runs only while the factory is idle; now: ${busy}`);
    const replica = readReplicaConfig(d.home);
    if (replica !== null && !existsSync(replica.path)) throw new OffboardError(`the replica ${replica.path} is not reachable: mount it, then offboard again; the purge must reach both stores`);
    let p = off.purge;
    if (p === undefined) {
      const { tasks, unknown } = tasksOfTarget(d.home, d.store, repo);
      if (unknown.length > 0) throw new OffboardError(`the target of ${unknown.join(", ")} cannot be told from the record: the purge waits until it can`);
      const titles = tasks.flatMap((id) => {
        const title = taskRecord(d.home, d.store, id)?.title;
        return title === undefined ? [] : [title];
      });
      const before = budgets();
      const paths = [mirrorPath(d.home.mirrors, repo), join(d.home.worktrees, `${ADMISSION_TASK}-${targetSlug(repo)}`)];
      const j = planPurge(d.home, d.store, tasks, { by: d.operator, reason: `offboard ${repo}`, now: d.now(), paths });
      p = { at: at(), journal: j.id, tasks, titles, budgets_before: before };
      off = { ...off, purge: p };
      record = save(r, off, { step: "purge", journal: j.id, tasks: tasks.length });
    }
    d.probe?.("planned");
    const pending = pendingJournals(d.home).find((j) => j.id === p.journal);
    const outcome: PurgeOutcome | null = pending === undefined ? null : runJournal(d.home, d.store, pending, { log: d.log, probe: (s) => d.probe?.(`purge:${s}`) });
    // The target's packages, in the gates' cache volume.
    const volume = cacheVolumeFor(repo);
    const rm = d.engine(["volume", "rm", "--force", volume]);
    if (rm.status !== 0) throw new OffboardError(`the container engine did not remove ${volume}: ${rm.stderr.trim() || "no answer"}; start it, then offboard again`);
    // The calibration (P1-01), from the events that remain: the purged runs no longer count.
    const after = budgets();
    const calibration = join(d.home.root, "budgets", "calibration.json");
    if (existsSync(calibration)) {
      const recorded = JSON.parse(readFileSync(calibration, "utf8")) as Record<string, unknown> & { months?: { target: string }[] };
      const byTask = new Map<string, FactoryEvent[]>();
      for (const e of d.store.allEvents()) byTask.set(e.task_id, [...(byTask.get(e.task_id) ?? []), e]);
      const runs = completedRuns(byTask);
      writeAtomic(calibration, `${JSON.stringify({ ...recorded, computed_at: at(), tiers: calibrate(d.release.budgets, runs), runs: runs.length, months: (recorded.months ?? []).filter((m) => m.target !== repo) }, null, 2)}\n`);
    }
    d.probe?.("calibrated");
    // The private store's directory goes last: from the replica, then from the home.
    if (replica !== null) rmSync(join(replica.path, "targets", targetSlug(repo)), { recursive: true, force: true });
    const dir = targetDir(d.home, repo);
    const remote = r.remote;
    rmSync(dir, { recursive: true, force: true });
    return report(p, outcome, after, replica?.path ?? null, remote);
  }

  /** What was purged and what is left: the structure of both stores, then a scan for the target's names and its tasks' titles. */
  function report(p: NonNullable<Offboard["purge"]>, outcome: PurgeOutcome | null, after: Record<string, number>, replica: string | null, remote: string): number {
    const problems: string[] = [];
    const tombstoned = new Set(d.store.tombstones().map((t) => t.task_id));
    for (const id of p.tasks) {
      if (d.store.events(id).length > 0 || !tombstoned.has(id)) problems.push(`${id}: events left, or no tombstone, in the home's store`);
      for (const path of [runDir(d.home, id), worktreeDir(d.home, id), sessionDir(d.home, id)]) if (existsSync(path)) problems.push(`${path} is left`);
    }
    if (existsSync(mirrorPath(d.home.mirrors, repo))) problems.push(`the mirror ${mirrorPath(d.home.mirrors, repo)} is left`);
    const records: { where: string; text: string }[] = d.store.allEvents().map((e) => ({ where: `events/${e.task_id}#${String(e.seq)}`, text: JSON.stringify(e) }));
    if (replica !== null) {
      const store = EventStore.open(join(replica, "factory.db"));
      try {
        const gone = new Set(store.tombstones().map((t) => t.task_id));
        for (const id of p.tasks) if (store.events(id).length > 0 || !gone.has(id)) problems.push(`${id}: events left, or no tombstone, in the replica`);
      } finally {
        store.close();
      }
    }
    const needles: Needle[] = [
      { name: "the repository's name", value: Buffer.from(repo) },
      { name: "its directory name", value: Buffer.from(targetSlug(repo)) },
      ...(remote.includes(repo) ? [] : [{ name: "its remote", value: Buffer.from(remote) }]),
      ...p.titles.filter((t) => t.length >= MIN_TITLE).map((t) => ({ name: "a purged task's title", value: Buffer.from(t) })),
    ];
    const home = scanHome(d.home.root, needles);
    const rep = replica === null ? null : scanTree(replica, "replica", needles);
    const hits: Hit[] = [...home.hits, ...(rep?.hits ?? []), ...scanRecords(records, needles)];
    const kept = hits.filter((h) => KEPT.test(h.where));
    const leftover = hits.filter((h) => !KEPT.test(h.where));
    const before = p.budgets_before;
    d.out(`offboarded ${repo}: ${String(p.tasks.length)} task(s) purged${p.tasks.length === 0 ? "" : ` (${p.tasks.join(", ")})`}${outcome === null ? "" : `; ${String(outcome.events)} event(s), ${String(outcome.objects)} object(s), ${String(outcome.paths)} path(s), ${String(outcome.otel)} telemetry export(s)`}; ${cacheVolumeFor(repo)} removed`);
    d.out(`tier budgets, before → after: ${Object.keys(after).map((t) => `${t} $${(before[t] ?? 0).toFixed(2)} → $${(after[t] ?? 0).toFixed(2)}${before[t] === after[t] ? "" : " (changed)"}`).join(", ")}`);
    d.out(`scanned ${String(home.files + (rep?.files ?? 0))} file(s) in the home${rep === null ? "" : " and the replica"} and ${String(records.length)} event(s): ${String(leftover.length)} hit(s)${kept.length === 0 ? "" : `; ${String(kept.length)} in your own records, kept: ${[...new Set(kept.map((h) => h.where))].join(", ")}`}`);
    for (const h of leftover) d.out(`left: ${h.needle} in ${h.where}`);
    for (const x of problems) d.out(`left: ${x}`);
    return leftover.length + problems.length === 0 ? 0 : 1;
  }
}

/** The home, but for the release's own files. */
function scanHome(root: string, needles: readonly Needle[]): Scanned {
  const total: Scanned = { files: 0, bytes: 0, bundles: 0, hits: [] };
  for (const name of readdirSync(root)) {
    if (RELEASE.has(name)) continue;
    const path = join(root, name);
    const st = lstatSync(path);
    if (st.isDirectory()) {
      const s = scanTree(path, `home/${name}`, needles);
      total.files += s.files;
      total.bytes += s.bytes;
      total.bundles += s.bundles;
      total.hits.push(...s.hits);
    } else if (st.isFile()) {
      const raw = readFileSync(path);
      total.files++;
      total.bytes += raw.length;
      total.hits.push(...needles.filter((n) => raw.includes(n.value)).map((n) => ({ needle: n.name, where: `home/${name}` })));
    }
  }
  return total;
}

/** The record without these steps: a change or a PR that has to be made again. */
function dropKeys(off: Offboard, keys: readonly ("change" | "pr")[]): Offboard {
  return Object.fromEntries(Object.entries(off).filter(([k]) => !(keys as readonly string[]).includes(k))) as unknown as Offboard;
}
