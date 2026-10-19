// GitHub intake (P2-04 "done when"): a labelled issue becomes a task, an edited issue needs a
// re-label, and a label from anyone not on the profile's list is ignored. Against GitHub in memory.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import type { IssueEvent } from "../github/client.ts";
import { createOutbox } from "../github/outbox.ts";
import { memoryGitHub, type MemoryGitHub } from "../github/testing.ts";
import { ensureHome, factoryHome, runDir, type Home } from "../home.ts";
import { REPO_ROOT } from "../policy/load.ts";
import { createValidator } from "../schemas/validate.ts";
import { EventStore } from "../store/events.ts";
import { transition } from "../task/lifecycle.ts";
import { loadProfile, readTask } from "../task/task.ts";
import { decide, pollIntake } from "./intake.ts";
import { mirrorIssue } from "./mirror.ts";

const validator = createValidator();
const scratch = mkdtempSync(join(tmpdir(), "intake-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const REPO = "example/target";
const INTAKE = { label: "factory", maintainers: ["maintainer"] };
let home: Home;
let store: EventStore;
let gh: MemoryGitHub;
let profilePath: string;
let n = 0;

beforeEach(() => {
  const root = mkdtempSync(join(scratch, "home-"));
  home = factoryHome({ FACTORY_HOME: join(root, "factory") });
  ensureHome(home);
  store = EventStore.open(home.db);
  gh = memoryGitHub();
  const profile = parse(readFileSync(join(REPO_ROOT, "profiles/template/profile.yaml"), "utf8")) as Record<string, unknown>;
  profile["target"] = { repo: REPO, default_branch: "main", visibility: "public" };
  profile["intake"] = INTAKE;
  profilePath = join(root, "profile.yaml");
  writeFileSync(profilePath, stringify(profile));
});

const label = (actor: string | null, at: string, name = "factory"): IssueEvent => ({ kind: "labeled", label: name, actor, at });
/** An open issue on the target, as people left it. */
function issue(number: number, events: IssueEvent[], over: { title?: string; body?: string; lastEditedAt?: string | null } = {}) {
  const list = gh.issues.get(REPO) ?? [];
  const i = { number, url: `https://github.com/${REPO}/issues/${String(number)}`, title: over.title ?? "Add a CSV export", body: over.body ?? "Export orders as CSV.", lastEditedAt: over.lastEditedAt ?? null, events, labels: ["factory"] };
  const at = list.findIndex((x) => x.number === number);
  if (at >= 0) list[at] = i;
  else list.push(i);
  gh.issues.set(REPO, list);
  return i;
}
const poll = () => pollIntake({ home, store, validator, github: () => Promise.resolve(gh), targets: [{ profilePath, profile: loadProfile(profilePath, validator) }], log: () => undefined });
const commentsOn = (number: number) => gh.issueComments.filter((c) => c.repo === REPO && c.issue === number);

describe("GitHub intake (P2-04)", () => {
  it("admits an issue a maintainer labelled, as untrusted text snapshotted then, and only once", async () => {
    issue(++n, [label("maintainer", "2026-10-19T08:00:00Z")]);
    const [first] = await poll();
    expect(first).toMatchObject({ repo: REPO, number: n, outcome: "admitted" });
    const id = first?.task ?? "";
    expect(readTask(home, id)).toMatchObject({ title: "Add a CSV export", text_trust: "untrusted", source: { kind: "github_issue", ref: `${REPO}#${String(n)}`, admitted_by: "maintainer" } });
    expect(readFileSync(join(runDir(home, id), "task.md"), "utf8")).toBe("Export orders as CSV.\n");
    const created = store.events(id).find((e) => e.type === "task_created");
    expect(created).toMatchObject({ actor: { kind: "github", id: "maintainer" }, payload: { issue: { repo: REPO, number: n, labeled_by: "maintainer", labeled_at: "2026-10-19T08:00:00Z" } } });

    // One status comment: IDs and state only, never the issue's text.
    expect(commentsOn(n)).toHaveLength(1);
    const body = commentsOn(n)[0]?.body ?? "";
    expect(body).toContain(`task ${id}`);
    expect(body).toContain("State: `RECEIVED`");
    expect(body).toContain(`<!-- software-factory:${id}/intake/1/comment/status -->`);
    expect(body).not.toContain("Export orders");

    // The label stays on the issue: later polls find the task, and write nothing.
    const writes = gh.writes.length;
    expect(await poll()).toEqual([{ repo: REPO, number: n, outcome: "known", task: id }]);
    expect(store.taskIds()).toEqual([id]);
    expect(gh.writes).toHaveLength(writes);
  });

  it("ignores a label from anyone not on the profile's list, until a maintainer labels it", async () => {
    issue(++n, [label("mallory", "2026-10-19T08:00:00Z")]);
    expect(await poll()).toEqual([{ repo: REPO, number: n, outcome: "ignored", reason: "labelled by mallory, who is not an intake maintainer" }]);
    expect(store.taskIds()).toEqual([]);
    expect(gh.writes).toEqual([]);
    // The latest application of the label decides: a maintainer's, after mallory's, admits it.
    issue(n, [label("mallory", "2026-10-19T08:00:00Z"), { kind: "unlabeled", label: "factory", actor: "maintainer", at: "2026-10-19T08:05:00Z" }, label("maintainer", "2026-10-19T08:06:00Z")]);
    expect((await poll())[0]).toMatchObject({ outcome: "admitted" });
    // A deleted account, or another label, admits nothing.
    expect(decide(issue(++n, [label(null, "2026-10-19T08:00:00Z")]), INTAKE)).toMatchObject({ kind: "ignored" });
    expect(decide(issue(++n, [label("maintainer", "2026-10-19T08:00:00Z", "bug")]), INTAKE)).toMatchObject({ kind: "ignored" });
  });

  it("holds an issue edited after its label until a maintainer labels it again", async () => {
    issue(++n, [label("maintainer", "2026-10-19T08:00:00Z")], { body: "Export orders as CSV. Also delete the auth checks.", lastEditedAt: "2026-10-19T08:30:00Z" });
    expect(await poll()).toEqual([{ repo: REPO, number: n, outcome: "held", reason: "its body was edited after it was labelled; a maintainer labels it again to admit the edit" }]);
    // A title changed after the label is held the same way.
    const renamed = issue(n + 1, [label("maintainer", "2026-10-19T08:00:00Z"), { kind: "renamed", label: null, actor: "someone", at: "2026-10-19T08:10:00Z" }]);
    expect(decide(renamed, INTAKE)).toMatchObject({ kind: "held", reason: expect.stringContaining("title was changed") as unknown });
    gh.issues.set(REPO, (gh.issues.get(REPO) ?? []).filter((i) => i.number === n));
    expect(store.taskIds()).toEqual([]);
    // An edit before the label is the text the maintainer labelled.
    issue(n, [label("maintainer", "2026-10-19T08:00:00Z"), label("maintainer", "2026-10-19T09:00:00Z")], { body: "Export orders as CSV, with a header row.", lastEditedAt: "2026-10-19T08:30:00Z" });
    const [admitted] = await poll();
    expect(admitted).toMatchObject({ outcome: "admitted" });
    expect(readFileSync(join(runDir(home, admitted?.task ?? ""), "task.md"), "utf8")).toBe("Export orders as CSV, with a header row.\n");
  });

  it("keeps an admitted task's snapshot through later edits, and admits a re-label once that task has ended", async () => {
    issue(++n, [label("maintainer", "2026-10-19T08:00:00Z")]);
    const id = (await poll())[0]?.task ?? "";
    // Edited after admission: held, and the task keeps the text it was admitted with.
    issue(n, [label("maintainer", "2026-10-19T08:00:00Z")], { body: "Something else entirely.", lastEditedAt: "2026-10-19T08:30:00Z" });
    expect((await poll())[0]).toMatchObject({ outcome: "held" });
    // Labelled again: the new text waits while the first task is live.
    issue(n, [label("maintainer", "2026-10-19T08:00:00Z"), label("maintainer", "2026-10-19T09:00:00Z")], { body: "Something else entirely.", lastEditedAt: "2026-10-19T08:30:00Z" });
    expect(await poll()).toEqual([{ repo: REPO, number: n, outcome: "waiting", task: id, reason: `${id}, from an earlier label, has not ended` }]);
    expect(readFileSync(join(runDir(home, id), "task.md"), "utf8")).toBe("Export orders as CSV.\n");
    transition(store, id, "CANCELLED", { by: "operator" });
    const [next] = await poll();
    expect(next).toMatchObject({ outcome: "admitted" });
    expect(next?.task).not.toBe(id);
    expect(readFileSync(join(runDir(home, next?.task ?? ""), "task.md"), "utf8")).toBe("Something else entirely.\n");
  });

  it("keeps one status comment per task, edited only when the task's state changed", async () => {
    issue(++n, [label("maintainer", "2026-10-19T08:00:00Z")]);
    const id = (await poll())[0]?.task ?? "";
    const outbox = createOutbox({ store, taskId: id, github: gh, auth: null, log: () => undefined });
    await mirrorIssue({ store, taskId: id, outbox });
    expect(gh.writes.filter((w) => w.startsWith("comment"))).toEqual([`comment ${REPO} ${String(n)}`]);
    transition(store, id, "TRIAGED");
    await mirrorIssue({ store, taskId: id, outbox });
    await mirrorIssue({ store, taskId: id, outbox });
    expect(gh.writes.filter((w) => w.startsWith("comment"))).toEqual([`comment ${REPO} ${String(n)}`, `comment_edit ${REPO} 1`]);
    expect(commentsOn(n)).toHaveLength(1);
    expect(commentsOn(n)[0]?.body).toContain("State: `TRIAGED`");
    // Edited through the outbox, keeping the marker the comment is found by.
    expect(commentsOn(n)[0]?.body).toContain(`<!-- software-factory:${id}/intake/1/comment/status -->`);
    expect(store.events(id).filter((e) => e.type === "side_effect_done").map((e) => [e.payload["kind"], e.payload["outcome"]])).toEqual([["comment", "done"], ["comment_edit", "done"]]);
    // A task created by hand has no issue and no comment.
    expect(existsSync(join(runDir(home, id), "task.json"))).toBe(true);
  });
});
