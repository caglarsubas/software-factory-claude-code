// GitHub intake (ROADMAP P2-04): an open issue carrying a target's intake label becomes a task
// when one of the profile's intake maintainers put the label on it. Polling is the source of
// truth: each poll reads every labelled issue and decides afresh.
//
//   - The latest application of the label decides who admitted the issue. A label from anyone
//     else is ignored, and the factory writes nothing to the issue.
//   - The task is the issue as it was when it was labelled: its text is snapshotted, and is always
//     untrusted. An issue whose body or title changed after the label is held until a maintainer
//     labels it again, so a text no maintainer has looked at never becomes a task.
//   - One admission per label event. A re-label while the issue's earlier task is still live
//     waits for that task to end.
//
// The admitted issue gets one status comment, which each run of its task edits (mirror.ts).
import type { IntakeIssue, GitHub } from "../github/client.ts";
import { createOutbox } from "../github/outbox.ts";
import type { Home } from "../home.ts";
import type { Validator } from "../schemas/validate.ts";
import type { EventStore } from "../store/events.ts";
import { currentState, isTerminal } from "../task/lifecycle.ts";
import { createTask, type IssueSource, type Profile } from "../task/task.ts";
import { issueOf, mirrorIssue } from "./mirror.ts";

export type IntakeDecision =
  | { kind: "admit"; labeledBy: string; labeledAt: string }
  | { kind: "ignored"; reason: string }
  | { kind: "held"; reason: string };

const after = (a: string, b: string): boolean => Date.parse(a) > Date.parse(b);

/** What intake does with one labelled issue, from its label and edit history alone. */
export function decide(issue: IntakeIssue, intake: NonNullable<Profile["intake"]>): IntakeDecision {
  const labelled = issue.events.filter((e) => e.kind === "labeled" && e.label === intake.label).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = labelled.at(-1);
  if (last === undefined) return { kind: "ignored", reason: `no record of who applied ${intake.label}` };
  if (last.actor === null || !intake.maintainers.includes(last.actor)) return { kind: "ignored", reason: `labelled by ${last.actor ?? "a deleted account"}, who is not an intake maintainer` };
  if (issue.lastEditedAt !== null && after(issue.lastEditedAt, last.at)) return { kind: "held", reason: "its body was edited after it was labelled; a maintainer labels it again to admit the edit" };
  if (issue.events.some((e) => e.kind === "renamed" && after(e.at, last.at))) return { kind: "held", reason: "its title was changed after it was labelled; a maintainer labels it again to admit the change" };
  return { kind: "admit", labeledBy: last.actor, labeledAt: last.at };
}

export interface IntakeTarget {
  profilePath: string;
  profile: Profile;
}

export interface IntakeOutcome {
  repo: string;
  number: number;
  outcome: "admitted" | "known" | "waiting" | "ignored" | "held";
  task?: string;
  reason?: string;
}

/** Every task intake admitted, by issue and label event. */
function admittedTasks(store: EventStore): { task: string; issue: IssueSource }[] {
  return store.taskIds().flatMap((task) => {
    const issue = issueOf(store.events(task));
    return issue === null ? [] : [{ task, issue }];
  });
}

const TITLE_LIMIT = 200;

/** One poll of every target's labelled issues: admits what may enter and says why the rest do not. */
export async function pollIntake(o: { home: Home; store: EventStore; validator: Validator; github: (repo: string) => Promise<GitHub>; targets: IntakeTarget[]; log: (line: string) => void; now?: () => Date }): Promise<IntakeOutcome[]> {
  const outcomes: IntakeOutcome[] = [];
  for (const t of o.targets) {
    const intake = t.profile.intake;
    const repo = t.profile.target.repo;
    if (intake === undefined) throw new Error(`${t.profilePath} has no intake: block (label and maintainers)`);
    const gh = await o.github(repo);
    for (const issue of await gh.intakeIssues(repo, intake.label)) {
      const d = decide(issue, intake);
      if (d.kind !== "admit") {
        outcomes.push({ repo, number: issue.number, outcome: d.kind, reason: d.reason });
        continue;
      }
      const earlier = admittedTasks(o.store).filter((a) => a.issue.repo === repo && a.issue.number === issue.number);
      const same = earlier.find((a) => a.issue.labeled_at === d.labeledAt);
      if (same !== undefined) {
        outcomes.push({ repo, number: issue.number, outcome: "known", task: same.task });
        continue;
      }
      const live = earlier.find((a) => !isTerminal(currentState(o.store.events(a.task))));
      if (live !== undefined) {
        outcomes.push({ repo, number: issue.number, outcome: "waiting", task: live.task, reason: `${live.task}, from an earlier label, has not ended` });
        continue;
      }
      const source: IssueSource = { repo, number: issue.number, url: issue.url, labeled_by: d.labeledBy, labeled_at: d.labeledAt };
      const title = issue.title.trim().slice(0, TITLE_LIMIT) || `Issue ${String(issue.number)}`;
      const task = createTask(o.home, o.store, o.validator, { profilePath: t.profilePath, title, body: issue.body.trim() === "" ? "(empty issue body)" : issue.body, trust: "untrusted", admittedBy: d.labeledBy, issue: source, ...(o.now === undefined ? {} : { now: o.now() }) });
      outcomes.push({ repo, number: issue.number, outcome: "admitted", task: task.id });
      // The issue hears that it was admitted: the first version of its status comment. A failure leaves the task, and its next run posts it.
      try {
        await mirrorIssue({ store: o.store, taskId: task.id, outbox: createOutbox({ store: o.store, taskId: task.id, github: gh, auth: null, log: o.log }) });
      } catch (e) {
        o.log(`${task.id}: could not comment on ${repo}#${String(issue.number)}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return outcomes;
}
